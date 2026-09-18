import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

interface FixCandidate {
  warning_id: string;
  spatial: unknown;
  evidence_trail: unknown;
  confidence_score: number;
}

function sqlLiteral(value: unknown): string {
  return JSON.stringify(value).replace(/'/g, "''");
}

function main(): void {
  const input = resolve(process.cwd(), 'recon', 'review-fix.json');
  const output = resolve(process.cwd(), 'recon', 'review-fix.sql');
  if (!existsSync(input)) {
    console.error(`Input file not found: ${input}`);
    process.exit(1);
  }
  const candidates = JSON.parse(readFileSync(input, 'utf8')) as FixCandidate[];

  const statements = candidates.map((c) => {
    const spatial = sqlLiteral(c.spatial);
    const evidence = sqlLiteral(c.evidence_trail);
    const confidence = c.confidence_score;
    return [
      `UPDATE public.nav_warnings`,
      `SET risk_level='NORMAL', spatial='${spatial}'::jsonb, evidence_trail='${evidence}'::jsonb, confidence_score=${confidence}, extraction_method='deterministic', updated_at=now()`,
      `WHERE source_id='hydrobharat-gov-in' AND warning_id='${c.warning_id.replace(/'/g, "''")}';`,
    ].join('\n');
  });

  writeFileSync(output, statements.length > 0 ? statements.join('\n') + '\n' : '', 'utf8');
  console.log(`review-fix statements: ${statements.length}`);
  console.log(`Wrote ${output}`);
}

main();