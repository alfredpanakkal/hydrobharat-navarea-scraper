import { createClient } from '@supabase/supabase-js';

const DAYS = 30;

function fail(message: string): never {
  console.error(`cleanup: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const missing = ['SUPABASE_URL', 'SUPABASE_KEY'].filter((k) => !process.env[k]);
  if (missing.length > 0) {
    fail(`missing env var(s): ${missing.join(', ')}. Set them before running.`);
  }

  const { CONFIG } = await import('./config.js');
  const execute = process.argv.includes('--execute');
  const client = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

  const { data, error } = await client.rpc('archive_old_hydrobharat_warnings', {
    p_days: DAYS,
    p_dry: !execute,
  });
  if (error) fail(`rpc archive_old_hydrobharat_warnings failed: ${error.message}`);
  const count = Number(data ?? 0);

  if (execute) {
    console.log(`cleanup: moved ${count} stale hydrobharat warning(s) to nav_warnings_archive`);
    return;
  }

  const cutoff = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: candidates, error: listError } = await client
    .from('nav_warnings')
    .select('warning_id, last_seen_at')
    .eq('source_id', CONFIG.SOURCE_ID)
    .lt('last_seen_at', cutoff)
    .order('last_seen_at')
    .limit(20);
  if (listError) fail(`candidate query failed: ${listError.message}`);

  console.log(`cleanup (dry run): ${count} stale warning(s) would be archived (last seen before ${cutoff})`);
  for (const row of candidates ?? []) {
    console.log(`  ${row.warning_id}  ${row.last_seen_at}`);
  }
  const shown = candidates?.length ?? 0;
  if (count > shown) console.log(`  ... and ${count - shown} more`);
}

main().catch((err) => {
  console.error(`cleanup: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});