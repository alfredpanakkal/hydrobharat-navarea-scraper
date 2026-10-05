import hashlib
import json
import logging
import os
import re
import sys
from datetime import datetime, timezone
from typing import Any

import requests
from supabase import create_client, Client

logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")
log = logging.getLogger("nho_fetch")

NHO_BASE = "https://hydrobharat.gov.in"
NHO_MAP_URL = f"{NHO_BASE}/o/nho-headless/map/combined"
SOURCE_ID = "nho-portal"

CLIENT_ID_PATTERNS = [
    r"""client_id["']?\s*[:=]\s*["']([^"']+)["']""",
    r"""clientId["']?\s*[:=]\s*["']([^"']+)["']""",
    r"""CLIENT_ID["']?\s*[:=]\s*["']([^"']+)["']""",
    r"""client_id["']?\s*:\s*["']([^"']+)["']""",
]
CLIENT_SECRET_PATTERNS = [
    r"""client_secret["']?\s*[:=]\s*["']([^"']+)["']""",
    r"""clientSecret["']?\s*[:=]\s*["']([^"']+)["']""",
    r"""CLIENT_SECRET["']?\s*[:=]\s*["']([^"']+)["']""",
    r"""client_secret["']?\s*:\s*["']([^"']+)["']""",
]


def require_env(key: str) -> str:
    v = os.environ.get(key)
    if not v:
        raise SystemExit(f"Missing env var: {key}")
    return v


def require_supabase_key() -> str:
    v = os.environ.get("SUPABASE_KEY")
    if not v:
        raise SystemExit("Missing env var: SUPABASE_KEY")
    return v


def discover_js_bundles(html: str) -> list[str]:
    urls = re.findall(r"""(?:src|href)=["']([^"']+\.js[^"']*)["']""", html)
    out: list[str] = []
    for u in urls:
        if u.startswith("http"):
            out.append(u)
        elif u.startswith("/"):
            out.append(NHO_BASE + u)
        else:
            out.append(NHO_BASE + "/" + u)
    seen: set[str] = set()
    unique: list[str] = []
    for u in out:
        if u not in seen:
            seen.add(u)
            unique.append(u)
    return unique


def search_patterns(text: str, patterns: list[str]) -> str | None:
    for p in patterns:
        m = re.search(p, text)
        if m:
            return m.group(1)
    return None


def fetch_credentials(session: requests.Session) -> tuple[str, str]:
    env_id = os.environ.get("NHO_CLIENT_ID")
    env_secret = os.environ.get("NHO_CLIENT_SECRET")
    if env_id and env_secret:
        log.info("Using credentials from NHO_CLIENT_ID / NHO_CLIENT_SECRET")
        return env_id, env_secret

    log.info("Fetching NHO map page to discover JS bundles...")
    resp = session.get(NHO_MAP_URL, timeout=30)
    resp.raise_for_status()
    html = resp.text

    bundles = discover_js_bundles(html)
    log.info("Found %d JS bundle URL(s)", len(bundles))

    for bundle in bundles:
        try:
            js = session.get(bundle, timeout=30).text
        except requests.RequestException as e:
            log.warning("Failed to fetch %s: %s", bundle, e)
            continue
        cid = search_patterns(js, CLIENT_ID_PATTERNS)
        sec = search_patterns(js, CLIENT_SECRET_PATTERNS)
        if cid and sec:
            log.info("Credentials discovered in %s", bundle)
            return cid, sec
        if cid or sec:
            log.debug("Partial credential match in %s (id=%s)", bundle, bool(cid))

    raise SystemExit(
        "Could not discover client_id/client_secret. Set NHO_CLIENT_ID and NHO_CLIENT_SECRET env vars."
    )


def fetch_oauth_token(
    session: requests.Session, client_id: str, client_secret: str
) -> str:
    log.info("Requesting OAuth2 access token (client_credentials)...")
    resp = session.post(
        f"{NHO_BASE}/o/oauth2/token",
        data={
            "grant_type": "client_credentials",
            "client_id": client_id,
            "client_secret": client_secret,
        },
        headers={"Accept": "application/json"},
        timeout=30,
    )
    resp.raise_for_status()
    try:
        payload = resp.json()
    except ValueError:
        raise SystemExit("Unexpected non-JSON response from OAuth2 token endpoint")
    token = payload.get("access_token")
    if not token:
        raise SystemExit(
            f"OAuth2 token response missing access_token (keys: {list(payload.keys())})"
        )
    log.info("OAuth2 access token acquired")
    return token


def fetch_combined_data(session: requests.Session, access_token: str) -> Any:
    resp = session.get(
        NHO_MAP_URL,
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {access_token}",
        },
        timeout=60,
    )
    resp.raise_for_status()
    try:
        return resp.json()
    except ValueError:
        raise SystemExit(f"Unexpected non-JSON response from {NHO_MAP_URL}")


def checksum_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def normalize_point(coord: Any) -> dict[str, Any] | None:
    if isinstance(coord, dict):
        lat = coord.get("lat")
        lon = coord.get("lon") or coord.get("lng")
        if lat is not None and lon is not None:
            return {"lat": float(lat), "lon": float(lon)}
    if isinstance(coord, (list, tuple)) and len(coord) >= 2:
        return {"lat": float(coord[1]), "lon": float(coord[0])}
    return None


def normalize_geometry(geometry: Any) -> list[dict[str, Any]]:
    spatial: list[dict[str, Any]] = []
    if not geometry:
        return spatial

    geoms = geometry if isinstance(geometry, list) else [geometry]
    for g in geoms:
        if not isinstance(g, dict):
            continue
        gtype = str(g.get("type", "")).lower()
        coords = g.get("coordinates", g.get("coords", []))

        if gtype == "point":
            pt = normalize_point(coords) if not isinstance(coords, list) else None
            if pt is None and isinstance(coords, (list, tuple)) and len(coords) >= 2:
                if isinstance(coords[0], (list, tuple)):
                    pt = normalize_point(coords[0])
                else:
                    pt = {"lat": float(coords[1]), "lon": float(coords[0])}
            if pt:
                spatial.append({"type": "point", "coords": [pt]})
        elif gtype == "circle":
            pt = None
            if isinstance(coords, (list, tuple)) and len(coords) >= 2:
                if isinstance(coords[0], (list, tuple)):
                    pt = normalize_point(coords[0])
                else:
                    pt = {"lat": float(coords[1]), "lon": float(coords[0])}
            radius = g.get("radius_nm", g.get("radius"))
            if pt:
                spatial.append(
                    {
                        "type": "circle",
                        "coords": [pt],
                        "radius_nm": float(radius) if radius is not None else 0,
                    }
                )
        elif gtype in ("polygon", "multipolygon"):
            ring = coords
            if isinstance(coords, (list, tuple)) and coords and isinstance(coords[0], (list, tuple)):
                if isinstance(coords[0][0], (list, tuple)):
                    ring = coords[0]
            pts = [normalize_point(p) for p in ring]
            pts = [p for p in pts if p is not None]
            if pts:
                spatial.append({"type": "polygon", "coords": pts})
        elif gtype == "line":
            pts = [normalize_point(p) for p in coords]
            pts = [p for p in pts if p is not None]
            if pts:
                spatial.append({"type": "line", "coords": pts})
        else:
            pt = normalize_point(coords)
            if pt:
                spatial.append({"type": "point", "coords": [pt]})
    return spatial


def detect_cancellation(message: str) -> tuple[bool, str | None]:
    if not message:
        return False, None
    lower = message.lower()
    if re.search(r"\bcancel\b", lower):
        m = re.search(r"cancel\s+(?:navarea\s+viii\s+msg\s+)?(.+?)(?:\n|$)", lower)
        text = m.group(1).strip() if m else message.strip()
        return True, text[:500]
    return False, None


def first_str(raw: dict[str, Any], keys: tuple[str, ...]) -> str | None:
    for k in keys:
        v = raw.get(k)
        if v is not None and str(v).strip():
            return str(v).strip()
    return None


def transform_notice(raw: dict[str, Any]) -> dict[str, Any]:
    identifier = raw.get("identifier") or raw.get("id") or raw.get("warning_id") or "unknown"
    year = raw.get("year") or raw.get("notice_year")
    notice = raw.get("notice") or raw.get("notice_number") or raw.get("number")
    message = raw.get("message") or raw.get("text") or raw.get("body") or ""
    geometry = raw.get("geometry") or raw.get("geom") or raw.get("spatial")
    dtg = first_str(raw, ("dtg", "date_time_group", "dateTimeGroup", "date_group"))
    b_char = first_str(raw, ("b_char", "bChar", "broadcast_char", "bch"))

    spatial = normalize_geometry(geometry)
    is_cancelled, cancellation_text = detect_cancellation(str(message))

    if year and notice:
        warning_id = f"{identifier}-{year}-{notice}"
    else:
        warning_id = str(identifier)

    evidence_trail: list[dict[str, str]] = []
    if dtg:
        evidence_trail.append({"rule": "nho_json:dtg", "match": dtg[:200]})
    if b_char:
        evidence_trail.append({"rule": "nho_json:b_char", "match": b_char[:200]})

    base_title = f"NAVAREA VIII {identifier}" if str(identifier) else "NAVAREA VIII"
    suffix = " · ".join(p for p in (dtg, b_char) if p)
    title = f"{base_title} · {suffix}" if suffix else base_title

    now = datetime.now(timezone.utc).isoformat()
    return {
        "warning_id": warning_id,
        "source_id": SOURCE_ID,
        "title": title,
        "raw_text": str(message),
        "checksum": checksum_text(str(message)),
        "revision": 1,
        "previous_checksum": None,
        "spatial": spatial,
        "spatial_groups": [],
        "evidence_trail": evidence_trail,
        "extraction_method": "nho_json",
        "confidence_score": 0.95,
        "risk_level": "NORMAL",
        "is_cancelled": is_cancelled,
        "cancellation_text": cancellation_text,
        "valid_until_utc": None,
        "last_seen_at": now,
        "updated_at": now,
    }


def extract_notices(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in ("notices", "data", "items", "warnings", "features", "results"):
            val = data.get(key)
            if isinstance(val, list):
                return val
    return []


def run_probe() -> None:
    log.info("Probe mode: validating environment...")
    require_env("SUPABASE_URL")
    require_supabase_key()
    log.info("Environment OK")


def run_scrape() -> None:
    supabase_url = require_env("SUPABASE_URL")
    supabase_key = require_supabase_key()
    supabase: Client = create_client(supabase_url, supabase_key)

    session = requests.Session()
    session.headers.update({"User-Agent": "navarea-nho-scraper/1.0"})

    client_id, client_secret = fetch_credentials(session)
    access_token = fetch_oauth_token(session, client_id, client_secret)
    data = fetch_combined_data(session, access_token)
    notices = extract_notices(data)

    if not notices:
        log.warning("No notices found in NHO response (keys: %s)", list(data.keys()) if isinstance(data, dict) else type(data))

    log.info("Fetched %d notice(s) from NHO portal", len(notices))

    records = [transform_notice(n) for n in notices]
    seen_ids = [r["warning_id"] for r in records]

    batch_size = 50
    upserted = 0
    for i in range(0, len(records), batch_size):
        batch = records[i : i + batch_size]
        resp = (
            supabase.table("nav_warnings")
            .upsert(batch, on_conflict="source_id,warning_id")
            .execute()
        )
        if resp.error:
            log.error("Upsert error: %s", resp.error.message)
        else:
            upserted += len(batch)
            log.info("Upserted batch %d..%d", i, i + len(batch))

    active = (
        supabase.table("nav_warnings")
        .select("warning_id")
        .eq("source_id", SOURCE_ID)
        .eq("is_cancelled", False)
        .execute()
    )
    active_ids = [r["warning_id"] for r in (active.data or [])]
    missing = [wid for wid in active_ids if wid not in seen_ids]
    cancelled = 0
    for i in range(0, len(missing), 100):
        chunk = missing[i : i + 100]
        resp = (
            supabase.table("nav_warnings")
            .update(
                {
                    "is_cancelled": True,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
            )
            .eq("source_id", SOURCE_ID)
            .in_("warning_id", chunk)
            .execute()
        )
        if resp.error:
            log.error("Batch cancel error (%d ids): %s", len(chunk), resp.error.message)
        else:
            cancelled += len(chunk)
    if missing:
        log.info("Marked %d missing record(s) as cancelled", cancelled)

    log.info("NHO fetch complete: %d upserted, %d cancelled", upserted, cancelled)


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "probe":
        run_probe()
    else:
        run_scrape()


if __name__ == "__main__":
    main()
