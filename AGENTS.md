# NAVAREA Warnings Tracker — Project Context

Full-stack maritime navigational warning tracker with **dual backend** scrapers feeding one Supabase table, and a **Next.js** map + admin frontend.

## Architecture

### Backend — two parallel scrapers (same target table)

| Scraper | Entry | Source ID | Auth | Schedule |
|---------|-------|-----------|------|----------|
| Node.js/TypeScript | `src/server.ts` (`npm start`) | `hydrobharat-gov-in` | Liferay Basic auth (`LIFERAY_USER`/`LIFERAY_PASS`) | daily 06:00 UTC |
| Python | `nho_fetch.py` | `nho-portal` | OAuth2 client credentials (`NHO_CLIENT_ID`/`NHO_CLIENT_SECRET`), auto-discovered from JS bundles or env | every 6 hours |

Both upsert into the **`nav_warnings`** table with conflict key **`(source_id, warning_id)`** and mark records no longer present as `is_cancelled: true`.

- Node.js pipeline: Liferay headless delivery API → PDF download → `pdf-parse` → **`parseMulti`** (splits the full "warnings in force" list into per-warning segments at `NAVAREA VIII -NNN/YY` headers, then parses each) → LLM (Mistral/Gemini) fallback for hard cases → batch upsert.
- Python pipeline: NHO `nho-headless/map/combined` JSON → transform (incl. `dtg`/`b_char` fields) → batch upsert.

### Frontend — Next.js 16 App Router (`dashboard/`)

- `/` — Leaflet map (react-leaflet) with per-source filtering and risk-level coloring. Client component fetching `/api/warnings`.
- `/admin` — Server Component table of the latest 100 rows from `nav_warnings` (force-dynamic).
- `/api/warnings` — Route handler querying `nav_warnings_map`, supports `?source=` filter.
- Supabase client: `dashboard/lib/supabase.ts`. Types: `dashboard/lib/types.ts`, `src/types.ts`.

### CI/CD (`.github/workflows/`)

- `scrape.yml` — Node.js scraper (daily 06:00), includes cleanup job + failure artifacts.
- `nho-scraper.yml` — Python scraper (every 6 hours).

## Key Conventions

- **Database:** Supabase PostgreSQL, table `nav_warnings` (+ `raw_messages` archive, `scraper_runs` log, `nav_warnings_map` view).
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
