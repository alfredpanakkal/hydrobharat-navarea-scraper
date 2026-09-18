import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { CONFIG } from '../config';

interface ExistingRow {
  checksum: string;
  revision: number;
}

interface UpsertData {
  warning_id: string;
  title?: string;
  raw_text: string;
  checksum: string;
  geometries?: any[];
  spatial_groups?: any[];
  evidence_trail?: any[];
  extraction_method?: string;
  confidence_score?: number;
  risk_level?: string;
  is_cancelled?: boolean;
  cancellation_text?: string | null;
  valid_until_utc?: Date | null;
}

interface RunStats {
  started_at: Date;
  finished_at: Date;
  rows_scraped: number;
  rows_upserted: number;
  llm_calls: number;
  status: string;
  error_text?: string;
}

export class DatabaseService {
  private client: SupabaseClient;

  constructor() {
    this.client = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);
  }

  async getExisting(warningIds: string[]): Promise<Map<string, ExistingRow>> {
    if (warningIds.length === 0) return new Map();

    const { data, error } = await this.client
      .from('nav_warnings')
      .select('warning_id, checksum, revision')
      .in('warning_id', warningIds);

    if (error) throw new Error(`getExisting failed: ${error.message}`);

    const map = new Map<string, ExistingRow>();
    for (const row of data ?? []) {
      map.set(row.warning_id, { checksum: row.checksum, revision: row.revision });
    }
    return map;
  }

  async upsertWarning(data: UpsertData, existing?: ExistingRow): Promise<void> {
    const revision = existing ? existing.revision + 1 : 1;
    const previous_checksum = existing?.checksum ?? null;

    const { error } = await this.client.from('nav_warnings').upsert(
      {
        warning_id: data.warning_id,
        source_id: CONFIG.SOURCE_ID,
        title: data.title,
        raw_text: data.raw_text,
        checksum: data.checksum,
        revision,
        previous_checksum,
        spatial: data.geometries ?? [],
        spatial_groups: data.spatial_groups ?? [],
        evidence_trail: data.evidence_trail ?? [],
        extraction_method: data.extraction_method,
        risk_level: data.risk_level ?? 'NORMAL',
        is_cancelled: data.is_cancelled ?? false,
        cancellation_text: data.cancellation_text,
        valid_until_utc: data.valid_until_utc,
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'source_id,warning_id' }
    );

    if (error) throw new Error(`upsertWarning failed: ${error.message}`);

    // Archive old version if amended
    if (existing && existing.checksum !== data.checksum) {
      await this.client.from('raw_messages').insert({
        warning_id: data.warning_id,
        source_id: CONFIG.SOURCE_ID,
        full_raw_text: data.raw_text,
        checksum_sha256: existing.checksum,
      });
    }
  }

  async touch(warningId: string): Promise<void> {
    const { error } = await this.client
      .from('nav_warnings')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('warning_id', warningId)
      .eq('source_id', CONFIG.SOURCE_ID);

    if (error) throw new Error(`touch failed: ${error.message}`);
  }

  async markMissingAsCancelled(seenIds: string[]): Promise<void> {
    const { error } = await this.client
      .from('nav_warnings')
      .update({ is_cancelled: true, updated_at: new Date().toISOString() })
      .eq('source_id', CONFIG.SOURCE_ID)
      .eq('is_cancelled', false)
      .not('warning_id', 'in', `(${seenIds.join(',')})`);

    if (error) throw new Error(`markMissingAsCancelled failed: ${error.message}`);
  }

  async logRun(stats: RunStats): Promise<void> {
    const { error } = await this.client.from('scraper_runs').insert({
      source_id: CONFIG.SOURCE_ID,
      started_at: stats.started_at.toISOString(),
      finished_at: stats.finished_at.toISOString(),
      rows_scraped: stats.rows_scraped,
      rows_upserted: stats.rows_upserted,
      llm_calls: stats.llm_calls,
      status: stats.status,
      error_text: stats.error_text,
    });

    if (error) console.error('logRun failed:', error.message);
  }
}
