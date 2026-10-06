# NAVAREA Warnings Tracker — Project Context

Full-stack maritime navigational warning tracker with **dual backend** scrapers feeding one Supabase table, and a **Next.js** map + admin frontend.

## Architecture

### Backend — two parallel scrapers (same target table)

| Scraper | Entry | Source ID | Auth | Schedule |
|---------|-------|-----------|------|----------|
| Node.js/TypeScript | `src/server.ts` (`npm start`) | `hydrobharat-gov-in` | Liferay Basic auth (`LIFERAY_USER`/`LIFERAY_PASS`) | daily 06:00 UTC |
| Python | `nho_fetch.py` | `nho-portal` | HTTP Basic (`LIFERAY_USER`/`LIFERAY_PASS`, primary) or OAuth2 client credentials (`NHO_CLIENT_ID`/`NHO_CLIENT_SECRET`) | every 6 hours |

> **Retired (2026-10-06):** Edge Function `scrape-navarea-india` (HTML scrape of `hydrobharat.gov.in/navarea-warnings`). Archived at `supabase/functions/scrape-navarea-india/`. Never produced data (`source_id: india-hydrobharat-html` absent from `nav_warnings`). The two repo scrapers cover the same NHO/hydrobharat data via official APIs (Liferay PDF + NHO JSON).

Both upsert into the **`nav_warnings`** table with conflict key **`(source_id, warning_id)`** and mark records no longer present as `is_cancelled: true`.

- Node.js pipeline: Liferay headless delivery API → PDF download → `pdf-parse` → **`parseMulti`** (splits the full "warnings in force" list into per-warning segments at `NAVAREA VIII -NNN/YY` headers, then parses each) → LLM (Mistral/Gemini) fallback for hard cases → batch upsert.
- Python pipeline: NHO `nho-headless/map/combined` JSON (list of `{NavArea:[...]}` wrappers) → `group_notices` (entries sharing an `identifier` are one multi-area warning; their shapes merge into a single row's `spatial` array) → transform (nautical `deg,min` coordinate strings → decimal degrees; `status != Active` → `is_cancelled`) → batch upsert.

### Frontend — Next.js 16 App Router (`dashboard/`)

- `/` — Leaflet map (react-leaflet) with per-source filtering and risk-level coloring. Client component fetching `/api/warnings`.
- `/admin` — Server Component table of the latest 100 rows from `nav_warnings_admin` view (force-dynamic).
- `/api/warnings` — Route handler querying `nav_warnings_map`, supports `?source=` filter.
- Supabase client: `dashboard/lib/supabase.ts`. Types: `dashboard/lib/types.ts`, `src/types.ts`.

### CI/CD (`.github/workflows/`)

- `scrape.yml` — Node.js scraper (daily 06:00), includes cleanup job + failure artifacts.
- `nho-scraper.yml` — Python scraper (every 6 hours).

## Key Conventions

- **Database:** Supabase PostgreSQL, table `nav_warnings` (+ `raw_messages` archive, `scraper_runs` log, `nav_warnings_map` view, `nav_warnings_admin` view).
- **RLS:** base tables are service-role only — anon reads must go through views (`nav_warnings_map` for the map, `nav_warnings_admin` for `/admin`). The dashboard anon client gets empty results from `nav_warnings` directly.
- **Spatial column:** `spatial` JSONB array of `{ type: "point"|"polygon"|"line"|"circle", coords: [{lat,lon}], radius_nm? }`.
- **Coordinate convention:** stored coords are `{lat, lon}` objects; Leaflet arrays are `[lat, lon]`; GeoJSON/wire coordinates are `[lon, lat]`. Convert at the boundary only — **never flip coordinates in stored data or the map renderer** (flipping breaks a correct map; ordering bugs live in the parser).
- **Per-warning segmentation:** one source PDF = the whole "warnings in force" list. `splitWarnings`/`parseMulti` (`src/utils/coordinateParser.ts`) split at `NAVAREA VIII -NNN/YY` headers so each warning's geometry is parsed separately. Never merge coordinates across warnings — a single mega-polygon spans the whole NAVAREA and distorts the map.
- **Risk levels:** `HIGH`, `REVIEW`, `NORMAL`.
- **Extraction methods:** `deterministic`, `llm_assisted`, `nho_json`, `failed`.
- **Env vars:** `SUPABASE_URL`, `SUPABASE_KEY` (service role), `LIFERAY_USER`, `LIFERAY_PASS`, `MISTRAL_API_KEY`, `GEMINI_API_KEY`, `ALERT_WEBHOOK`, `NHO_CLIENT_ID`, `NHO_CLIENT_SECRET`.
- **Path alias:** `@/*` → `dashboard/*` (in the `dashboard/` package).
- **Styling:** Tailwind CSS v4 (`@import "tailwindcss"` in `globals.css`), dark zinc theme.

## Commands

- Node.js scraper: `npm start` (root)
- Dashboard dev: `cd dashboard && npm run dev`
- Dashboard typecheck: `cd dashboard && npx tsc --noEmit`
- Python scraper: `venv\Scripts\python.exe nho_fetch.py` (probe: `... nho_fetch.py probe`)

## Post-mortem: Edge Function `scrape-navarea-india` (retired 2026-10-06)

The Edge Function assumed server-rendered HTML tables; hydrobharat.gov.in publishes NAVAREA warnings as PDFs behind its Liferay API, so the Cheerio parser had nothing to find. With no HTTP status check, no row-count diagnostics, and `success: true` returned unconditionally, it reported healthy while saving zero — for 19 days. It was retired because the repo's two version-controlled pipelines (Liferay→PDF and NHO JSON) already covered the same source with real error handling.

**Durable lesson:** empty-result success is the most dangerous state a scraper can be in. The instrumented pattern in the archive (`supabase/functions/scrape-navarea-india/index.ts`) — status check, HTML metrics, diagnostics in the response body — is the template to reuse if a third source ever needs scraping.
