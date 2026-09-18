# HydroBharat NAVAREA VIII Scraper — Design Spec

**Date:** 2026-09-18
**Status:** Draft
**Author:** Agent + User (collaborative)

---

## 1. Executive Summary

Production scraper for Indian NAVAREA VIII navigational warnings from `hydrobharat.gov.in/navarea-warnings`. Uses a 3-Tier parsing architecture (deterministic regex → Mistral AI → Gemini Flash-Lite) to extract spatial geometries from unstructured maritime telegrams. Persists structured data + full audit trail to Supabase. Runs daily via GitHub Actions with zero-downtime cost-efficiency (Tier 1 handles ~80% of warnings at $0 cost).

---

## 2. System Architecture

```
[ Liferay Headless Delivery API ]
   Basic Auth: nho@liferay.com:Giks@2017
   Folder: Navarea Warnings (ID: 288109)
   Returns: PDF document metadata + download URLs
        │
        ▼
[ PDF Downloader + Text Extractor ]
   Downloads PDFs via contentUrl
   Extracts text via pdf-parse
        │
        ▼
[ 3-Tier Parsing Engine ]
   Tier 1: Deterministic Regex (< 2ms, $0)
   Tier 2: Mistral AI (batched, ~$0.002/warning)
   Tier 3: Gemini Flash-Lite (fallback, ~$0.001/warning)
        │
        ▼
[ Supabase PostgreSQL ]
   nav_warnings      — structured vector + relational
   raw_messages      — audit trail + checksum
   scraper_runs      — run health log
        │
        ▼
[ GitHub Actions ] — daily cron, workflow_dispatch, alert on failure
```

---

## 3. Data Source

**Target:** `https://hydrobharat.gov.in/navarea-warnings`
**Method:** Liferay Headless Delivery API (Basic Auth)
**Auth:** Credentials found in page JavaScript (`nho@liferay.com:Giks@2017`)
**API Endpoint:** `https://hydrobharat.gov.in/o/headless-delivery/v1.0/`
**Folder ID:** 288109 ("Navarea Warnings")
**Total Documents:** 574 PDFs (as of 2026-09-18)
**Upload Cadence:** Daily (most recent: same day)
**Document Format:** PDFs titled `Inforce_Navarea Warn_*.pdf`

**API Flow:**
1. List documents from folder 288109 (paginated, 20 per page)
2. Each document returns: `id`, `title`, `dateCreated`, `contentUrl`
3. Download PDF via `contentUrl` (requires Basic Auth header)
4. Extract text from PDF using `pdf-parse`
5. Parse extracted text through 3-Tier engine

---

## 4. 3-Tier Parsing Engine

### Tier 1: Deterministic Regex Engine

**Cost:** $0.00 / 0 API tokens
**Latency:** < 2ms
**Triggers:** Always runs first on raw text.

**Coordinate Formats Supported:**

| Format | Example | Pattern |
|--------|---------|---------|
| Deg-Min (hyphenated) | `58-30.5N 001-45.2E` | `(\d{1,2})-(\d{1,2}(?:\.\d+)?)\s*([NS])\s+(\d{1,3})-(\d{1,2}(?:\.\d+)?)\s*([EW])` |
| Deg-Min (space) | `58 30.5N 001 45.2E` | `(\d{1,2})\s+(\d{1,2}(?:\.\d+)?)\s*([NS])\s+(\d{1,3})\s+(\d{1,2}(?:\.\d+)?)\s*([EW])` |
| Deg-Min (concatenated) | `5830.5N 00145.2E` | `(\d{2,4})(\d{2}(?:\.\d+)?)\s*([NS])\s+(\d{3,5})(\d{2}(?:\.\d+)?)\s*([EW])` |
| DMS | `58°30'30"N 001°45'18"E` | `(\d{1,2})[°](\d{1,2})['′](\d{1,2}(?:\.\d+)?)[\"″]?\s*([NS])\s+(\d{1,3})[°](\d{1,2})['′](\d{1,2}(?:\.\d+)?)[\"″]?\s*([EW])` |
| Labeled (LAT/LONG) | `LAT 58-30N LONG 001-45E` | `(?:LAT\|纬)\s+(\d{1,2})-(\d{1,2})\s*([NS])\s+(?:LONG\|经\|LON)\s+(\d{1,3})-(\d{1,2})\s*([EW])` |
| Decimal degrees | `58.508N 1.753E` | `(\d{1,3}(?:\.\d+)?)\s*([NS])\s+(\d{1,3}(?:\.\d+)?)\s*([EW])` |

**Spatial Topology Classification:**

- **Point with Radius:** Detects `WITHIN N NM OF` / `RADIUS N KM` → Circle geometry with `radius_nm`
- **Polygon (BOUNDED BY):** Detects bounding sequences → Polygon GeoJSON with ring closure (first = last coord), unique `spatial_group_id`
- **LineString (JOINING):** Detects track lines between sequential coordinates → LineString geometry

**Cancellation & Expiry Extraction:**
- Regex: `CANCEL THIS MSG [DDHHMM] UTC [MON] [YY]`
- Computes ISO UTC timestamp for `valid_until_utc`
- Populates `cancellation_text` and `is_cancelled` boolean

**Validation Rules:**
- Hard bounds: lat −90..90, lon −180..180 → reject outside
- NAVAREA VIII sanity: lat −10..30N, lon 30..100E → outside = `risk_level = 'REVIEW'`, don't discard

**Evidence Trail:**
- Appends rule trace object documenting which regex matched each feature for auditability

### Tier 2: Mistral AI (mistral-small-latest)

**Trigger:** Tier 1 returns 0 coordinates or `parseMode === 'llm'`
**Cost:** ~$0.002 per batch of 10 warnings
**Model:** `mistral-small-latest` via server-side API

**Payload:** Raw warning text + strict JSON Schema prompt demanding:
- Series / NAVAREA identifier
- Warning number and year
- Area description and authority
- Geometries (Points, Polygons, LineStrings with coordinates and radius)
- Translated text or summary

**Batching:** Up to `CONFIG.LLM_BATCH_SIZE` warnings per API call (default: 10).

**Error Handling:** Wrapped in try/catch. Network errors, rate limits, timeouts flow to Tier 3.

### Tier 3: Google Gemini Flash-Lite

**Trigger:** Tier 2 throws exception or returns empty payload
**Cost:** ~$0.001 per batch
**Model:** `gemini-flash-lite-latest` via `@google/generative-ai`

**Payload:** Identical JSON schema contract as Tier 2.

**Post-Processing:**
- Validates and parses JSON (strips Markdown fences if present)
- Merges LLM-extracted geometries with deterministic metadata
- Sets `extraction_method` to `'llm_assisted'` with confidence `0.92–0.95`

### Post-Processing (All Tiers)

- Zod schema validation on all LLM output (`GeomSchema`)
- Schema failure → return null, do NOT store unvalidated LLM output
- Assign `risk_level` based on NAVAREA VIII bounds check

---

## 5. Database Schema (Supabase)

### Table: `nav_warnings`

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

### Table: `raw_messages` (Audit Trail)

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

### Table: `scraper_runs`

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

### Row Level Security

```sql
ALTER TABLE nav_warnings ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE scraper_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "svc full" ON nav_warnings FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "svc full" ON raw_messages FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "svc full" ON scraper_runs FOR ALL TO service_role USING (true) WITH CHECK (true);
```

---

## 6. Change Detection & Cost Efficiency

### Checksum-Based Change Detection

1. Compute SHA-256 of normalized text (whitespace-collapsed, uppercased)
2. Fetch existing checksums for all warning IDs in one query
3. Decision logic:
   - **No existing row** → insert, revision 1, status 'active'
   - **Checksum unchanged** → touch `last_seen_at` only (skip LLM entirely)
   - **Checksum changed** → archive old version to `raw_messages`, bump revision, set `previous_checksum`, status 'amended', update row

### Missing Warnings

- Warnings not seen in current run → set `is_cancelled = true`

---

## 7. Project Structure

```
hydrobharat-navarea-scraper/
├── .gitignore
├── package.json
├── tsconfig.json
├── .env.example
├── recon/                    # Step 0 output (gitignored)
│   └── page.html
├── src/
│   ├── config.ts             # Env vars, fail-fast validation
│   ├── services/
│   │   ├── liferay.ts        # Liferay API client (list + download PDFs)
│   │   └── api.ts            # Supabase CRUD + change detection
│   ├── utils/
│   │   ├── pdfExtractor.ts   # PDF → text extraction
│   │   ├── coordinateParser.ts   # Tier 1: Regex engine
│   │   ├── llmParser.ts          # Tier 2+3: AI extraction
│   │   └── alert.ts              # Webhook alerts
│   └── server.ts             # Pipeline orchestrator
└── docs/
    └── superpowers/
        └── specs/
            └── 2026-09-18-hydrobharat-navarea-scraper-design.md
```

---

## 8. Dependencies

```json
{
  "dependencies": {
    "pdf-parse": "^1.1.1",
    "@supabase/supabase-js": "^2.45.0",
    "@google/generative-ai": "^0.21.0",
    "@mistralai/mistralai": "^1.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "tsx": "^4.19.0",
    "@types/node": "^22.0.0"
  }
}
```

---

## 9. Configuration (Environment Variables)

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_KEY` | Yes | **service_role** key (bypasses RLS) |
| `LIFERAY_USER` | Yes | Liferay API username (Basic Auth) |
| `LIFERAY_PASS` | Yes | Liferay API password (Basic Auth) |
| `MISTRAL_API_KEY` | No | Mistral AI API key (Tier 2) |
| `GEMINI_API_KEY` | No | Google Gemini API key (Tier 3) |
| `ALERT_WEBHOOK` | No | Telegram/Slack/Discord webhook for failure alerts |

**Fail-fast:** App crashes immediately if `SUPABASE_URL`, `SUPABASE_KEY`, `LIFERAY_USER`, or `LIFERAY_PASS` missing.

---

## 10. GitHub Actions Workflow

```yaml
name: Scrape HydroBharat Navarea
on:
  schedule:
    - cron: '0 6 * * *'      # Daily at 06:00 UTC
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
          SUPABASE_URL:    ${{ secrets.SUPABASE_URL }}
          SUPABASE_KEY:    ${{ secrets.SUPABASE_KEY }}
          LIFERAY_USER:    ${{ secrets.LIFERAY_USER }}
          LIFERAY_PASS:    ${{ secrets.LIFERAY_PASS }}
          GEMINI_API_KEY:  ${{ secrets.GEMINI_API_KEY }}
          MISTRAL_API_KEY: ${{ secrets.MISTRAL_API_KEY }}
          ALERT_WEBHOOK:   ${{ secrets.ALERT_WEBHOOK }}
        run: npm start
      - name: Upload debug artifacts on failure
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: failure-debug
          path: recon/
```

**Key constraints:**
- `SUPABASE_KEY` must be `service_role` key (never expose client-side)
- `LIFERAY_USER` / `LIFERAY_PASS` are Basic Auth credentials for Liferay API
- `timeout-minutes: 20` prevents runaway builds
- Concurrency group prevents overlapping runs
- Debug artifacts uploaded on failure for diagnosis

---

## 11. Error Handling & Alerts

- **Zero rows scraped** → throw error, log run as 'error', send alert
- **Below `MIN_EXPECTED_ROWS` (5)** → treat as failure
- **LLM extraction failures** → flag `risk_level = 'HIGH'`, send alert with count
- **All tiers failed** → store with `extraction_method = 'failed'`, `confidence_score = 0`
- **Non-zero exit on failure** → GitHub Actions shows red status

---

## 12. Stop-Gates (User Approval Required)

1. **After Step 0 (Recon):** Show API structure, document count, sample PDF content. Wait for user confirmation.
2. **After Coordinate Parser:** Show regex patterns + 10 test results. Wait for user approval.

---

## 13. Out of Scope (Phase 2)

- **Vercel dashboard** — deferred until dashboard is built. Separate Next.js repo, anon key + read-only RLS.
- **Real-time notifications** — future enhancement
- **Multi-source aggregation** — other NAVAREA sites
