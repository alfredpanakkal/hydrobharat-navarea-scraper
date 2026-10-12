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
NHO_TOKEN_URL = f"{NHO_BASE}/o/oauth2/token"
LIFERAY_API_BASE = f"{NHO_BASE}/o/headless-delivery/v1.0"
LIFERAY_TEST_PATH = "/document-folders/288109/documents?page=1&pageSize=1"
SOURCE_ID = "nho-portal"
# Mirror of NHO NAVAREA VIII bulletins (free full-content page), used as a
# fallback when the NHO portal credentials are unavailable or rejected.
MIRROR_URL = "https://www.sealagom.com/navarea/8/"


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


def basic_auth_header(user: str, password: str) -> str:
    token = base64.b64encode(f"{user}:{password}".encode("utf-8")).decode("ascii")
    return f"Basic {token}"


def resolve_auth_headers(session: requests.Session) -> dict[str, str]:
    user = os.environ.get("LIFERAY_USER")
    password = os.environ.get("LIFERAY_PASS")
    if user and password:
        log.info("Using HTTP Basic auth (LIFERAY_USER / LIFERAY_PASS)")
        return {"Authorization": basic_auth_header(user, password)}

    client_id = os.environ.get("NHO_CLIENT_ID")
    client_secret = os.environ.get("NHO_CLIENT_SECRET")
    if client_id and client_secret:
        token = fetch_oauth_token(session, client_id, client_secret)
        return {"Authorization": f"Bearer {token}"}

    raise SystemExit(
        "No NHO credentials configured. Set LIFERAY_USER/LIFERAY_PASS "
        "(HTTP Basic, preferred) or NHO_CLIENT_ID/NHO_CLIENT_SECRET "
        "(OAuth2 client_credentials) and re-run."
    )


def fetch_oauth_token(
    session: requests.Session, client_id: str, client_secret: str
) -> str:
    log.info("Requesting OAuth2 access token (client_credentials)...")
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
    except requests.RequestException as e:
        raise SystemExit(f"OAuth2 token request failed: {e}")
    if resp.status_code >= 400:
        raise SystemExit(
            f"OAuth2 token endpoint returned HTTP {resp.status_code}: "
            f"{resp.text[:200]}"
        )
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


def fetch_combined_data(
    session: requests.Session, auth_headers: dict[str, str]
) -> Any:
    try:
        resp = session.get(
            NHO_MAP_URL,
            headers={**auth_headers, "Accept": "application/json"},
            timeout=60,
        )
    except requests.RequestException as e:
        raise SystemExit(f"GET {NHO_MAP_URL} failed: {e}")
    if resp.status_code >= 400:
        raise SystemExit(
            f"NHO endpoint returned HTTP {resp.status_code} for {NHO_MAP_URL}: "
            f"{resp.text[:200]}"
        )
    try:
        return resp.json()
    except ValueError:
        raise SystemExit(f"Unexpected non-JSON response from {NHO_MAP_URL}")


def fetch_from_mirror() -> list[dict[str, Any]]:
    """
    Fallback source: SeaLagom mirror of the official NHO NAVAREA VIII bulletins.
    Returns a list of notice dicts shaped like the NHO JSON records so the
    downstream transform_notice/group_notices pipeline works unchanged.
    """
    log.info("Falling back to mirror: %s", MIRROR_URL)
    resp = requests.get(
        MIRROR_URL,
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        },
        timeout=30,
    )
    resp.raise_for_status()

    text = resp.text
    text = re.sub(r"<script.*?</script>", " ", text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<style.*?</style>", " ", text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "\n", text)
    text = text.replace("&nbsp;", " ").replace("&amp;", "&")
    text = text.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"')
    text = text.replace("&#39;", "'")
    text = re.sub(r"[ \t]+", " ", text)

    # Split on each warning header: "NAVAREA VIII -1028/26" / "NAVAREA VIII -161/23"
    parts = re.split(r"(?=NAVAREA\s+VIII\s*-\d{3,4}/\d{2})", text)
    notices: list[dict[str, Any]] = []
    header_re = re.compile(r"NAVAREA\s+VIII\s*-(\d{3,4}/\d{2})\s*(.*)", re.IGNORECASE)
    for part in parts:
        part = part.strip()
        m = header_re.match(part)
        if not m:
            continue
        identifier = m.group(1)
        message = part[m.start(2):].strip()
        # Trim trailing page chrome: cut at blank-line boundaries near nav text end
        message = message.split("\n\n")[0].strip() or message
        # Place: first segment of the body up to "(.)" or first period block
        place_m = re.match(r"([A-Z][A-Z0-9 ,.\-()]*?)(?:\s*\(\.\)|\.)", message)
        place = place_m.group(1).strip() if place_m else None
        notices.append(
            {
                "identifier": identifier,
                "message": message,
                "place": place,
                "status": "active",
                "dtg": None,
                "b_char": None,
                "types": None,
                "general_area": None,
            }
        )

    if not notices:
        raise SystemExit(
            f"Mirror page fetched but no NAVAREA VIII bulletins extracted from {MIRROR_URL}"
        )
    log.info("Mirror yielded %d notice(s)", len(notices))
    return notices


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
        lon = parse_nho_coordinate(
            entry.get("long") or entry.get("lon") or entry.get("lng")
        )
        if lat is not None and lon is not None:
            points.append({"lat": lat, "lon": lon})
    return points


def parse_nho_geometry(
    feature: Any, coordinates: Any, radius: Any
) -> list[dict[str, Any]]:
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


def run_probe() -> None:
    log.info("Probe mode: testing auth options for %s", NHO_MAP_URL)
    session = requests.Session()
    session.headers.update({"User-Agent": "navarea-nho-scraper/1.0"})

    results: list[tuple[str, requests.Response | None]] = []

    resp = try_get(session, NHO_MAP_URL)
    results.append(("anonymous GET nho-headless/map/combined", resp))

    user = os.environ.get("LIFERAY_USER")
    password = os.environ.get("LIFERAY_PASS")
    if user and password:
        auth = basic_auth_header(user, password)
        resp = try_get(session, NHO_MAP_URL, {"Authorization": auth})
        results.append(("Basic LIFERAY_* on nho-headless/map/combined", resp))
        resp = try_get(
            session,
            LIFERAY_API_BASE + LIFERAY_TEST_PATH,
            {"Authorization": auth, "Accept": "application/json"},
        )
        results.append(("Basic LIFERAY_* on headless-delivery control", resp))
    else:
        log.info("LIFERAY_USER/LIFERAY_PASS not set; skipping Basic probes")

    client_id = os.environ.get("NHO_CLIENT_ID")
    client_secret = os.environ.get("NHO_CLIENT_SECRET")
    if client_id and client_secret:
        resp = try_post_token(session, client_id, client_secret)
        results.append(("OAuth client_credentials via NHO_* secrets", resp))
    else:
        log.info("NHO_CLIENT_ID/NHO_CLIENT_SECRET not set; skipping OAuth probe")

    log.info("---- auth probe results ----")
    working_auth: dict[str, str] | None = None
    for label, resp in results:
        if resp is None:
            log.info("%-48s -> network error", label)
            continue
        snippet = (resp.text or "")[:160].replace("\n", " ").strip()
        log.info("%-48s -> HTTP %s | %s", label, resp.status_code, snippet)
        if resp.status_code == 200 and "LIFERAY" in label:
            working_auth = {"Authorization": basic_auth_header(user, password)}

    if working_auth:
        dump_raw_response(session, working_auth)


def dump_raw_response(
    session: requests.Session, headers: dict[str, str]
) -> None:
    resp = try_get(session, NHO_MAP_URL, headers)
    if resp is None:
        log.error("Re-fetch for raw dump failed")
        return
    log.info("Raw response: HTTP %s, %d bytes", resp.status_code, len(resp.content))
    out_dir = os.path.join(os.getcwd(), "recon")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "nho-combined.json")
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(resp.text)
    log.info("Wrote raw response to %s", out_path)
    log.info("Head: %s", resp.text[:500])


def try_get(
    session: requests.Session, url: str, headers: dict[str, str] | None = None
) -> requests.Response | None:
    try:
        return session.get(url, headers=headers or {}, timeout=30)
    except requests.RequestException as e:
        log.error("GET %s failed: %s", url, e)
        return None


def try_post_token(
    session: requests.Session, client_id: str, client_secret: str
) -> requests.Response | None:
    try:
        return session.post(
            NHO_TOKEN_URL,
            data={
                "grant_type": "client_credentials",
                "client_id": client_id,
                "client_secret": client_secret,
            },
            headers={"Accept": "application/json"},
            timeout=30,
        )
    except requests.RequestException as e:
        log.error("POST %s failed: %s", NHO_TOKEN_URL, e)
        return None


def run_scrape() -> None:
    supabase_url = require_env("SUPABASE_URL")
    supabase_key = require_supabase_key()
    supabase: Client = create_client(supabase_url, supabase_key)

    session = requests.Session()
    session.headers.update({"User-Agent": "navarea-nho-scraper/1.0"})

    # Stage 1: primary source (NHO portal, requires credentials)
    notices: list[dict[str, Any]] = []
    try:
        auth_headers = resolve_auth_headers(session)
        data = fetch_combined_data(session, auth_headers)
        notices = extract_notices(data)
        if notices:
            log.info("Fetched %d notice(s) from NHO portal", len(notices))
        else:
            log.warning(
                "NHO portal returned no notices (keys: %s)",
                list(data.keys()) if isinstance(data, dict) else type(data),
            )
    except SystemExit as e:
        log.warning("NHO portal unavailable: %s", e)

    # Stage 2: mirror fallback (anonymous)
    if not notices:
        try:
            notices = fetch_from_mirror()
        except Exception as e:
            log.error("Mirror also unavailable: %s", e)

    if not notices:
        raise SystemExit(
            "All sources failed: no NHO credentials and mirror fetch failed."
        )

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
