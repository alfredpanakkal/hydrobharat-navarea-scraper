import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { CoordinateParser } from './utils/coordinateParser';

const SOURCE_ID = 'hydrobharat-gov-in';

interface SpatialRow {
  id: string;
  warning_id: string;
  raw_text: string | null;
  spatial: unknown[] | null;
  extraction_method: string | null;
}

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`Missing env var: ${key}`);
    process.exit(1);
  }
  return v;
}

function normalize(items: unknown[]): unknown[] {
  return items.map((item) => {
    const it = item as {
      type?: string;
      radius_nm?: number;
      coords?: Array<{ lat?: number; lon?: number }>;
    };
    const out: Record<string, unknown> = { type: it.type ?? null };
    if (it.radius_nm !== undefined && it.radius_nm !== null) {
      out.radius_nm = it.radius_nm;
    }
    out.coords = (it.coords ?? []).map((c) => ({
      lat: Number(c.lat),
      lon: Number(c.lon),
    }));
    return out;
  });
}

function sameSpatial(a: unknown[], b: unknown[]): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

async function main(): Promise<void> {
  const dryRun =
    process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true';
  const supabaseUrl = requireEnv('SUPABASE_URL');
  const supabaseKey = requireEnv('SUPABASE_KEY');
  const db: SupabaseClient = createClient(supabaseUrl, supabaseKey);
  const parser = new CoordinateParser();

  const { data, error } = await db
    .from('nav_warnings')
    .select('id, warning_id, raw_text, spatial, extraction_method')
    .eq('source_id', SOURCE_ID)
    .order('warning_id', { ascending: true });

  if (error) {
    console.error(`[Backfill] select failed: ${error.message}`);
    process.exit(1);
  }

  const rows = (data ?? []) as SpatialRow[];
  let updated = 0;
  let unchanged = 0;
  let keptExisting = 0;
  let skippedLLM = 0;
  let noText = 0;

  for (const row of rows) {
    if (row.extraction_method === 'llm_assisted') {
      skippedLLM++;
      continue;
    }
    if (!row.raw_text) {
      noText++;
      continue;
    }

    const existing = row.spatial ?? [];
    const next = parser.parseMulti(row.raw_text).geometries;

    if (next.length === 0) {
      if (existing.length > 0) keptExisting++;
      else unchanged++;
      continue;
    }
    if (sameSpatial(next, existing)) {
      unchanged++;
      continue;
    }

    if (dryRun) {
      console.log(
        `[Backfill] ${row.warning_id}: ${existing.length} -> ${next.length} geometries`
      );
      updated++;
      continue;
    }

    const { error: updateError } = await db
      .from('nav_warnings')
      .update({ spatial: next })
      .eq('id', row.id);
    if (updateError) {
      console.error(
        `[Backfill] update failed for ${row.warning_id}: ${updateError.message}`
      );
      continue;
    }
    updated++;
    if (updated % 10 === 0) {
      console.log(`[Backfill] ${updated} row(s) updated`);
    }
  }

  const action = dryRun ? 'would change' : 'updated';
  console.log(
    `[Backfill] ${rows.length} row(s) scanned (${SOURCE_ID}) — ` +
      `${updated} ${action}, ${unchanged} unchanged, ${keptExisting} kept ` +
      `(parser empty, existing preserved), ${skippedLLM} llm_assisted skipped, ` +
      `${noText} without raw_text${dryRun ? ' — DRY RUN, no writes' : ''}`
  );
}

main().catch((err) => {
  console.error('[Backfill] FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
