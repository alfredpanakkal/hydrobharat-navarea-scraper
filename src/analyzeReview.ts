import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { CoordinateParser } from './utils/coordinateParser';

interface ReviewRow {
  warning_id: string;
  raw_text?: string;
}

interface OutCoordDetail {
  lat: number;
  lon: number;
  rule: string;
  match: string;
  correctedLat: number;
  correctedLon: number;
  correctedInBounds: boolean;
  context: string;
}

interface RowAnalysis {
  warning_id: string;
  got_coords: boolean;
  risk_level: string;
  in_bounds: boolean;
  coords_in: number;
  coords_out: number;
  matched_rules: string[];
  cause: 'format-misparse' | 'legit-out-of-area' | 'false-positive' | 'other';
  out_coords: OutCoordDetail[];
}

const NAVAREA_BOUNDS = { latMin: -10, latMax: 30, lonMin: 30, lonMax: 100 };
const COORD_RULES = new Set([
  'hyphenated-deg-min',
  'space-deg-min',
  'concat-deg-min',
  'dms',
  'labeled',
  'decimal-degrees',
]);

function isWithinBounds(lat: number, lon: number): boolean {
  return (
    lat >= NAVAREA_BOUNDS.latMin &&
    lat <= NAVAREA_BOUNDS.latMax &&
    lon >= NAVAREA_BOUNDS.lonMin &&
    lon <= NAVAREA_BOUNDS.lonMax
  );
}

function isValidCoord(lat: number, lon: number): boolean {
  return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function correctedCoords(rule: string, match: string): { lat: number; lon: number } | null {
  if (rule === 'hyphenated-deg-min') {
    const m = match.match(
      /^(\d{1,2})-\s*(\d{1,2}(?:\.\d+)?)\s*([NS])\s+(\d{1,3})-\s*(\d{1,2}(?:\.\d+)?)\s*([EW])$/i
    );
    if (!m) return null;
    return {
      lat: (parseFloat(m[1]) + parseFloat(m[2]) / 60) * (m[3].toUpperCase() === 'S' ? -1 : 1),
      lon: (parseFloat(m[4]) + parseFloat(m[5]) / 60) * (m[6].toUpperCase() === 'W' ? -1 : 1),
    };
  }
  if (rule === 'space-deg-min') {
    const m = match.match(
      /^(\d{1,2})\s+(\d{1,2}(?:\.\d+)?)\s*([NS])\s+(\d{1,3})\s+(\d{1,2}(?:\.\d+)?)\s*([EW])$/i
    );
    if (!m) return null;
    return {
      lat: (parseFloat(m[1]) + parseFloat(m[2]) / 60) * (m[3].toUpperCase() === 'S' ? -1 : 1),
      lon: (parseFloat(m[4]) + parseFloat(m[5]) / 60) * (m[6].toUpperCase() === 'W' ? -1 : 1),
    };
  }
  return null;
}

function contextAround(text: string, matchStr: string, radius = 60): string {
  const idx = text.indexOf(matchStr);
  if (idx < 0) return '';
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + matchStr.length + radius);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

function main(): void {
  const inputPath = resolve(process.cwd(), 'recon', 'review-rows.json');
  if (!existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath} (run from repo root)`);
    process.exit(1);
  }
  const rows = JSON.parse(readFileSync(inputPath, 'utf8')) as ReviewRow[];
  const parser = new CoordinateParser();
  const analyses: RowAnalysis[] = [];

  for (const row of rows) {
    const text = row.raw_text ?? '';
    const parsed = parser.parse(text);
    const evidenceCoords = parsed.evidence_trail.filter((e) => COORD_RULES.has(e.rule));
    const flat = parsed.geometries.flatMap((g) => g.coords);
    let pts = [...flat];
    const polygon = parsed.geometries.find((g) => g.type === 'polygon');
    if (
      polygon &&
      flat.length === evidenceCoords.length + 1 &&
      flat[0].lat === flat[flat.length - 1].lat &&
      flat[0].lon === flat[flat.length - 1].lon
    ) {
      pts = flat.slice(0, -1);
    }
    const inCoords = pts.filter((c) => isWithinBounds(c.lat, c.lon)).length;
    const outEntries: Array<{ lat: number; lon: number; rule: string; match: string }> = [];

    pts.forEach((c, i) => {
      if (!isWithinBounds(c.lat, c.lon)) {
        outEntries.push({
          lat: c.lat,
          lon: c.lon,
          rule: evidenceCoords[i] ? evidenceCoords[i].rule : '?',
          match: evidenceCoords[i] ? evidenceCoords[i].match : '',
        });
      }
    });

    const outDetails: OutCoordDetail[] = outEntries.map((o) => {
      const corrected = correctedCoords(o.rule, o.match) ?? { lat: o.lat, lon: o.lon };
      return {
        lat: o.lat,
        lon: o.lon,
        rule: o.rule,
        match: o.match,
        correctedLat: corrected.lat,
        correctedLon: corrected.lon,
        correctedInBounds: isValidCoord(corrected.lat, corrected.lon) && isWithinBounds(corrected.lat, corrected.lon),
        context: contextAround(text, o.match),
      };
    });

    const anyCorrectedInBounds = outDetails.some((o) => o.correctedInBounds);
    const anyCorrectedInvalid = outDetails.some((o) => !isValidCoord(o.correctedLat, o.correctedLon));
    const rowWouldBeNormal = pts.every((c) => isWithinBounds(c.lat, c.lon));

    let cause: RowAnalysis['cause'];
    if (!rowWouldBeNormal) {
      cause = 'legit-out-of-area';
    } else if (anyCorrectedInBounds) {
      cause = 'format-misparse';
    } else if (anyCorrectedInvalid) {
      cause = 'false-positive';
    } else {
      cause = 'other';
    }

    analyses.push({
      warning_id: row.warning_id,
      got_coords: parsed.geometries.length > 0,
      risk_level: parsed.risk_level,
      in_bounds: rowWouldBeNormal,
      coords_in: inCoords,
      coords_out: outEntries.length,
      matched_rules: [...new Set(parsed.evidence_trail.map((e) => e.rule))],
      cause,
      out_coords: outDetails,
    });
  }

  const total = analyses.length;
  const byCause: Record<string, number> = {};
  for (const a of analyses) {
    const key = a.cause;
    byCause[key] = (byCause[key] ?? 0) + 1;
  }
  const noCoords = analyses.filter((a) => !a.got_coords).length;
  const currentlyNormal = analyses.filter((a) => a.in_bounds).length;

  const summary = {
    total_rows: total,
    rows_with_coords: total - noCoords,
    rows_without_coords: noCoords,
    rows_currently_in_bounds: currentlyNormal,
    rows_review: analyses.filter((a) => a.risk_level === 'REVIEW').length,
    cause_distribution: byCause,
  };

  console.log('=== ANALYZE REVIEW REPORT ===');
  console.log(JSON.stringify(summary, null, 2));
  console.log('');
  for (const cause of Object.keys(byCause).sort()) {
    const examples = analyses.filter((a) => a.cause === cause).slice(0, 3);
    console.log(`--- cause: ${cause} (${byCause[cause]})`);
    for (const ex of examples) {
      const o = ex.out_coords[0];
      if (o) {
        console.log(
          `  ${ex.warning_id}  parsed(${o.lat.toFixed(3)},${o.lon.toFixed(3)}) corrected(${o.correctedLat.toFixed(3)},${o.correctedLon.toFixed(3)}) rule=${o.rule} match="${o.match}" ctx="${o.context}"`
        );
      } else {
        console.log(`  ${ex.warning_id}  no out-of-bounds coords`);
      }
    }
  }

  const reportPath = resolve(process.cwd(), 'recon', 'review-report.json');
  writeFileSync(reportPath, JSON.stringify({ summary, rows: analyses }, null, 2), 'utf8');
  console.log('');
  console.log(`Wrote full detail to ${reportPath} (${analyses.length} rows)`);
}

main();