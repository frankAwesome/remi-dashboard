#!/usr/bin/env python3
"""
REMI DSP — build the dashboard's data file.

Reads the two sources that say how remidsp.com is actually doing, aggregates
them into one small JSON, encrypts it, and writes it where the static page can
fetch it:

  1. GitHub release asset counters — installers actually fetched, from any
     source, since the first release. Public API; a token only lifts the rate
     limit.

  2. The Firestore analytics written by js/analytics.js — pageviews, downloads,
     clicks and engagement, with geo, referrer and placement. Browser reads are
     blocked by firestore.rules, so this reads with a credential and ships a
     static file. Nothing that can read the database is ever served to a
     visitor.

Almost none of the raw traffic is a person. Your own browsing, the headless QA
runs and a steady drip of scanners dwarf real visitors, so every session is
classified human / automated / self and the dashboard defaults to human. All
four scopes are exported; the toggle in the page is a filter, not a refetch.

    python3 tools/export.py                 # encrypted, to data/metrics.enc.json
    python3 tools/export.py --plain out.json --no-encrypt   # look at it locally
    python3 tools/export.py --days 30       # only the last month

Read-only throughout: it never writes to Firestore, GitHub or the site.

Needs `cryptography` (AES-GCM + the service-account JWT signature); everything
else is stdlib. `pip install -r tools/requirements.txt`.
"""

import argparse
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from centroids import CENTROIDS                                    # noqa: E402

# ── config ──────────────────────────────────────────────────────────────────

PROJECT = "remidsp-98208"
GH_REPO = "frankAwesome/remi-amps-downloads"
SITE = "remidsp.com"

# Traffic to treat as your own. Your dev browsing and headless QA runs are the
# bulk of the database; without this the numbers flatter you.
#
# This is a CITY, not a country. It used to be {"ZA"}, which quietly swallowed
# every South African visitor — including the friends in Pretoria and
# Johannesburg who actually downloaded the plugin. A whole country is not one
# person. Lowercase; compared case-insensitively.
HOME_CITIES = {"cape town"}
BOT_UA = re.compile(r"bot|crawl|spider|headless|phantom|lighthouse", re.I)
LOCAL_HOSTS = {"localhost", "127.0.0.1", "0.0.0.0"}
SESSION_DENYLIST = {"s_rulesprobe"}       # rules-verification writes, not visits

COLLECTIONS = ("pageviews", "downloads", "clicks", "engagement")

# The firebase CLI's own OAuth client. Public constants shipped inside the npm
# package (lib/api.js) — they identify the CLI, they authorise nothing alone.
CLI_CLIENT_ID = "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com"
CLI_CLIENT_SECRET = "j9iVZfS8kkCEFUPaAeJV0sAi"
CONFIGSTORE = os.path.expanduser("~/.config/configstore/firebase-tools.json")

PBKDF2_ITERS = 310_000     # OWASP 2023 floor for PBKDF2-HMAC-SHA256


def die(msg):
    raise SystemExit("export: " + msg)


# ── tiny http helpers ───────────────────────────────────────────────────────

def http_json(url, data=None, headers=None, method=None, retries=3):
    body = None
    hdrs = dict(headers or {})
    if isinstance(data, dict) and method != "FORM":
        body = json.dumps(data).encode()
        hdrs.setdefault("content-type", "application/json")
    elif method == "FORM":
        body = urllib.parse.urlencode(data).encode()
        hdrs.setdefault("content-type", "application/x-www-form-urlencoded")
        method = None

    last = None
    for attempt in range(retries):
        req = urllib.request.Request(url, data=body, headers=hdrs, method=method)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            detail = e.read().decode()[:400]
            # 4xx is a real answer — retrying will not change it.
            if e.code < 500 and e.code != 429:
                raise SystemExit("HTTP %s from %s\n%s" % (e.code, url, detail))
            last = "HTTP %s from %s\n%s" % (e.code, url, detail)
        except urllib.error.URLError as e:
            last = "network error from %s: %s" % (url, e)
        if attempt < retries - 1:
            time.sleep(2 ** attempt)
    die(last or "request failed")


# ── auth ────────────────────────────────────────────────────────────────────

def sa_access_token(info):
    """Service account -> access token. The CI path: read-only, project-scoped."""
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding

    def seg(d):
        return base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=")

    now = int(time.time())
    claim = {
        "iss": info["client_email"],
        "scope": "https://www.googleapis.com/auth/datastore",
        "aud": "https://oauth2.googleapis.com/token",
        "iat": now, "exp": now + 3600,
    }
    signing_input = seg({"alg": "RS256", "typ": "JWT"}) + b"." + seg(claim)
    key = serialization.load_pem_private_key(info["private_key"].encode(), None)
    sig = key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
    jwt = (signing_input + b"." + base64.urlsafe_b64encode(sig).rstrip(b"=")).decode()

    tok = http_json("https://oauth2.googleapis.com/token", {
        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
        "assertion": jwt,
    }, method="FORM")
    if "access_token" not in tok:
        die("service account rejected: %s" % tok.get("error_description", tok))
    return tok["access_token"]


def cli_access_token():
    """Local path: reuse whatever `firebase login` already holds."""
    tok = os.environ.get("REMI_FIREBASE_REFRESH_TOKEN")
    if not tok:
        if not os.path.exists(CONFIGSTORE):
            die("no credential. Set REMI_SA_KEY, or run:  firebase login")
        with open(CONFIGSTORE) as f:
            tok = (json.load(f).get("tokens") or {}).get("refresh_token")
        if not tok:
            die("firebase config has no refresh token. Run:  firebase login --reauth")
    got = http_json("https://oauth2.googleapis.com/token", {
        "client_id": CLI_CLIENT_ID, "client_secret": CLI_CLIENT_SECRET,
        "refresh_token": tok, "grant_type": "refresh_token",
    }, method="FORM")
    if "access_token" not in got:
        die("token refresh failed (%s). Run:  firebase login --reauth"
            % got.get("error", "unknown"))
    return got["access_token"]


def access_token():
    """Service account if one is configured, else the local firebase login."""
    raw = os.environ.get("REMI_SA_KEY")
    path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if raw:
        return sa_access_token(json.loads(raw))
    if path and os.path.exists(path):
        with open(path) as f:
            return sa_access_token(json.load(f))
    return cli_access_token()


def gh_token():
    """Optional — only lifts the anonymous rate limit. Release data is public."""
    for var in ("GITHUB_TOKEN", "GH_TOKEN"):
        if os.environ.get(var):
            return os.environ[var]
    try:
        out = subprocess.run(["gh", "auth", "token"], capture_output=True, timeout=10)
        if out.returncode == 0:
            return out.stdout.decode().strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return None


# ── firestore ───────────────────────────────────────────────────────────────

BASE = ("https://firestore.googleapis.com/v1/projects/%s/databases/(default)"
        "/documents" % PROJECT)


def decode(value):
    """Firestore's typed JSON -> plain Python."""
    if value is None or "nullValue" in value:
        return None
    for key in ("stringValue", "booleanValue", "timestampValue", "doubleValue"):
        if key in value:
            return value[key]
    if "integerValue" in value:
        return int(value["integerValue"])
    if "mapValue" in value:
        return {k: decode(v) for k, v in (value["mapValue"].get("fields") or {}).items()}
    if "arrayValue" in value:
        return [decode(v) for v in (value["arrayValue"].get("values") or [])]
    return None


def ts_filter(since):
    return {"fieldFilter": {
        "field": {"fieldPath": "ts"},
        "op": "GREATER_THAN",
        "value": {"timestampValue": since.strftime("%Y-%m-%dT%H:%M:%SZ")},
    }}


class Firestore(object):
    def __init__(self, token):
        self.headers = {"authorization": "Bearer " + token}

    def fetch(self, collection, since=None, page=1000, cap=200000):
        """Every document, newest first, paged on (ts, __name__) so ties are safe."""
        docs, cursor = [], None
        while len(docs) < cap:
            query = {
                "from": [{"collectionId": collection}],
                "orderBy": [
                    {"field": {"fieldPath": "ts"}, "direction": "DESCENDING"},
                    {"field": {"fieldPath": "__name__"}, "direction": "DESCENDING"},
                ],
                "limit": page,
            }
            if since:
                query["where"] = ts_filter(since)
            if cursor:
                query["startAt"] = {"values": cursor, "before": False}

            rows = [r for r in http_json(BASE + ":runQuery",
                                         {"structuredQuery": query}, self.headers)
                    if r.get("document")]
            if not rows:
                break
            for r in rows:
                doc = decode({"mapValue": {"fields": r["document"].get("fields") or {}}})
                docs.append(doc)
            if len(rows) < page:
                break
            last = rows[-1]["document"]
            cursor = [
                (last.get("fields") or {}).get("ts", {"nullValue": None}),
                {"referenceValue": last["name"]},
            ]
        return docs


# ── github ──────────────────────────────────────────────────────────────────

def releases():
    headers = {"accept": "application/vnd.github+json",
               "user-agent": "remidsp-dashboard"}
    tok = gh_token()
    if tok:
        headers["authorization"] = "Bearer " + tok
    return http_json("https://api.github.com/repos/%s/releases?per_page=100" % GH_REPO,
                     headers=headers)


# ── time ────────────────────────────────────────────────────────────────────

def parse_ts(raw):
    """Firestore RFC3339 -> aware datetime. Python 3.9 can't do the Z suffix."""
    if not raw:
        return None
    text = raw.replace("Z", "+00:00")
    if "." in text:                       # trim to microseconds; fromisoformat is fussy
        head, rest = text.split(".", 1)
        frac, tz = re.match(r"(\d*)(.*)", rest).groups()
        text = "%s.%s%s" % (head, (frac + "000000")[:6], tz)
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def day_of(doc):
    dt = parse_ts(doc.get("ts")) or parse_ts(doc.get("clientTs"))
    return dt.strftime("%Y-%m-%d") if dt else None


def hour_of(doc):
    """Hour in the *visitor's* zone — when they were awake, not when you were."""
    dt = parse_ts(doc.get("ts")) or parse_ts(doc.get("clientTs"))
    if not dt:
        return None
    tz = (doc.get("device") or {}).get("tz")
    if tz:
        try:
            from zoneinfo import ZoneInfo
            return dt.astimezone(ZoneInfo(tz)).hour
        except Exception:
            pass
    return dt.hour


# ── classification ──────────────────────────────────────────────────────────
#
# Verdicts are assigned per *session*, not per document, so a download inherits
# the verdict of the visit it belongs to and can't be judged on its own thinner
# evidence.
#
# HARD signals are self-contradictions a real browser cannot produce — a
# viewport larger than the screen it sits in, an iPhone user-agent that reports
# itself as not mobile. One is enough.
#
# SOFT signals are merely odd. A VPN is not a crawler and plenty of real people
# use one, so no soft signal convicts alone; two together do.

SELF, AUTOMATED, HUMAN = "self", "automated", "human"
SCOPES = (HUMAN, AUTOMATED, SELF, "all")

HEADLESS_SCREENS = {(800, 600), (1024, 768)}     # default virtual framebuffers
PHONE_UA = re.compile(r"iphone|android|ipad|mobile safari", re.I)

# A machine with no timezone configured — a container, near enough always.
# Real browsers report a named zone; even Britain in winter says Europe/London.
SERVER_TZ = {"UTC", "Etc/UTC", "Etc/Unknown", "Etc/GMT", "GMT"}


def tz_offset(name):
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo(name)).utcoffset()
    except Exception:
        return None


def tz_disagrees(browser, geo_tz):
    """True only when two zones genuinely differ.

    Compared by offset, not by name: Asia/Calcutta and Asia/Kolkata are the
    same place and an earlier version of this convicted a real visitor in
    India over the alias.
    """
    if not browser or not geo_tz or browser == geo_tz:
        return False
    a, b = tz_offset(browser), tz_offset(geo_tz)
    if a is None or b is None:
        return False
    return a != b


def session_signals(docs):
    hard, soft = [], []
    dev = next((d.get("device") or {} for d in docs if d.get("device")), {})
    geo = next((d.get("geo") or {} for d in docs if d.get("geo")), {})
    ua = dev.get("ua") or ""
    sw, sh = dev.get("screenW"), dev.get("screenH")
    vw, vh = dev.get("viewW"), dev.get("viewH")
    mobile = bool(dev.get("mobile"))
    dpr = dev.get("dpr")

    if BOT_UA.search(ua):
        hard.append("self-declared bot UA")
    if all(isinstance(v, int) for v in (sw, sh, vw, vh)) and (vw > sw or vh > sh):
        hard.append("viewport %dx%d exceeds screen %dx%d" % (vw, vh, sw, sh))
    if isinstance(sw, int) and sw == sh and sw >= 1000:
        hard.append("square %dx%d screen" % (sw, sh))
    if PHONE_UA.search(ua) and not mobile:
        hard.append("phone UA but not a touch device")
    if isinstance(sw, int) and sw < 500 and not mobile:
        hard.append("phone-sized screen but not a touch device")
    if dev.get("tz") in SERVER_TZ:
        hard.append("unconfigured timezone (%s)" % dev["tz"])

    if (sw, sh) in HEADLESS_SCREENS:
        soft.append("%dx%d headless default screen" % (sw, sh))
    if tz_disagrees(dev.get("tz"), geo.get("tz")):
        soft.append("browser tz %s != geo tz %s" % (dev["tz"], geo["tz"]))
    if isinstance(sw, int) and sw < 500 and dpr == 1:
        soft.append("phone-sized screen at dpr=1")
    if len(docs) == 1 and docs[0].get("_collection") == "pageviews":
        soft.append("single pageview, no interaction")
    return hard, soft


def classify(docs):
    """One verdict for one session, weakest evidence considered last.

    Order matters and used to be wrong. Location was checked first, so a
    crawler that resolved to your own city was filed as you and never even
    tested for automation — which is how a burst of link-preview bots hitting
    Johannesburg ended up counted as the site owner browsing his own page.

    Certain facts first (a test session, a localhost host), then actual
    evidence of automation, and only then geography — which is a guess about
    who someone is, not an observation about what they did.
    """
    first = docs[0]

    # ── certain ──
    if first.get("session") in SESSION_DENYLIST:
        return SELF, ["denylisted test session"]
    if any((d.get("page") or {}).get("host") in LOCAL_HOSTS for d in docs):
        return SELF, ["localhost"]

    # ── evidence ──
    hard, soft = session_signals(docs)
    if hard:
        return AUTOMATED, hard + soft
    if len(soft) >= 2:
        return AUTOMATED, soft

    # ── geography, the weakest of the three ──
    geo = next((d.get("geo") or {} for d in docs if (d.get("geo") or {}).get("country")), {})
    if (geo.get("city") or "").strip().lower() in HOME_CITIES:
        return SELF, ["home city %s" % geo.get("city")] + soft

    return HUMAN, soft or ["no anomalies"]


def verdicts(data):
    """session id -> (verdict, reasons), judged across every collection at once."""
    by_session = defaultdict(list)
    for name, docs in data.items():
        for d in docs:
            d["_collection"] = name
            by_session[d.get("session")].append(d)
    out = {}
    for sid, docs in by_session.items():
        docs.sort(key=lambda d: d.get("ts") or "")
        out[sid] = classify(docs)
    return out


# ── geo ─────────────────────────────────────────────────────────────────────

def coords(doc):
    """(lat, lon, exact) for a document, or None when it cannot be placed.

    Rows written before schema 2 carry no coordinates, so they fall back to the
    centroid of their country. The dashboard draws those hollow — a pin that is
    'somewhere in the United States' should not look like a street address.
    """
    g = doc.get("geo") or {}
    lat, lon = g.get("lat"), g.get("lon")
    if isinstance(lat, (int, float)) and isinstance(lon, (int, float)):
        return round(float(lat), 2), round(float(lon), 2), True
    hit = CENTROIDS.get(g.get("country") or "")
    if hit:
        return hit[0], hit[1], False
    return None


# ── aggregation ─────────────────────────────────────────────────────────────

def top(counter, limit=14):
    return [{"label": k, "n": v} for k, v in counter.most_common(limit)]


def browser_of(ua):
    """Coarse family only. Never the full UA — that goes nowhere near the page."""
    if not ua:
        return "unknown"
    for pat, name in ((r"Edg/", "Edge"), (r"OPR/|Opera", "Opera"),
                      (r"Firefox/", "Firefox"), (r"CriOS/|Chrome/", "Chrome"),
                      (r"Safari/", "Safari")):
        if re.search(pat, ua):
            return name
    return "other"


def os_of(ua, platform):
    hay = "%s %s" % (ua or "", platform or "")
    for pat, name in ((r"iPhone|iPad|iOS", "iOS"), (r"Android", "Android"),
                      (r"Mac OS X|macOS|Macintosh", "macOS"),
                      (r"Windows", "Windows"), (r"Linux|X11", "Linux")):
        if re.search(pat, hay, re.I):
            return name
    return "other"


def referrer_of(doc):
    raw = (doc.get("page") or {}).get("referrer")
    if not raw:
        return "(direct)"
    try:
        host = urllib.parse.urlparse(raw).netloc.lower()
    except ValueError:
        return "(direct)"
    if not host:
        return "(direct)"
    host = host[4:] if host.startswith("www.") else host
    return SITE if host.endswith(SITE) else host


def build_scope(scope, data, seen, days_index):
    """Everything the dashboard shows for one traffic scope."""
    def keep(d):
        return scope == "all" or seen.get(d.get("session"), (HUMAN, []))[0] == scope

    pv = [d for d in data["pageviews"] if keep(d)]
    dl = [d for d in data["downloads"] if keep(d)]
    ck = [d for d in data["clicks"] if keep(d)]
    en = [d for d in data["engagement"] if keep(d)]

    sessions = {d.get("session") for d in pv}
    dl_sessions = {d.get("session") for d in dl}

    # ── time series, zero-filled so the chart has no invisible gaps ──
    per_day = {d: {"date": d, "pageviews": 0, "downloads": 0,
                   "clicks": 0, "sessions": 0} for d in days_index}
    seen_day_sessions = defaultdict(set)
    for docs, key in ((pv, "pageviews"), (dl, "downloads"), (ck, "clicks")):
        for d in docs:
            day = day_of(d)
            if day in per_day:
                per_day[day][key] += 1
    for d in pv:
        day = day_of(d)
        if day in per_day:
            seen_day_sessions[day].add(d.get("session"))
    for day, sids in seen_day_sessions.items():
        per_day[day]["sessions"] = len(sids)

    hours = [0] * 24
    for d in pv:
        h = hour_of(d)
        if h is not None:
            hours[h] += 1

    # ── places ──
    countries = defaultdict(lambda: {"pageviews": 0, "downloads": 0, "name": None})
    for docs, key in ((pv, "pageviews"), (dl, "downloads")):
        for d in docs:
            g = d.get("geo") or {}
            code = g.get("country")
            if not code:
                continue
            countries[code][key] += 1
            countries[code]["name"] = countries[code]["name"] or g.get("countryName") or code

    # Grouped by (position, precision). Precision is part of the key on purpose:
    # a centroid pin and a real pin must never merge, because merging would let
    # one exact city name label a dot that is really "somewhere in this country".
    # Inexact pins are therefore never given a city at all — every US row
    # collapses to the same point in Kansas, and calling that point "Quincy"
    # because Quincy happened to be first would be a straight-up lie.
    places = defaultdict(lambda: {"pageviews": 0, "downloads": 0,
                                  "city": None, "country": None, "countryName": None,
                                  "lat": None, "lon": None, "exact": False})
    for docs, key in ((pv, "pageviews"), (dl, "downloads")):
        for d in docs:
            got = coords(d)
            if not got:
                continue
            lat, lon, exact = got
            g = d.get("geo") or {}
            slot = places[(round(lat, 1), round(lon, 1), exact)]
            slot[key] += 1
            slot["country"] = slot["country"] or g.get("country")
            slot["countryName"] = slot["countryName"] or g.get("countryName")
            if exact:
                slot["city"] = slot["city"] or g.get("city")
            slot["lat"], slot["lon"], slot["exact"] = lat, lon, exact

    # ── engagement ──
    dwells = [d["dwellMs"] for d in en if isinstance(d.get("dwellMs"), (int, float))
              and d["dwellMs"] > 0]
    scrolls = [d["maxScroll"] for d in en if isinstance(d.get("maxScroll"), (int, float))]
    dwells.sort()

    return {
        "totals": {
            "pageviews": len(pv), "sessions": len(sessions),
            "downloads": len(dl), "clicks": len(ck), "visits": len(en),
        },
        "downloadRate": (len(dl_sessions) / len(sessions)) if sessions else 0.0,
        "engagement": {
            "medianDwellMs": dwells[len(dwells) // 2] if dwells else 0,
            "avgScroll": (sum(scrolls) / len(scrolls)) if scrolls else 0.0,
            "readThrough": (sum(1 for s in scrolls if s >= 0.9) / len(scrolls))
                           if scrolls else 0.0,
            "sections": top(Counter(d.get("section") for d in en if d.get("section")), 12),
        },
        "byDay": [per_day[d] for d in days_index],
        "byHour": hours,
        "countries": sorted(
            [{"code": c, "name": v["name"] or c,
              "pageviews": v["pageviews"], "downloads": v["downloads"]}
             for c, v in countries.items()],
            key=lambda r: (-r["pageviews"], r["code"]))[:60],
        "places": sorted(places.values(),
                         key=lambda p: -(p["downloads"] * 10 + p["pageviews"]))[:400],
        "referrers": top(Counter(referrer_of(d) for d in pv)),
        "campaigns": top(Counter(
            "%s / %s" % ((d.get("utm") or {}).get("source"),
                         (d.get("utm") or {}).get("medium") or "—")
            for d in pv if (d.get("utm") or {}).get("source"))),
        "downloadOs": top(Counter(d.get("os") or "unknown" for d in dl)),
        "downloadAssets": top(Counter(d.get("asset") for d in dl if d.get("asset"))),
        "downloadPlacements": top(Counter(d.get("placement") or "—" for d in dl)),
        "clickLabels": top(Counter(d.get("label") for d in ck if d.get("label"))),
        "clickPlacements": top(Counter(d.get("placement") or "—" for d in ck)),
        "clickKinds": top(Counter(d.get("kind") or "—" for d in ck), 6),
        "browsers": top(Counter(browser_of((d.get("device") or {}).get("ua")) for d in pv), 8),
        "platforms": top(Counter(os_of((d.get("device") or {}).get("ua"),
                                       (d.get("device") or {}).get("platform"))
                                 for d in pv), 8),
        "devices": {
            "mobile": sum(1 for d in pv if (d.get("device") or {}).get("mobile")),
            "desktop": sum(1 for d in pv if not (d.get("device") or {}).get("mobile")),
        },
        "recentDownloads": [
            {
                "ts": d.get("ts"),
                "os": d.get("os") or "?",
                "asset": d.get("asset") or "?",
                "city": (d.get("geo") or {}).get("city"),
                "country": (d.get("geo") or {}).get("country"),
                "placement": d.get("placement") or "—",
                "verdict": seen.get(d.get("session"), (HUMAN, []))[0],
            }
            for d in dl[:60]
        ],
    }


def build_releases(rels):
    rows, mac_total, win_total, other_total = [], 0, 0, 0
    for rel in rels:
        assets = rel.get("assets") or []
        mac = sum(a["download_count"] for a in assets
                  if re.search(r"\.(pkg|dmg)$", a["name"], re.I))
        win = sum(a["download_count"] for a in assets
                  if re.search(r"\.(exe|msi)$", a["name"], re.I))
        total = sum(a["download_count"] for a in assets)
        mac_total += mac
        win_total += win
        other_total += total - mac - win
        rows.append({"tag": rel["tag_name"],
                     "published": (rel.get("published_at") or "")[:10],
                     "macos": mac, "windows": win, "total": total})
    rows.sort(key=lambda r: r["published"], reverse=True)
    return {
        "repo": GH_REPO,
        "total": mac_total + win_total + other_total,
        "macos": mac_total, "windows": win_total, "other": other_total,
        "current": rows[0]["tag"] if rows else None,
        "byRelease": rows,
    }


# ── encryption ──────────────────────────────────────────────────────────────

def encrypt(plaintext, passphrase):
    """AES-256-GCM under a PBKDF2 key — decryptable by WebCrypto in the page.

    The dashboard is served from a public GitHub Pages site, so the bytes are
    fetchable by anyone. The passphrase is what makes them meaningless without
    it; the salt and iteration count travel with the file so the page needs no
    configuration to unlock it.
    """
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    salt = os.urandom(16)
    iv = os.urandom(12)
    key = hashlib.pbkdf2_hmac("sha256", passphrase.encode(), salt, PBKDF2_ITERS, 32)
    ct = AESGCM(key).encrypt(iv, plaintext.encode(), None)
    b64 = lambda b: base64.b64encode(b).decode()
    return {
        "v": 1, "kdf": "PBKDF2-SHA256", "iter": PBKDF2_ITERS,
        "cipher": "AES-GCM", "salt": b64(salt), "iv": b64(iv), "ct": b64(ct),
    }


# ── main ────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="Build the REMI DSP dashboard data file")
    ap.add_argument("--days", type=int, default=0,
                    help="only look this far back (default: all history)")
    ap.add_argument("--out", default="data/metrics.enc.json",
                    help="where the encrypted file goes")
    ap.add_argument("--plain", metavar="FILE",
                    help="also write the unencrypted JSON here (do not commit it)")
    ap.add_argument("--no-encrypt", action="store_true",
                    help="skip encryption; requires --plain")
    args = ap.parse_args()

    if args.no_encrypt and not args.plain:
        die("--no-encrypt needs --plain FILE to write to")

    passphrase = os.environ.get("REMI_DASH_PASSPHRASE")
    if not args.no_encrypt and not passphrase:
        die("set REMI_DASH_PASSPHRASE (or use --no-encrypt --plain out.json)")

    since = datetime.now(timezone.utc) - timedelta(days=args.days) if args.days else None

    sys.stderr.write("reading GitHub releases ...\n")
    rel = build_releases(releases())

    sys.stderr.write("reading Firestore ...\n")
    fs = Firestore(access_token())
    data = {}
    for name in COLLECTIONS:
        data[name] = fs.fetch(name, since)
        sys.stderr.write("  %-12s %6d\n" % (name, len(data[name])))

    seen = verdicts(data)

    # A continuous day axis across every collection, so all four scopes and
    # every series share one x-axis and gaps read as zero rather than vanishing.
    all_days = sorted({day_of(d) for docs in data.values() for d in docs} - {None})
    days_index = all_days
    if all_days:
        start = datetime.strptime(all_days[0], "%Y-%m-%d")
        end = datetime.strptime(all_days[-1], "%Y-%m-%d")
        days_index = [(start + timedelta(days=i)).strftime("%Y-%m-%d")
                      for i in range((end - start).days + 1)]

    counts = Counter(v for v, _ in seen.values())
    payload = {
        "schemaVersion": 1,
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "site": SITE,
        "window": {
            "first": all_days[0] if all_days else None,
            "last": all_days[-1] if all_days else None,
            "days": len(days_index),
            "requestedDays": args.days or None,
        },
        "releases": rel,
        "sessionVerdicts": {"human": counts[HUMAN], "automated": counts[AUTOMATED],
                            "self": counts[SELF], "total": len(seen)},
        "scopes": {s: build_scope(s, data, seen, days_index) for s in SCOPES},
    }

    text = json.dumps(payload, separators=(",", ":"), sort_keys=True)

    if args.plain:
        os.makedirs(os.path.dirname(os.path.abspath(args.plain)), exist_ok=True)
        with open(args.plain, "w") as f:
            f.write(text)
        sys.stderr.write("wrote %s  (%.0f KB, PLAINTEXT)\n"
                         % (args.plain, len(text) / 1024.0))

    if not args.no_encrypt:
        blob = encrypt(text, passphrase)
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w") as f:
            json.dump(blob, f)
        sys.stderr.write("wrote %s  (%.0f KB encrypted, from %.0f KB)\n"
                         % (args.out, os.path.getsize(args.out) / 1024.0,
                            len(text) / 1024.0))

    sys.stderr.write("sessions: %d human · %d automated · %d self\n"
                     % (counts[HUMAN], counts[AUTOMATED], counts[SELF]))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
