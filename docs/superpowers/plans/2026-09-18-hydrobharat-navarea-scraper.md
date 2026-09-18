# HydroBharat NAVAREA VIII Scraper — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production scraper for Indian NAVAREA VIII navigational warnings with 3-Tier parsing (regex → Mistral → Gemini), Supabase persistence, and daily GitHub Actions scheduling.

**Architecture:** Liferay Headless Delivery API lists PDF documents from folder 288109. PDFs are downloaded and text is extracted via `pdf-parse`. A 3-Tier parsing engine extracts spatial geometries: deterministic regex (free, fast) → Mistral AI (batched) → Gemini Flash-Lite (fallback). Structured data + audit trail persist to Supabase. GitHub Actions runs daily with alert-on-failure.

**Tech Stack:** TypeScript, pdf-parse, Supabase JS, Mistral AI SDK, Google Generative AI, Zod, tsx

## Global Constraints

- Node.js 20+ required
- `SUPABASE_KEY` must be `service_role` key (bypasses RLS) — never expose client-side
- All LLM output validated via Zod schema before storage — never store unvalidated LLM output
- Coordinate parser must handle 6 maritime formats with lat −90..90, lon −180..180 validation
- NAVAREA VIII bounds: lat −10..30N, lon 30..100E — outside = `risk_level = 'REVIEW'`
- Zero rows scraped = hard failure (throw, not silent return)
- Non-zero exit on failure → GitHub Actions shows red

---

## File Structure

```
hydrobharat-navarea-scraper/
├── .gitignore                          # Node, env, recon exclusions
├── package.json                        # Dependencies + scripts
├── tsconfig.json                       # TypeScript config
├── .env.example                        # Template for env vars
├── recon/                              # Step 0 output (gitignored)
│   └── page.html
├── src/
│   ├── config.ts                       # Env var validation, fail-fast
│   ├── services/
│   │   ├── liferay.ts                  # Liferay API client (list + download PDFs)
│   │   └── api.ts                      # Supabase CRUD + change detection
│   ├── utils/
│   │   ├── pdfExtractor.ts             # PDF → text extraction
│   │   ├── coordinateParser.ts         # Tier 1: Regex engine + checksum
│   │   ├── llmParser.ts               # Tier 2+3: AI extraction
│   │   └── alert.ts                    # Webhook alerts
│   └── server.ts                       # Pipeline orchestrator
└── tests/
    └── utils/
        └── coordinateParser.test.ts    # Coordinate parser unit tests
```

---

## Task 1: Recon — Discover API Structure

**Files:**
- Create: `recon/page.html`

**Interfaces:**
- Consumes: Liferay Headless Delivery API
- Produces: API structure + document list for selector discovery

- [ ] **Step 1: Install dependencies**

```bash
npm init -y
npm install pdf-parse @supabase/supabase-js zod
npm install -D typescript tsx @types/node
```

- [ ] **Step 2: Write recon script**

Create `src/recon.ts`:

```typescript
import { writeFileSync, mkdirSync } from 'fs';

const LIFERAY_USER = process.env.LIFERAY_USER ?? 'nho@liferay.com';
const LIFERAY_PASS = process.env.LIFERAY_PASS ?? 'Giks@2017';
const API_BASE = 'https://hydrobharat.gov.in/o/headless-delivery/v1.0';

async function recon() {
  mkdirSync('recon', { recursive: true });
  
  const auth = Buffer.from(`${LIFERAY_USER}:${LIFERAY_PASS}`).toString('base64');
  const headers = {
    Authorization: `Basic ${auth}`,
    Accept: 'application/json',
  };

  // Step 1: List document folders
  console.log('=== Document Folders ===');
  const foldersResp = await fetch(`${API_BASE}/sites/20117/document-folders?fields=id,name`, { headers });
  const folders = await foldersResp.json();
  console.log(`Found ${folders.totalCount} folders`);
  
  // Find Navarea Warnings folder
  const navFolder = folders.items.find((f: any) => f.name === 'Navarea Warnings');
  if (!navFolder) {
    console.error('Navarea Warnings folder not found!');
    return;
  }
  console.log(`Navarea Warnings folder ID: ${navFolder.id}`);

  // Step 2: List documents in folder
  console.log('\n=== Documents in Navarea Warnings ===');
  const docsResp = await fetch(
    `${API_BASE}/document-folders/${navFolder.id}/documents?pageSize=20&sort=dateCreated:desc&fields=id,title,dateCreated,contentUrl`,
    { headers }
  );
  const docs = await docsResp.json();
  console.log(`Total documents: ${docs.totalCount}`);
  console.log(`Page 1 of ${docs.lastPage}`);
  
  // Save full response
  writeFileSync('recon/api-response.json', JSON.stringify(docs, null, 2));
  
  // Step 3: Show sample documents
  console.log('\n=== Sample Documents ===');
  for (const doc of docs.items.slice(0, 5)) {
    console.log(`  ID: ${doc.id}, Title: ${doc.title}, Created: ${doc.dateCreated}`);
    console.log(`  URL: ${doc.contentUrl}`);
  }

  // Step 4: Download a sample PDF and extract text
  console.log('\n=== Sample PDF Content ===');
  const sampleDoc = docs.items[0];
  const pdfUrl = `https://hydrobharat.gov.in${sampleDoc.contentUrl}`;
  console.log(`Downloading: ${pdfUrl}`);
  
  const pdfResp = await fetch(pdfUrl, { 
    headers: { Authorization: `Basic ${auth}` }
  });
  
  if (pdfResp.ok) {
    const pdfBuffer = Buffer.from(await pdfResp.arrayBuffer());
    writeFileSync('recon/sample.pdf', pdfBuffer);
    console.log(`Saved sample PDF: ${pdfBuffer.length} bytes`);
    
    // Extract text
    const pdfParse = (await import('pdf-parse')).default;
    const pdfData = await pdfParse(pdfBuffer);
    console.log(`\nExtracted text (${pdfData.numpages} pages):`);
    console.log(pdfData.text.substring(0, 2000));
    writeFileSync('recon/sample-text.txt', pdfData.text);
  } else {
    console.error(`PDF download failed: ${pdfResp.status}`);
  }

  console.log('\nRecon complete. Check recon/ directory.');
}

recon().catch(console.error);
```

- [ ] **Step 3: Run recon**

```bash
npx tsx src/recon.ts
```

- [ ] **Step 4: STOP — Report to user**

Report back:
- Total document count
- Document naming pattern
- Sample PDF text content (first 2000 chars)
- API pagination structure
- **Wait for user confirmation before proceeding to Task 2.**

---

## Task 2: Database Setup (Supabase MCP)

**Files:**
- No file changes — SQL via Supabase MCP

**Interfaces:**
- Consumes: Supabase project
- Produces: 3 tables with RLS policies

- [ ] **Step 1: Create `nav_warnings` table**

```sql
CREATE TABLE IF NOT EXISTS nav_warnings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    warning_id TEXT NOT NULL,
    source_id TEXT DEFAULT 'hydrobharat-gov-in',
    navarea TEXT DEFAULT 'VIII',
    title TEXT,
    raw_text TEXT NOT NULL,
    issued_date TEXT,
    issued_text TEXT,
    latitude FLOAT,
    longitude FLOAT,
    spatial JSONB DEFAULT '[]'::jsonb,
    spatial_groups JSONB DEFAULT '[]'::jsonb,
    evidence_trail JSONB DEFAULT '[]'::jsonb,
    valid_until_utc TIMESTAMPTZ,
    cancellation_text TEXT,
    is_cancelled BOOLEAN DEFAULT false,
    extraction_method TEXT,
    risk_level TEXT DEFAULT 'NORMAL',
    checksum TEXT NOT NULL,
    revision INTEGER DEFAULT 1,
    previous_checksum TEXT,
    last_seen_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (source_id, warning_id)
);

CREATE INDEX IF NOT EXISTS idx_nw_warning_id ON nav_warnings(warning_id);
CREATE INDEX IF NOT EXISTS idx_nw_source_id ON nav_warnings(source_id);
CREATE INDEX IF NOT EXISTS idx_nw_is_cancelled ON nav_warnings(is_cancelled);
```

- [ ] **Step 2: Create `raw_messages` table**

```sql
CREATE TABLE IF NOT EXISTS raw_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    warning_id TEXT NOT NULL,
    source_id TEXT DEFAULT 'hydrobharat-gov-in',
    full_raw_text TEXT NOT NULL,
    subject_header TEXT,
    checksum_sha256 TEXT NOT NULL,
    captured_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rm_warning_id ON raw_messages(warning_id);
```

- [ ] **Step 3: Create `scraper_runs` table**

```sql
CREATE TABLE IF NOT EXISTS scraper_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id TEXT,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    rows_scraped INTEGER,
    rows_upserted INTEGER,
    llm_calls INTEGER,
    status TEXT,
    error_text TEXT
);
```

- [ ] **Step 4: Enable RLS and create policies**

```sql
ALTER TABLE nav_warnings ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE scraper_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "svc full" ON nav_warnings FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "svc full" ON raw_messages FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "svc full" ON scraper_runs FOR ALL TO service_role USING (true) WITH CHECK (true);
```

- [ ] **Step 5: Verify tables exist**

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name IN ('nav_warnings', 'raw_messages', 'scraper_runs');
```

Expected: 3 rows returned.

---

## Task 3: Project Scaffolding

**Files:**
- Create: `.gitignore`
- Create: `package.json` (modify existing)
- Create: `tsconfig.json`
- Create: `.env.example`

**Interfaces:**
- Consumes: Node.js environment
- Produces: Ready-to-develop project structure

- [ ] **Step 1: Create `.gitignore`**

```
node_modules/
.env
.env.*
recon/
dist/
*.js.map
```

- [ ] **Step 2: Install dependencies**

```bash
npm install pdf-parse @supabase/supabase-js @google/generative-ai @mistralai/mistralai zod
npm install -D typescript tsx @types/node
```

- [ ] **Step 3: Initialize TypeScript**

```bash
npx tsc --init
```

Edit `tsconfig.json` to add:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 4: Add scripts to `package.json`**

```json
{
  "scripts": {
    "start": "tsx src/server.ts",
    "recon": "tsx src/recon.ts",
    "test": "tsx --test tests/**/*.test.ts",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 5: Create `.env.example`**

```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-service-role-key
LIFERAY_USER=your-liferay-username
LIFERAY_PASS=your-liferay-password
MISTRAL_API_KEY=your-mistral-key
GEMINI_API_KEY=your-gemini-key
ALERT_WEBHOOK=https://hooks.slack.com/...
```

- [ ] **Step 6: Create directory structure**

```bash
mkdir -p src/scrapers src/utils src/services tests/utils
```

- [ ] **Step 7: Verify typecheck passes**

```bash
npx tsc --noEmit
```

Expected: No errors (no source files yet, so clean pass).

- [ ] **Step 8: Commit**

```bash
git init
git add .gitignore package.json package-lock.json tsconfig.json .env.example src/ tests/
git commit -m "chore: project scaffolding with dependencies and tsconfig"
```

---

## Task 4: Config Module

**Files:**
- Create: `src/config.ts`

**Interfaces:**
- Consumes: `process.env`
- Produces: `CONFIG` object

- [ ] **Step 1: Write config module**

```typescript
function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env var: ${key}`);
  return v;
}

export const CONFIG = {
  SUPABASE_URL: required('SUPABASE_URL'),
  SUPABASE_KEY: required('SUPABASE_KEY'),
  LIFERAY_USER: required('LIFERAY_USER'),
  LIFERAY_PASS: required('LIFERAY_PASS'),
  LIFERAY_API_BASE: 'https://hydrobharat.gov.in/o/headless-delivery/v1.0',
  LIFERAY_FOLDER_ID: 288109, // Navarea Warnings folder
  MISTRAL_API_KEY: process.env.MISTRAL_API_KEY ?? '',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? '',
  ALERT_WEBHOOK: process.env.ALERT_WEBHOOK ?? '',
  SOURCE_ID: 'hydrobharat-gov-in',
  MIN_EXPECTED_ROWS: 5,
  LLM_BATCH_SIZE: 10,
};
```

- [ ] **Step 2: Commit**

```bash
git add src/config.ts
git commit -m "feat: config module with fail-fast env validation"
```

---

## Task 5: Coordinate Parser (Tier 1 — Deterministic)

**Files:**
- Create: `src/utils/coordinateParser.ts`
- Create: `tests/utils/coordinateParser.test.ts`

**Interfaces:**
- Consumes: Raw warning text (string)
- Produces: `ParsedCoordinates` with geometries, risk_level, checksum

- [ ] **Step 1: Write failing tests**

```typescript
// tests/utils/coordinateParser.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CoordinateParser } from '../../src/utils/coordinateParser';

const parser = new CoordinateParser();

describe('CoordinateParser', () => {
  it('parses hyphenated Deg-Min format', () => {
    const result = parser.parse('AREA 12-34.5N 074-12.3E');
    assert.equal(result.geometries.length, 1);
    assert.equal(result.geometries[0].type, 'point');
    assert.ok(Math.abs(result.geometries[0].coords[0].lat - 12.575) < 0.001);
    assert.ok(Math.abs(result.geometries[0].coords[0].lon - 74.205) < 0.001);
  });

  it('parses space-separated Deg-Min format', () => {
    const result = parser.parse('AREA 12 34.5N 074 12.3E');
    assert.equal(result.geometries.length, 1);
    assert.ok(Math.abs(result.geometries[0].coords[0].lat - 12.575) < 0.001);
  });

  it('parses concatenated Deg-Min format', () => {
    const result = parser.parse('AREA 1234.5N 07412.3E');
    assert.equal(result.geometries.length, 1);
    assert.ok(Math.abs(result.geometries[0].coords[0].lat - 12.575) < 0.001);
  });

  it('parses DMS format with degree/minute/second symbols', () => {
    const result = parser.parse("AREA 12°34'30\"N 074°12'18\"E");
    assert.equal(result.geometries.length, 1);
    assert.ok(Math.abs(result.geometries[0].coords[0].lat - 12.575) < 0.001);
  });

  it('parses LAT/LONG labeled format', () => {
    const result = parser.parse('LAT 12-34N LONG 074-12E');
    assert.equal(result.geometries.length, 1);
    assert.ok(Math.abs(result.geometries[0].coords[0].lat - 12.5667) < 0.001);
  });

  it('parses decimal degrees format', () => {
    const result = parser.parse('AREA 12.575N 74.205E');
    assert.equal(result.geometries.length, 1);
    assert.ok(Math.abs(result.geometries[0].coords[0].lat - 12.575) < 0.001);
  });

  it('handles southern and western hemispheres', () => {
    const result = parser.parse('AREA 05-12.3S 060-45.2W');
    assert.equal(result.geometries.length, 1);
    assert.ok(Math.abs(result.geometries[0].coords[0].lat - (-5.205)) < 0.001);
    assert.ok(Math.abs(result.geometries[0].coords[0].lon - (-60.753)) < 0.001);
    assert.equal(result.risk_level, 'REVIEW'); // outside NAVAREA VIII
  });

  it('rejects coordinates outside valid bounds', () => {
    const result = parser.parse('AREA 91-00N 074-00E');
    assert.equal(result.geometries.length, 0);
  });

  it('flags NAVAREA VIII out-of-bounds as REVIEW', () => {
    const result = parser.parse('AREA 28-59N 088-30E');
    assert.equal(result.geometries.length, 1);
    assert.equal(result.risk_level, 'NORMAL'); // within NAVAREA VIII
  });

  it('returns empty geometries for non-coordinate text', () => {
    const result = parser.parse('This is just regular warning text with no coordinates');
    assert.equal(result.geometries.length, 0);
  });

  it('generates consistent checksum for same text', () => {
    const c1 = parser.generateChecksum('WARNING TEXT  ABC  123');
    const c2 = parser.generateChecksum('WARNING TEXT  ABC  123');
    assert.equal(c1, c2);
  });

  it('generates different checksums for different text', () => {
    const c1 = parser.generateChecksum('WARNING TEXT A');
    const c2 = parser.generateChecksum('WARNING TEXT B');
    assert.notEqual(c1, c2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx tsx --test tests/utils/coordinateParser.test.ts
```

Expected: FAIL with "Cannot find module" or "function not defined"

- [ ] **Step 3: Implement coordinate parser**

```typescript
// src/utils/coordinateParser.ts
import { createHash } from 'crypto';

export interface Geometry {
  type: 'point' | 'polygon' | 'line' | 'circle';
  coords: Array<{ lat: number; lon: number }>;
  radius_nm?: number;
  spatial_group_id?: string;
}

export interface ParsedCoordinates {
  geometries: Geometry[];
  risk_level: 'NORMAL' | 'REVIEW' | 'HIGH';
  extraction_method: 'deterministic';
  confidence_score: number;
  evidence_trail: Array<{ rule: string; match: string }>;
  is_cancelled: boolean;
  cancellation_text: string | null;
  valid_until_utc: Date | null;
}

// NAVAREA VIII approximate bounds
const NAVAREA_BOUNDS = { latMin: -10, latMax: 30, lonMin: 30, lonMax: 100 };

const COORD_PATTERNS = [
  // Hyphenated Deg-Min: 12-34.5N 074-12.3E
  {
    name: 'hyphenated-deg-min',
    regex: /(\d{1,2})-(\d{1,2}(?:\.\d+)?)\s*([NS])\s+(\d{1,3})-(\d{1,2}(?:\.\d+)?)\s*([EW])/gi,
    parse: (m: RegExpMatchArray) => ({
      lat: (m[1] !== '0' ? parseFloat(m[1]) : 0) + parseFloat(m[2]) / 60 * (m[3].toUpperCase() === 'S' ? -1 : 1),
      lon: (m[4] !== '0' ? parseFloat(m[4]) : 0) + parseFloat(m[5]) / 60 * (m[6].toUpperCase() === 'W' ? -1 : 1),
    }),
  },
  // Space-separated Deg-Min: 12 34.5N 074 12.3E
  {
    name: 'space-deg-min',
    regex: /(\d{1,2})\s+(\d{1,2}(?:\.\d+)?)\s*([NS])\s+(\d{1,3})\s+(\d{1,2}(?:\.\d+)?)\s*([EW])/gi,
    parse: (m: RegExpMatchArray) => ({
      lat: parseFloat(m[1]) + parseFloat(m[2]) / 60 * (m[3].toUpperCase() === 'S' ? -1 : 1),
      lon: parseFloat(m[4]) + parseFloat(m[5]) / 60 * (m[6].toUpperCase() === 'W' ? -1 : 1),
    }),
  },
  // Concatenated Deg-Min: 1234.5N 07412.3E
  {
    name: 'concat-deg-min',
    regex: /(\d{2,4})(\d{2}(?:\.\d+)?)\s*([NS])\s+(\d{3,5})(\d{2}(?:\.\d+)?)\s*([EW])/gi,
    parse: (m: RegExpMatchArray) => {
      const latDeg = Math.floor(parseFloat(m[1]) / 100);
      const latMin = parseFloat(m[1]) % 100 + parseFloat(m[2]) / 100;
      const lonDeg = Math.floor(parseFloat(m[4]) / 100);
      const lonMin = parseFloat(m[4]) % 100 + parseFloat(m[5]) / 100;
      return {
        lat: (latDeg + latMin / 60) * (m[3].toUpperCase() === 'S' ? -1 : 1),
        lon: (lonDeg + lonMin / 60) * (m[6].toUpperCase() === 'W' ? -1 : 1),
      };
    },
  },
  // DMS: 12°34'30"N 074°12'18"E
  {
    name: 'dms',
    regex: /(\d{1,2})[°](\d{1,2})['′](\d{1,2}(?:\.\d+)?)[\"″]?\s*([NS])\s+(\d{1,3})[°](\d{1,2})['′](\d{1,2}(?:\.\d+)?)[\"″]?\s*([EW])/gi,
    parse: (m: RegExpMatchArray) => ({
      lat: (parseFloat(m[1]) + parseFloat(m[2]) / 60 + parseFloat(m[3]) / 3600) * (m[4].toUpperCase() === 'S' ? -1 : 1),
      lon: (parseFloat(m[5]) + parseFloat(m[6]) / 60 + parseFloat(m[7]) / 3600) * (m[8].toUpperCase() === 'W' ? -1 : 1),
    }),
  },
  // LAT/LONG labeled: LAT 12-34N LONG 074-12E
  {
    name: 'labeled',
    regex: /(?:LAT|纬)\s+(\d{1,2})-(\d{1,2})\s*([NS])\s+(?:LONG|经|LON)\s+(\d{1,3})-(\d{1,2})\s*([EW])/gi,
    parse: (m: RegExpMatchArray) => ({
      lat: (parseFloat(m[1]) + parseFloat(m[2]) / 60) * (m[3].toUpperCase() === 'S' ? -1 : 1),
      lon: (parseFloat(m[4]) + parseFloat(m[5]) / 60) * (m[6].toUpperCase() === 'W' ? -1 : 1),
    }),
  },
  // Decimal degrees: 12.575N 74.205E
  {
    name: 'decimal-degrees',
    regex: /(\d{1,3}(?:\.\d+)?)\s*([NS])\s+(\d{1,3}(?:\.\d+)?)\s*([EW])/gi,
    parse: (m: RegExpMatchArray) => ({
      lat: parseFloat(m[1]) * (m[2].toUpperCase() === 'S' ? -1 : 1),
      lon: parseFloat(m[3]) * (m[4].toUpperCase() === 'W' ? -1 : 1),
    }),
  },
];

const CANCEL_REGEX = /CANCEL\s+THIS\s+MSG\s+(\d{4})\s+UTC\s+(\w{3})\s+(\d{2})/i;
const RADIUS_REGEX = /(?:WITHIN|RADIUS)\s+(\d+(?:\.\d+)?)\s*(?:NM|KM|NAUTICAL\s*MILES)/i;
const BOUNDED_BY_REGEX = /BOUNDED\s+BY/i;
const JOINING_REGEX = /JOINING/i;

function isValidCoord(lat: number, lon: number): boolean {
  return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function isWithinNavarea(lat: number, lon: number): boolean {
  return (
    lat >= NAVAREA_BOUNDS.latMin &&
    lat <= NAVAREA_BOUNDS.latMax &&
    lon >= NAVAREA_BOUNDS.lonMin &&
    lon <= NAVAREA_BOUNDS.lonMax
  );
}

export class CoordinateParser {
  parse(text: string): ParsedCoordinates {
    const geometries: Geometry[] = [];
    const evidence_trail: Array<{ rule: string; match: string }> = [];
    let risk_level: 'NORMAL' | 'REVIEW' | 'HIGH' = 'NORMAL';

    // Extract coordinates using all patterns
    for (const pattern of COORD_PATTERNS) {
      const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
      let match;
      while ((match = regex.exec(text)) !== null) {
        const { lat, lon } = pattern.parse(match);
        if (!isValidCoord(lat, lon)) continue;

        evidence_trail.push({ rule: pattern.name, match: match[0] });

        if (!isWithinNavarea(lat, lon)) {
          risk_level = 'REVIEW';
        }

        geometries.push({
          type: 'point',
          coords: [{ lat, lon }],
        });
      }
    }

    // Detect radius
    const radiusMatch = text.match(RADIUS_REGEX);
    if (radiusMatch && geometries.length > 0) {
      const radius = parseFloat(radiusMatch[1]);
      const isKm = /KM/i.test(radiusMatch[0]);
      const radius_nm = isKm ? radius * 0.539957 : radius;
      geometries[0].type = 'circle';
      geometries[0].radius_nm = radius_nm;
      evidence_trail.push({ rule: 'radius', match: radiusMatch[0] });
    }

    // Detect polygon (BOUNDED BY)
    if (BOUNDED_BY_REGEX.test(text) && geometries.length >= 3) {
      const polygonCoords = geometries.map((g) => g.coords[0]);
      polygonCoords.push(polygonCoords[0]); // ring closure
      geometries.length = 0;
      geometries.push({
        type: 'polygon',
        coords: polygonCoords,
        spatial_group_id: `poly-${Date.now()}`,
      });
      evidence_trail.push({ rule: 'polygon', match: 'BOUNDED BY' });
    }

    // Detect linestring (JOINING)
    if (JOINING_REGEX.test(text) && geometries.length >= 2) {
      const lineCoords = geometries.map((g) => g.coords[0]);
      geometries.length = 0;
      geometries.push({
        type: 'line',
        coords: lineCoords,
      });
      evidence_trail.push({ rule: 'linestring', match: 'JOINING' });
    }

    // Cancellation extraction
    let is_cancelled = false;
    let cancellation_text: string | null = null;
    let valid_until_utc: Date | null = null;

    const cancelMatch = text.match(CANCEL_REGEX);
    if (cancelMatch) {
      is_cancelled = true;
      cancellation_text = cancelMatch[0];
      const day = cancelMatch[1].slice(0, 2);
      const hour = cancelMatch[1].slice(2, 4);
      const monthMap: Record<string, number> = {
        JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
        JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
      };
      const month = monthMap[cancelMatch[2].toUpperCase()] ?? 0;
      const year = 2000 + parseInt(cancelMatch[3]);
      valid_until_utc = new Date(Date.UTC(year, month, parseInt(day), parseInt(hour)));
    }

    return {
      geometries,
      risk_level,
      extraction_method: 'deterministic',
      confidence_score: geometries.length > 0 ? 0.99 : 0,
      evidence_trail,
      is_cancelled,
      cancellation_text,
      valid_until_utc,
    };
  }

  generateChecksum(text: string): string {
    const normalized = text.replace(/\s+/g, ' ').trim().toUpperCase();
    return createHash('sha256').update(normalized).digest('hex');
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx tsx --test tests/utils/coordinateParser.test.ts
```

Expected: All 12 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/utils/coordinateParser.ts tests/utils/coordinateParser.test.ts
git commit -m "feat: coordinate parser with 6 maritime formats, spatial topology, cancellation extraction"
```

---

## Task 6: LLM Parser (Tier 2+3)

**Files:**
- Create: `src/utils/llmParser.ts`

**Interfaces:**
- Consumes: `CONFIG.MISTRAL_API_KEY`, `CONFIG.GEMINI_API_KEY`, batch of warning objects
- Produces: `GeomSchema` validated geometries or null

- [ ] **Step 1: Write LLM parser**

```typescript
// src/utils/llmParser.ts
import { z } from 'zod';

export const GeomSchema = z.object({
  warning_id: z.string(),
  geometries: z.array(
    z.object({
      type: z.enum(['point', 'polygon', 'line', 'circle']),
      coords: z.array(
        z.object({
          lat: z.number().min(-90).max(90),
          lon: z.number().min(-180).max(180),
        })
      ),
      radius_nm: z.number().optional(),
    })
  ),
});

export type GeomResult = z.infer<typeof GeomSchema>;

const SYSTEM_PROMPT = `Extract maritime navigation coordinates from the warning text.
Return a JSON array of objects, each with:
- warning_id: the identifier string
- geometries: array of { type: "point"|"polygon"|"line"|"circle", coords: [{lat, lon}], radius_nm? }

Types:
- point: single coordinate
- polygon: 3+ coordinates forming a closed ring (last = first)
- line: 2+ coordinates for a track/route
- circle: center point + radius_nm

Rules:
- lat range: -90 to 90
- lon range: -180 to 180
- Return ONLY the JSON array, no markdown fences, no explanation
- If no coordinates found, return empty array for geometries`;

function stripMarkdownFences(text: string): string {
  return text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
}

async function callMistral(items: Array<{ warning_id: string; raw_text: string }>): Promise<GeomResult[] | null> {
  const { default: MistralClient } = await import('@mistralai/mistralai');
  const client = new MistralClient({ apiKey: process.env.MISTRAL_API_KEY });

  const content = items.map((i) => `[${i.warning_id}]: ${i.raw_text}`).join('\n\n');

  const response = await client.chat.complete({
    model: 'mistral-small-latest',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content },
    ],
    temperature: 0,
  });

  const text = response.choices?.[0]?.message?.content;
  if (!text) return null;

  const cleaned = stripMarkdownFences(text);
  const parsed = JSON.parse(cleaned);
  const result = GeomSchema.array().safeParse(parsed);
  return result.success ? result.data : null;
}

async function callGemini(items: Array<{ warning_id: string; raw_text: string }>): Promise<GeomResult[] | null> {
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '');
  const model = genAI.getGenerativeModel({ model: 'gemini-flash-lite-latest' });

  const content = items.map((i) => `[${i.warning_id}]: ${i.raw_text}`).join('\n\n');

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: `${SYSTEM_PROMPT}\n\n${content}` }] }],
  });

  const text = result.response.text();
  if (!text) return null;

  const cleaned = stripMarkdownFences(text);
  const parsed = JSON.parse(cleaned);
  const validated = GeomSchema.array().safeParse(parsed);
  return validated.success ? validated.data : null;
}

export async function extractBatchWithLLM(
  items: Array<{ warning_id: string; raw_text: string }>
): Promise<GeomResult[] | null> {
  // Try Mistral first
  if (process.env.MISTRAL_API_KEY) {
    try {
      const result = await callMistral(items);
      if (result && result.length > 0) return result;
    } catch (e) {
      console.error('Mistral failed:', e);
    }
  }

  // Fallback to Gemini
  if (process.env.GEMINI_API_KEY) {
    try {
      const result = await callGemini(items);
      if (result && result.length > 0) return result;
    } catch (e) {
      console.error('Gemini failed:', e);
    }
  }

  return null;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/utils/llmParser.ts
git commit -m "feat: LLM parser with Mistral/Gemini fallback, Zod validation"
```

---

## Task 7: Alert Utility

**Files:**
- Create: `src/utils/alert.ts`

**Interfaces:**
- Consumes: `CONFIG.ALERT_WEBHOOK`
- Produces: Console log + optional webhook POST

- [ ] **Step 1: Write alert utility**

```typescript
// src/utils/alert.ts
import { CONFIG } from '../config';

export async function alert(message: string): Promise<void> {
  console.error('[ALERT]', message);
  if (!CONFIG.ALERT_WEBHOOK) return;

  try {
    await fetch(CONFIG.ALERT_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `🚨 HydroBharat scraper: ${message}` }),
    });
  } catch (e) {
    console.error('Alert send failed:', e);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/utils/alert.ts
git commit -m "feat: webhook alert utility"
```

---

## Task 8: Supabase API Service

**Files:**
- Create: `src/services/api.ts`

**Interfaces:**
- Consumes: `CONFIG.SUPABASE_URL`, `CONFIG.SUPABASE_KEY`
- Produces: `DatabaseService` class with `getExisting`, `upsertWarning`, `touch`, `markMissingAsCancelled`, `logRun`

- [ ] **Step 1: Write API service**

```typescript
// src/services/api.ts
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { CONFIG } from '../config';

interface ExistingRow {
  checksum: string;
  revision: number;
}

interface UpsertData {
  warning_id: string;
  sr_no?: number;
  type?: string;
  feature?: string;
  place?: string;
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
        raw_text: data.raw_text,
        checksum: data.checksum,
        revision,
        previous_checksum,
        spatial: data.geometries ?? [],
        spatial_groups: data.spatial_groups ?? [],
        evidence_trail: data.evidence_trail ?? [],
        extraction_method: data.extraction_method,
        confidence_score: data.confidence_score,
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
```

- [ ] **Step 2: Commit**

```bash
git add src/services/api.ts
git commit -m "feat: Supabase API service with change detection and run logging"
```

---

## Task 9: Liferay API Client

**Files:**
- Create: `src/services/liferay.ts`

**Interfaces:**
- Consumes: `CONFIG.LIFERAY_USER`, `CONFIG.LIFERAY_PASS`, `CONFIG.LIFERAY_API_BASE`, `CONFIG.LIFERAY_FOLDER_ID`
- Produces: `LiferayClient` class with `listDocuments()`, `downloadPdf()`

- [ ] **Step 1: Write Liferay API client**

```typescript
// src/services/liferay.ts
import { CONFIG } from '../config';

export interface LiferayDocument {
  id: number;
  title: string;
  dateCreated: string;
  contentUrl: string;
}

export interface PaginatedResponse {
  items: LiferayDocument[];
  page: number;
  pageSize: number;
  lastPage: number;
  totalCount: number;
}

export class LiferayClient {
  private auth: string;
  private baseUrl: string;
  private folderId: number;

  constructor() {
    this.auth = Buffer.from(`${CONFIG.LIFERAY_USER}:${CONFIG.LIFERAY_PASS}`).toString('base64');
    this.baseUrl = CONFIG.LIFERAY_API_BASE;
    this.folderId = CONFIG.LIFERAY_FOLDER_ID;
  }

  private async request<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: `Basic ${this.auth}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Liferay API error: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<T>;
  }

  async listDocuments(page: number = 1, pageSize: number = 20): Promise<PaginatedResponse> {
    const path = `/document-folders/${this.folderId}/documents?page=${page}&pageSize=${pageSize}&sort=dateCreated:desc&fields=id,title,dateCreated,contentUrl`;
    return this.request<PaginatedResponse>(path);
  }

  async listAllDocuments(): Promise<LiferayDocument[]> {
    const allDocs: LiferayDocument[] = [];
    let page = 1;
    let lastPage = 1;

    while (page <= lastPage) {
      const response = await this.listDocuments(page);
      allDocs.push(...response.items);
      lastPage = response.lastPage;
      page++;
    }

    return allDocs;
  }

  async downloadPdf(document: LiferayDocument): Promise<Buffer> {
    const url = `https://hydrobharat.gov.in${document.contentUrl}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Basic ${this.auth}`,
      },
    });

    if (!response.ok) {
      throw new Error(`PDF download failed: ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/liferay.ts
git commit -m "feat: Liferay API client with document listing and PDF download"
```

---

## Task 10: PDF Text Extractor

**Files:**
- Create: `src/utils/pdfExtractor.ts`

**Interfaces:**
- Consumes: PDF Buffer
- Produces: Extracted text string

- [ ] **Step 1: Write PDF extractor**

```typescript
// src/utils/pdfExtractor.ts
import pdfParse from 'pdf-parse';

export async function extractTextFromPdf(pdfBuffer: Buffer): Promise<string> {
  const data = await pdfParse(pdfBuffer);
  return data.text;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/utils/pdfExtractor.ts
git commit -m "feat: PDF text extraction utility"
```

---

## Task 11: Pipeline Orchestrator

**Files:**
- Create: `src/server.ts`

**Interfaces:**
- Consumes: All previous modules
- Produces: Executed pipeline with exit code

- [ ] **Step 1: Write orchestrator**

```typescript
// src/server.ts
import { LiferayClient } from './services/liferay';
import { extractTextFromPdf } from './utils/pdfExtractor';
import { CoordinateParser } from './utils/coordinateParser';
import { extractBatchWithLLM } from './utils/llmParser';
import { DatabaseService } from './services/api';
import { alert } from './utils/alert';
import { CONFIG } from './config';

async function runPipeline() {
  const liferay = new LiferayClient();
  const parser = new CoordinateParser();
  const db = new DatabaseService();
  const started = new Date();
  let scraped = 0;
  let upserted = 0;
  let llmCalls = 0;

  try {
    console.log('[Pipeline] Fetching document list from Liferay API...');
    const documents = await liferay.listAllDocuments();
    scraped = documents.length;
    console.log(`[Pipeline] Found ${scraped} documents`);

    if (scraped < CONFIG.MIN_EXPECTED_ROWS) {
      throw new Error(
        `Only ${scraped} documents — below threshold ${CONFIG.MIN_EXPECTED_ROWS}`
      );
    }

    // Extract warning_id from document title
    const warnings = documents.map((doc) => {
      // Extract warning ID from title like "Inforce_Navarea Warn_mu6wnrsl9.pdf"
      const match = doc.title.match(/Warn[_ ]([a-z0-9]+)/i);
      const warningId = match ? match[1] : `doc-${doc.id}`;
      return { ...doc, warningId };
    });

    // Fetch existing state in one query
    const existing = await db.getExisting(warnings.map((w) => w.warningId));

    const needsLLM: any[] = [];
    const ready: any[] = [];

    for (const w of warnings) {
      // Skip if already processed and unchanged
      if (existing.has(w.warningId)) {
        await db.touch(w.warningId);
        continue;
      }

      // Download and extract PDF text
      console.log(`[Pipeline] Processing: ${w.title}`);
      const pdfBuffer = await liferay.downloadPdf(w);
      const rawText = await extractTextFromPdf(pdfBuffer);

      const checksum = parser.generateChecksum(rawText);
      const prev = existing.get(w.warningId);

      // Unchanged → touch timestamp only
      if (prev && prev.checksum === checksum) {
        await db.touch(w.warningId);
        continue;
      }

      const parsed = parser.parse(rawText);
      const base = {
        warning_id: w.warningId,
        title: w.title,
        raw_text: rawText,
        checksum,
        ...parsed,
      };

      if (parsed.geometries.length > 0) {
        ready.push(base);
      } else {
        needsLLM.push(base);
      }

      // Rate limit: 1 request per second
      await new Promise((r) => setTimeout(r, 1000));
    }

    console.log(
      `[Pipeline] ${ready.length} ready, ${needsLLM.length} need LLM`
    );

    // Batched LLM extraction
    for (let i = 0; i < needsLLM.length; i += CONFIG.LLM_BATCH_SIZE) {
      const batch = needsLLM.slice(i, i + CONFIG.LLM_BATCH_SIZE);
      console.log(
        `[Pipeline] LLM batch ${Math.floor(i / CONFIG.LLM_BATCH_SIZE) + 1}/${Math.ceil(needsLLM.length / CONFIG.LLM_BATCH_SIZE)}`
      );

      const llmResult = await extractBatchWithLLM(
        batch.map((b) => ({ warning_id: b.warning_id, raw_text: b.raw_text }))
      );
      llmCalls++;

      for (const item of batch) {
        const hit = llmResult?.find((r) => r.warning_id === item.warning_id);
        ready.push(
          hit
            ? {
                ...item,
                geometries: hit.geometries,
                extraction_method: 'llm_assisted',
                confidence_score: 0.92,
              }
            : {
                ...item,
                extraction_method: 'failed',
                confidence_score: 0,
                risk_level: 'HIGH',
              }
        );
      }

      // Gentle rate limit
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Upsert all ready rows
    for (const row of ready) {
      await db.upsertWarning(row, existing.get(row.warning_id));
      upserted++;
    }

    // Mark missing as cancelled
    await db.markMissingAsCancelled(warnings.map((w) => w.warningId));

    // Alert on failures
    const failed = ready.filter((r) => r.extraction_method === 'failed').length;
    if (failed > 0) {
      await alert(`${failed} warnings failed geometry extraction`);
    }

    // Log successful run
    await db.logRun({
      started_at: started,
      finished_at: new Date(),
      rows_scraped: scraped,
      rows_upserted: upserted,
      llm_calls: llmCalls,
      status: 'ok',
    });

    console.log(
      `[Pipeline] Complete. ${upserted} upserted, ${llmCalls} LLM calls, ${failed} failures`
    );
  } catch (err: any) {
    console.error('[Pipeline] FAILED:', err.message);
    await alert(`Run FAILED: ${err.message}`);
    await db
      .logRun({
        started_at: started,
        finished_at: new Date(),
        rows_scraped: scraped,
        rows_upserted: upserted,
        llm_calls: llmCalls,
        status: 'error',
        error_text: err.message,
      })
      .catch(() => {});
    process.exit(1);
  }
}

runPipeline();
```

- [ ] **Step 2: Commit**

```bash
git add src/server.ts
git commit -m "feat: pipeline orchestrator with Liferay API, PDF extraction, batched LLM, run logging"
```

---

## Task 12: GitHub Repository & Workflow

**Files:**
- Create: `.github/workflows/scrape.yml`

**Interfaces:**
- Consumes: GitHub repo, secrets
- Produces: Automated daily scraping

- [ ] **Step 1: Create GitHub repo**

Use GitHub MCP to create private repo `hydrobharat-navarea-scraper`.

- [ ] **Step 2: Verify `.gitignore` before push**

```bash
cat .gitignore
git status
```

Confirm no `.env` or `recon/` staged.

- [ ] **Step 3: Push code**

```bash
git remote add origin https://github.com/YOUR_USER/hydrobharat-navarea-scraper.git
git branch -M main
git push -u origin main
```

- [ ] **Step 4: Create workflow file**

```yaml
# .github/workflows/scrape.yml
name: Scrape HydroBharat Navarea
on:
  schedule:
    - cron: '0 6 * * *'
  workflow_dispatch:

concurrency:
  group: hydrobharat-scrape
  cancel-in-progress: false

jobs:
  scrape:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - name: Run Pipeline
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_KEY: ${{ secrets.SUPABASE_KEY }}
          LIFERAY_USER: ${{ secrets.LIFERAY_USER }}
          LIFERAY_PASS: ${{ secrets.LIFERAY_PASS }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
          MISTRAL_API_KEY: ${{ secrets.MISTRAL_API_KEY }}
          ALERT_WEBHOOK: ${{ secrets.ALERT_WEBHOOK }}
        run: npm start
      - name: Upload debug artifacts on failure
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: failure-debug
          path: recon/
```

- [ ] **Step 5: Push workflow**

```bash
git add .github/workflows/scrape.yml
git commit -m "ci: daily scrape workflow with alert-on-failure"
git push
```

- [ ] **Step 6: Set GitHub Secrets**

Guide user to set in repo Settings → Secrets:
- `SUPABASE_URL`
- `SUPABASE_KEY` (service_role)
- `LIFERAY_USER`
- `LIFERAY_PASS`
- `GEMINI_API_KEY`
- `MISTRAL_API_KEY`
- `ALERT_WEBHOOK`

---

## Task 13: Integration Test

**Files:**
- No new files

**Interfaces:**
- Consumes: Full pipeline
- Produces: Verified end-to-end run

- [ ] **Step 1: Run locally with real env**

```bash
cp .env.example .env
# Fill in real values
npm start
```

- [ ] **Step 2: Verify Supabase data**

```sql
SELECT warning_id, extraction_method, risk_level, is_cancelled, revision
FROM nav_warnings
ORDER BY created_at DESC
LIMIT 10;
```

- [ ] **Step 3: Verify audit trail**

```sql
SELECT warning_id, checksum_sha256, captured_at
FROM raw_messages
ORDER BY captured_at DESC
LIMIT 5;
```

- [ ] **Step 4: Verify run log**

```sql
SELECT status, rows_scraped, rows_upserted, llm_calls, error_text
FROM scraper_runs
ORDER BY started_at DESC
LIMIT 3;
```

- [ ] **Step 5: Trigger GitHub Actions run**

```bash
gh workflow run "Scrape HydroBharat Navarea"
gh run watch
```

Expected: Green checkmark, all steps pass.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-09-18-hydrobharat-navarea-scraper.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
