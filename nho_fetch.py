import base64
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
NHO_PUBLIC_URL = f"{NHO_BASE}/navarea-warnings"
NHO_TOKEN_URL = f"{NHO_BASE}/o/oauth2/token"
SOURCE_ID = "nho-portal"
# Last-resort mirror of NHO NAVAREA VIII bulletins (anonymous, free).
MIRROR_URL = "https://www.sealagom.com/navarea/8/"

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


def require_env(key: str) -> str:
    v = os.environ.get(key)
    if not v:
        raise SystemExit(f"Missing env var: {key}")
    return v


def basic_auth_header(user: str, password: str) -> str:
    token = base64.b64encode(f"{user}:{password}".encode("utf-8")).decode("ascii")
    return f"Basic {token}"


def _stealthy_fetch(url: str, extra_headers: dict[str, str] | None = None) -> str | None:
    """
    Fetch a URL with Scrapling's StealthyFetcher (Camoufox headless browser).
    Returns page text on success, None if scrapling is unavailable or the
    fetch fails. Import is lazy so the mirror tier still works in
    environments where the browser engine was not installed.
    """
    try:
        from scrapling.fetchers import StealthyFetcher
    except ImportError:
        log.warning("scrapling not installed; skipping stealthy fetch of %s", url)
        return None
    try:
        page = StealthyFetcher.fetch(
            url,
            headless=True,
            network_idle=True,
            stealthy_headers=True,
            extra_headers=extra_headers or None,
            timeout=90,
        )
    except Exception as e:  # scrapling raises varied browser errors
        log.warning("StealthyFetcher failed for %s: %s", url, e)
        return None
    if page.status >= 400:
        log.warning("StealthyFetcher got HTTP %s for %s", page.status, url)
        return None
    return page.get_all_text() if hasattr(page, "get_all_text") else str(page.body)


# ----------------------------------------------------------------------------
# Tier 1: NHO portal JSON endpoint (needs credentials; stealthy first)
# ----------------------------------------------------------------------------

def _portal_headers(session: requests.Session) -> dict[str, str]:
    user = os.environ.get("LIFERAY_USER")
    password = os.environ.get("LIFERAY_PASS")
    if user and password:
        return {"Authorization": basic_auth_header(user, password)}
    client_id = os.environ.get("NHO_CLIENT_ID")
    client_secret = os.environ.get("NHO_CLIENT_SECRET")
    if client_id and client_secret:
        try:
            resp = session.post(
                NHO_TOKEN_URL,
                data={
                    "grant_type": "client_credentials",
                    "client_id": client_id,
                    "client_secret": client_secret,
                },
                headers={"Accept": "application/json"},
                timeout=30,
            )
            token = resp.json().get("access_token")
            if resp.status_code < 400 and token:
                return {"Authorization": f"Bearer {token}"}
            log.warning("OAuth token request failed: HTTP %s", resp.status_code)
        except Exception as e:
            log.warning("OAuth token request error: %s", e)
    return {}


def fetch_tier1_portal() -> list[dict[str, Any]]:
    """NHO portal /o/nho-headless/map/combined — official structured JSON."""
    auth = _portal_headers(requests.Session())
    headers = {**auth, "Accept": "application/json"}
    if auth:
        try:
            resp = requests.get(NHO_MAP_URL, headers=headers, timeout=60)
            if resp.status_code == 200:
                data = resp.json()
                notices = extract_notices(data)
                if notices:
                    log.info("Tier 1 (portal, requests) yielded %d notice(s)", len(notices))
                    return notices
            log.info("Tier 1 requests attempt: HTTP %s", resp.status_code)
        except Exception as e:
            log.info("Tier 1 requests attempt failed: %s", e)

    # Stealthy browser attempt (bypasses edge denial; JSON arrives as page text)
    text = _stealthy_fetch(NHO_MAP_URL, extra_headers={"Accept": "application/json"})
    if text:
        try:
            data = json.loads(text)
            notices = extract_notices(data)
            if notices:
                log.info("Tier 1 (portal, StealthyFetcher) yielded %d notice(s)", len(notices))
                return notices
        except (ValueError, TypeError):
            log.info("Tier 1 stealthy response was not JSON")
    return []


# ----------------------------------------------------------------------------
# Tier 2: NHO public warnings page (anonymous HTML, adaptive selectors)
# ----------------------------------------------------------------------------

WARNING_HEADER_RE = re.compile(r"NAVAREA\s+VIII\s*-\s*(\d{3,4}/\d{2})", re.IGNORECASE)


def _clean_html_text(text: str) -> str:
    text = re.sub(r"<script.*?</script>", " ", text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<style.*?</style>", " ", text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "\n", text)
    text = text.replace("&nbsp;", " ").replace("&amp;", "&")
    text = text.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"')
    text = text.replace("&#39;", "'")
    return text


def _parse_mirror_style_text(text: str, source_label: str) -> list[dict[str, Any]]:
    """Extract NAVAREA VIII notices from plain text; shared by tiers 2 and 3."""
    text = _clean_html_text(text)
    notices: list[dict[str, Any]] = []
    parts = re.split(r"(?=NAVAREA\s+VIII\s*-\s*\d{3,4}/\d{2})", text)
    for part in parts:
        m = re.match(
            r"NAVAREA\s+VIII\s*-\s*(\d{3,4}/\d{2})\s*(.*)", part.strip(), re.IGNORECASE
        )
        if not m:
            continue
        identifier = m.group(1)
        message = part.strip()[m.end(1):].strip()
        message = message.split("\n\n")[0].strip() or message
        place_m = re.match(r"([A-Z][A-Z0-9 ,.\-()]*?)(?:\s*\(\.\)|\.)", message)
        notices.append(
            {
                "identifier": identifier,
                "message": message,
                "place": place_m.group(1).strip() if place_m else None,
                "status": "active",
                "dtg": None,
                "b_char": None,
                "types": None,
                "general_area": None,
            }
        )
    if notices:
        log.info("%s yielded %d notice(s)", source_label, len(notices))
    return notices


def fetch_tier2_public_page() -> list[dict[str, Any]]:
    """NHO public /navarea-warnings page via StealthyFetcher."""
    text = _stealthy_fetch(NHO_PUBLIC_URL)
    if not text:
        return []
    notices = _parse_mirror_style_text(text, "Tier 2 (NHO public page, StealthyFetcher)")
    return notices


def fetch_tier3_mirror() -> list[dict[str, Any]]:
    """SeaLagom NAVAREA VIII mirror — anonymous requests fetch."""
    try:
        resp = requests.get(
            MIRROR_URL,
            headers={
                "User-Agent": BROWSER_UA,
                "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
            },
            timeout=30,
        )
        resp.raise_for_status()
    except Exception as e:
        log.warning("Tier 3 mirror fetch failed: %s", e)
        return []
    return _parse_mirror_style_text(resp.text, "Tier 3 (SeaLagom mirror)")


# ----------------------------------------------------------------------------
# Shared transforms (unchanged from previous version)
# ----------------------------------------------------------------------------

def checksum_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def parse_nho_coordinate(value: Any) -> float | None:
    text = str(value).strip().replace(" ", "")
    if not text:
        return None
    negative = text.startswith("-")
    text = text.lstrip("+-")
    parts = text.split(",")
    try:
        if len(parts) == 2 and parts[0] and parts[1]:
            decimal = float(parts[0]) + float(parts[1]) / 60.0
        else:
            decimal = float(text.replace(",", "."))
    except ValueError:
        return None
    return -decimal if negative else decimal


def load_coordinate_list(raw: Any) -> list[dict[str, Any]]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return []
    if not isinstance(raw, list):
        return []
    points: list[dict[str, Any]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        lat = parse_nho_coordinate(entry.get("lat"))
        lon = parse_nho_coordinate(entry.get("long") or entry.get("lon") or entry.get("lng"))
        if lat is not None and lon is not None:
            points.append({"lat": lat, "lon": lon})
    return points


def parse_nho_geometry(feature: Any, coordinates: Any, radius: Any) -> list[dict[str, Any]]:
    kind = str(feature or "").strip().lower()
    points = load_coordinate_list(coordinates)
    if not points:
        return []
    if kind == "point":
        return [{"type": "point", "coords": points}]
    if kind == "circle":
        try:
            radius_nm = float(str(radius).strip())
        except (TypeError, ValueError):
            radius_nm = 0.0
        return [{"type": "circle", "coords": [points[0]], "radius_nm": radius_nm}]
    if kind == "arc":
        return [{"type": "line", "coords": points}]
    return [{"type": "polygon", "coords": points}]


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
        if v is None:
            continue
        text = str(v).strip()
        if text and text != "-":
            return text
    return None


def normalize_identifier(identifier: str) -> str:
    if "/" in identifier:
        number, year = identifier.split("/", 1)
        if len(year) == 2 and year.isdigit():
            year = f"20{year}"
        return f"{number}-{year}"
    return identifier


def group_notices(notices: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    order: list[str] = []
    for notice in notices:
        identifier = str(notice.get("identifier") or "unknown").strip()
        if identifier not in grouped:
            grouped[identifier] = []
            order.append(identifier)
        grouped[identifier].append(notice)

    merged: list[dict[str, Any]] = []
    for identifier in order:
        items = grouped[identifier]
        if len(items) == 1:
            merged.append(items[0])
            continue
        base = dict(items[0])
        spatial: list[dict[str, Any]] = []
        for item in items:
            spatial.extend(
                parse_nho_geometry(
                    item.get("feature"), item.get("coordinates"), item.get("radius")
                )
            )
        dtgs = [str(i.get("dtg")) for i in items if i.get("dtg")]
        if dtgs:
            base["dtg"] = max(dtgs)
        base["_spatial"] = spatial
        merged.append(base)
    return merged


def transform_notice(
    raw: dict[str, Any], spatial_override: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
    identifier = str(raw.get("identifier") or "unknown").strip()
    warning_id = normalize_identifier(identifier)
    notice_type = first_str(raw, ("types", "type"))
    place = first_str(raw, ("place", "location"))
    general_area = first_str(raw, ("general_area", "region"))
    message = str(raw.get("message") or raw.get("text") or "")
    dtg = first_str(raw, ("dtg", "date_time_group", "dateTimeGroup", "date_group"))
    b_char = first_str(raw, ("b_char", "bChar", "broadcast_char", "bch"))
    status = first_str(raw, ("status", "state"))

    if spatial_override is not None:
        spatial = spatial_override
    else:
        spatial = parse_nho_geometry(
            raw.get("feature"), raw.get("coordinates"), raw.get("radius")
        )

    is_cancelled = bool(status) and status.lower() != "active"
    cancellation_text = None
    if is_cancelled:
        _, cancellation_text = detect_cancellation(message)

    evidence_trail: list[dict[str, str]] = []
    if dtg:
        evidence_trail.append({"rule": "nho_json:dtg", "match": dtg[:200]})
    if b_char:
        evidence_trail.append({"rule": "nho_json:b_char", "match": b_char[:200]})
    if place:
        evidence_trail.append({"rule": "nho_json:place", "match": place[:200]})

    parts = [f"NAVAREA VIII {identifier}"]
    for suffix in (notice_type, place, general_area, dtg):
        if suffix:
            parts.append(suffix)
    title = " | ".join(parts)

    now = datetime.now(timezone.utc).isoformat()
    return {
        "warning_id": warning_id,
        "source_id": SOURCE_ID,
        "title": title,
        "raw_text": message,
        "checksum": checksum_text(message),
        "revision": 1,
        "previous_checksum": None,
        "spatial": spatial,
        "spatial_groups": [],
        "evidence_trail": evidence_trail,
        "extraction_method": "nho_json",
        "risk_level": "NORMAL",
        "is_cancelled": is_cancelled,
        "cancellation_text": cancellation_text,
        "valid_until_utc": None,
        "last_seen_at": now,
        "updated_at": now,
    }


def extract_notices(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, list):
        for wrapper in data:
            if isinstance(wrapper, dict) and isinstance(wrapper.get("NavArea"), list):
                return [n for n in wrapper["NavArea"] if isinstance(n, dict)]
        return [n for n in data if isinstance(n, dict)]
    if isinstance(data, dict):
        for key in ("NavArea", "notices", "data", "items", "warnings", "features", "results"):
            val = data.get(key)
            if isinstance(val, list):
                return [n for n in val if isinstance(n, dict)]
    return []


# ----------------------------------------------------------------------------
# Orchestration
# ----------------------------------------------------------------------------

def collect_notices() -> tuple[list[dict[str, Any]], str]:
    tiers = (
        ("portal", fetch_tier1_portal),
        ("nho-public-page", fetch_tier2_public_page),
        ("sealagom-mirror", fetch_tier3_mirror),
    )
    for name, fn in tiers:
        try:
            notices = fn()
        except Exception as e:
            log.warning("Tier '%s' raised: %s", name, e)
            continue
        if notices:
            return notices, name
        log.info("Tier '%s' returned no notices; trying next", name)
    raise SystemExit("All three tiers failed: portal, NHO public page, and mirror.")


def run_probe() -> None:
    log.info("Probe mode: testing all fetch tiers (no data write)")
    for name, fn in (
        ("portal", fetch_tier1_portal),
        ("nho-public-page", fetch_tier2_public_page),
        ("sealagom-mirror", fetch_tier3_mirror),
    ):
        try:
            notices = fn()
            log.info("[probe] %-18s -> %d notice(s)", name, len(notices))
        except Exception as e:
            log.info("[probe] %-18s -> ERROR: %s", name, e)


def run_scrape() -> None:
    supabase_url = require_env("SUPABASE_URL")
    supabase_key = require_env("SUPABASE_KEY")
    notices, tier = collect_notices()
    log.info("Proceeding with %d notice(s) from tier '%s'", len(notices), tier)

    supabase: Client = create_client(supabase_url, supabase_key)
    records = [
        transform_notice(notice, notice.get("_spatial"))
        for notice in group_notices(notices)
    ]
    seen_ids = [r["warning_id"] for r in records]

    batch_size = 50
    upserted = 0
    for i in range(0, len(records), batch_size):
        batch = records[i : i + batch_size]
        try:
            supabase.table("nav_warnings").upsert(
                batch, on_conflict="source_id,warning_id"
            ).execute()
        except Exception as e:
            log.error("Upsert error: %s", e)
            continue
        upserted += len(batch)
        log.info("Upserted batch %d..%d", i, i + len(batch))

    try:
        active = (
            supabase.table("nav_warnings")
            .select("warning_id")
            .eq("source_id", SOURCE_ID)
            .eq("is_cancelled", False)
            .execute()
        )
    except Exception as e:
        raise SystemExit(f"Failed to list active NHO warnings: {e}")
    active_ids = [r["warning_id"] for r in (active.data or [])]
    missing = [wid for wid in active_ids if wid not in seen_ids]
    cancelled = 0
    for i in range(0, len(missing), 100):
        chunk = missing[i : i + 100]
        try:
            supabase.table("nav_warnings").update(
                {
                    "is_cancelled": True,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
            ).eq("source_id", SOURCE_ID).in_("warning_id", chunk).execute()
        except Exception as e:
            log.error("Batch cancel error (%d ids): %s", len(chunk), e)
            continue
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
