/* ══════════════════════════════════════════════════════════════
   Aggregation — the same shape tools/export.py used to produce.

   When the dashboard read a pre-built file, Python did this work. Reading
   Firestore live means it has to happen here instead, and it has to agree
   with the Python exactly or the numbers would change meaning the day the
   transport changed. This is a deliberate line-for-line port: same signals,
   same thresholds, same verdict order, same output object — so js/dash.js,
   js/charts.js and js/map.js did not have to change at all.

   tools/export.py is still the reference implementation and is still worth
   keeping: it is how you get the numbers without a browser. If you change a
   rule in one, change it in the other.
   ══════════════════════════════════════════════════════════════ */

import { CENTROIDS } from "./world.js";

export const SITE = "remidsp.com";

/* ── classification config — mirrors export.py ───────────────── */

// A CITY, not a country. It was {"ZA"} once, which counted every South African
// visitor as the site owner — including the friends in Pretoria and
// Johannesburg who actually downloaded. A country is not one person.
const HOME_CITIES = new Set(["cape town"]);
const BOT_UA = /bot|crawl|spider|headless|phantom|lighthouse/i;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0"]);
const SESSION_DENYLIST = new Set(["s_rulesprobe"]);

const HEADLESS_SCREENS = new Set(["800x600", "1024x768"]);
const PHONE_UA = /iphone|android|ipad|mobile safari/i;
const SERVER_TZ = new Set(["UTC", "Etc/UTC", "Etc/Unknown", "Etc/GMT", "GMT"]);

export const SELF = "self", AUTOMATED = "automated", HUMAN = "human";
export const SCOPES = [HUMAN, AUTOMATED, SELF, "all"];
export const COLLECTIONS = ["pageviews", "downloads", "clicks", "engagement"];

const isNum = v => typeof v === "number" && isFinite(v);
const isInt = v => Number.isInteger(v);

/* ── time ───────────────────────────────────────────────────── */

const parseTs = raw => {
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d) ? null : d;
};

const dayOf = doc => {
  const d = parseTs(doc.ts) || parseTs(doc.clientTs);
  if (!d) return null;
  // Local calendar day, not UTC — a chart of "days" that silently shifts by a
  // timezone puts evening traffic on tomorrow.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${
    String(d.getDate()).padStart(2, "0")}`;
};

/* Hour in the *visitor's* zone — when they were awake, not when you were.

   hourCycle:"h23", not hour12:false — the latter resolves to h24 in several
   implementations, which renders midnight as "24" and drops it off the chart.

   When the visitor's zone is unknown the fallback is UTC, deliberately: the
   viewer's own local time would make the same document land in a different
   bar depending on who opened the dashboard. */
function hourOf(doc) {
  const d = parseTs(doc.ts) || parseTs(doc.clientTs);
  if (!d) return null;
  const tz = doc.device?.tz;
  if (tz) {
    try {
      return +new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23",
                                                 timeZone: tz }).format(d);
    } catch { /* unknown zone — fall through to UTC */ }
  }
  return d.getUTCHours();
}

/* ── timezone comparison ────────────────────────────────────── */

function tzOffset(name) {
  try {
    // Round-trip a fixed instant through the zone to recover its offset.
    const at = new Date("2026-01-15T12:00:00Z");
    const parts = new Intl.DateTimeFormat("en", {
      timeZone: name, timeZoneName: "longOffset",
    }).formatToParts(at).find(p => p.type === "timeZoneName")?.value || "";
    const m = parts.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (!m) return parts === "GMT" ? 0 : null;
    return (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + (+(m[3] || 0)));
  } catch { return null; }
}

/* True only when two zones genuinely differ. Compared by offset, not by name:
   Asia/Calcutta and Asia/Kolkata are the same place, and an earlier version of
   this convicted a real visitor in India over the alias. */
function tzDisagrees(browser, geoTz) {
  if (!browser || !geoTz || browser === geoTz) return false;
  const a = tzOffset(browser), b = tzOffset(geoTz);
  if (a === null || b === null) return false;
  return a !== b;
}

/* ── signals ────────────────────────────────────────────────── */

function sessionSignals(docs) {
  const hard = [], soft = [];
  const dev = docs.find(d => d.device)?.device || {};
  const geo = docs.find(d => d.geo)?.geo || {};
  const ua = dev.ua || "";
  const { screenW: sw, screenH: sh, viewW: vw, viewH: vh, dpr } = dev;
  const mobile = !!dev.mobile;

  if (BOT_UA.test(ua)) hard.push("self-declared bot UA");
  if ([sw, sh, vw, vh].every(isInt) && (vw > sw || vh > sh))
    hard.push(`viewport ${vw}x${vh} exceeds screen ${sw}x${sh}`);
  if (isInt(sw) && sw === sh && sw >= 1000) hard.push(`square ${sw}x${sh} screen`);
  if (PHONE_UA.test(ua) && !mobile) hard.push("phone UA but not a touch device");
  if (isInt(sw) && sw < 500 && !mobile)
    hard.push("phone-sized screen but not a touch device");
  if (SERVER_TZ.has(dev.tz)) hard.push(`unconfigured timezone (${dev.tz})`);

  if (HEADLESS_SCREENS.has(`${sw}x${sh}`))
    soft.push(`${sw}x${sh} headless default screen`);
  if (tzDisagrees(dev.tz, geo.tz))
    soft.push(`browser tz ${dev.tz} != geo tz ${geo.tz}`);
  if (isInt(sw) && sw < 500 && dpr === 1) soft.push("phone-sized screen at dpr=1");
  if (docs.length === 1 && docs[0]._collection === "pageviews")
    soft.push("single pageview, no interaction");
  return [hard, soft];
}

/* One verdict for one session, weakest evidence considered last.

   Order matters and used to be wrong. Location was checked first, so a crawler
   that resolved to your own city was filed as you and never even tested for
   automation — which is how a burst of link-preview bots hitting Johannesburg
   ended up counted as the site owner browsing his own page. */
function classify(docs) {
  const first = docs[0];

  if (SESSION_DENYLIST.has(first.session)) return [SELF, ["denylisted test session"]];
  if (docs.some(d => LOCAL_HOSTS.has(d.page?.host))) return [SELF, ["localhost"]];

  const [hard, soft] = sessionSignals(docs);
  if (hard.length) return [AUTOMATED, hard.concat(soft)];
  if (soft.length >= 2) return [AUTOMATED, soft];

  const geo = docs.find(d => d.geo?.country)?.geo || {};
  if (HOME_CITIES.has((geo.city || "").trim().toLowerCase()))
    return [SELF, [`home city ${geo.city}`].concat(soft)];

  return [HUMAN, soft.length ? soft : ["no anomalies"]];
}

/* ── small helpers ──────────────────────────────────────────── */

/* Ties broken by code point, NOT localeCompare. Locale collation sorts
   case-insensitively and reorders punctuation, so "other" would come before
   "Safari" here and after it in Python — the two implementations have to agree
   or the same data reads differently depending on where it was aggregated. */
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function topN(counter, limit = 14) {
  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1] || byCodePoint(String(a[0]), String(b[0])))
    .slice(0, limit)
    .map(([label, n]) => ({ label, n }));
}

const bump = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);

function browserOf(ua) {
  if (!ua) return "unknown";
  for (const [re, name] of [[/Edg\//, "Edge"], [/OPR\/|Opera/, "Opera"],
                            [/Firefox\//, "Firefox"], [/CriOS\/|Chrome\//, "Chrome"],
                            [/Safari\//, "Safari"]]) {
    if (re.test(ua)) return name;
  }
  return "other";
}

function osOf(ua, platform) {
  const hay = `${ua || ""} ${platform || ""}`;
  for (const [re, name] of [[/iPhone|iPad|iOS/i, "iOS"], [/Android/i, "Android"],
                            [/Mac OS X|macOS|Macintosh/i, "macOS"],
                            [/Windows/i, "Windows"], [/Linux|X11/i, "Linux"]]) {
    if (re.test(hay)) return name;
  }
  return "other";
}

function referrerOf(doc) {
  const raw = doc.page?.referrer;
  if (!raw) return "(direct)";
  let host;
  try { host = new URL(raw).host.toLowerCase(); } catch { return "(direct)"; }
  if (!host) return "(direct)";
  if (host.startsWith("www.")) host = host.slice(4);
  return host.endsWith(SITE) ? SITE : host;
}

/* (lat, lon, exact) for a document, or null when it cannot be placed. Rows
   written before schema 2 carry no coordinates and fall back to the centroid
   of their country. */
function coordsOf(doc) {
  const g = doc.geo || {};
  if (isNum(g.lat) && isNum(g.lon)) {
    return [Math.round(g.lat * 100) / 100, Math.round(g.lon * 100) / 100, true];
  }
  const hit = CENTROIDS[g.country || ""];
  return hit ? [hit[0], hit[1], false] : null;
}

/* ── scope ──────────────────────────────────────────────────── */

function buildScope(scope, data, verdicts, daysIndex) {
  const keep = d => scope === "all" || (verdicts.get(d.session)?.[0] ?? HUMAN) === scope;
  const pv = data.pageviews.filter(keep);
  const dl = data.downloads.filter(keep);
  const ck = data.clicks.filter(keep);
  const en = data.engagement.filter(keep);

  const sessions = new Set(pv.map(d => d.session));
  const dlSessions = new Set(dl.map(d => d.session));

  // zero-filled so the chart has no invisible gaps
  const perDay = new Map(daysIndex.map(date =>
    [date, { date, pageviews: 0, downloads: 0, clicks: 0, sessions: 0 }]));
  for (const [docs, key] of [[pv, "pageviews"], [dl, "downloads"], [ck, "clicks"]]) {
    for (const d of docs) {
      const row = perDay.get(dayOf(d));
      if (row) row[key]++;
    }
  }
  const daySessions = new Map();
  for (const d of pv) {
    const day = dayOf(d);
    if (!perDay.has(day)) continue;
    if (!daySessions.has(day)) daySessions.set(day, new Set());
    daySessions.get(day).add(d.session);
  }
  for (const [day, sids] of daySessions) perDay.get(day).sessions = sids.size;

  const byHour = new Array(24).fill(0);
  for (const d of pv) {
    const h = hourOf(d);
    if (h !== null && h >= 0 && h < 24) byHour[h]++;
  }

  const countries = new Map();
  for (const [docs, key] of [[pv, "pageviews"], [dl, "downloads"]]) {
    for (const d of docs) {
      const code = d.geo?.country;
      if (!code) continue;
      if (!countries.has(code))
        countries.set(code, { code, name: null, pageviews: 0, downloads: 0 });
      const row = countries.get(code);
      row[key]++;
      row.name = row.name || d.geo?.countryName || code;
    }
  }

  // Keyed by (position, precision). Precision is part of the key on purpose: a
  // centroid pin and a real pin must never merge, and inexact pins are never
  // given a city — every US row lands on the same point in Kansas, and calling
  // it "Quincy" because Quincy came first would be a straight-up lie.
  const places = new Map();
  for (const [docs, key] of [[pv, "pageviews"], [dl, "downloads"]]) {
    for (const d of docs) {
      const got = coordsOf(d);
      if (!got) continue;
      const [lat, lon, exact] = got;
      const id = `${lat.toFixed(1)}|${lon.toFixed(1)}|${exact}`;
      if (!places.has(id)) {
        places.set(id, { pageviews: 0, downloads: 0, city: null, country: null,
                         countryName: null, lat, lon, exact });
      }
      const slot = places.get(id);
      slot[key]++;
      slot.country = slot.country || d.geo?.country || null;
      slot.countryName = slot.countryName || d.geo?.countryName || null;
      if (exact) slot.city = slot.city || d.geo?.city || null;
    }
  }

  const dwells = en.map(d => d.dwellMs).filter(v => isNum(v) && v > 0).sort((a, b) => a - b);
  const scrolls = en.map(d => d.maxScroll).filter(isNum);

  const counter = (docs, fn) => {
    const m = new Map();
    for (const d of docs) {
      const v = fn(d);
      if (v !== null && v !== undefined && v !== "") bump(m, v);
    }
    return m;
  };

  return {
    totals: {
      pageviews: pv.length, sessions: sessions.size,
      downloads: dl.length, clicks: ck.length, visits: en.length,
    },
    downloadRate: sessions.size ? dlSessions.size / sessions.size : 0,
    engagement: {
      medianDwellMs: dwells.length ? dwells[Math.floor(dwells.length / 2)] : 0,
      avgScroll: scrolls.length ? scrolls.reduce((a, b) => a + b, 0) / scrolls.length : 0,
      readThrough: scrolls.length
        ? scrolls.filter(s => s >= 0.9).length / scrolls.length : 0,
      sections: topN(counter(en, d => d.section), 12),
    },
    byDay: daysIndex.map(d => perDay.get(d)),
    byHour,
    countries: [...countries.values()]
      .sort((a, b) => b.pageviews - a.pageviews || a.code.localeCompare(b.code))
      .slice(0, 60),
    places: [...places.values()]
      .sort((a, b) => (b.downloads * 10 + b.pageviews) - (a.downloads * 10 + a.pageviews))
      .slice(0, 400),
    referrers: topN(counter(pv, referrerOf)),
    campaigns: topN(counter(pv.filter(d => d.utm?.source),
                            d => `${d.utm.source} / ${d.utm.medium || "—"}`)),
    downloadOs: topN(counter(dl, d => d.os || "unknown")),
    downloadAssets: topN(counter(dl, d => d.asset)),
    downloadPlacements: topN(counter(dl, d => d.placement || "—")),
    clickLabels: topN(counter(ck, d => d.label)),
    clickPlacements: topN(counter(ck, d => d.placement || "—")),
    clickKinds: topN(counter(ck, d => d.kind || "—"), 6),
    browsers: topN(counter(pv, d => browserOf(d.device?.ua)), 8),
    platforms: topN(counter(pv, d => osOf(d.device?.ua, d.device?.platform)), 8),
    devices: {
      mobile: pv.filter(d => d.device?.mobile).length,
      desktop: pv.filter(d => !d.device?.mobile).length,
    },
    recentDownloads: dl.slice(0, 60).map(d => ({
      ts: d.ts, os: d.os || "?", asset: d.asset || "?",
      city: d.geo?.city ?? null, country: d.geo?.country ?? null,
      placement: d.placement || "—",
      verdict: verdicts.get(d.session)?.[0] ?? HUMAN,
    })),
  };
}

/* ── releases ───────────────────────────────────────────────── */

export function buildReleases(rels, repo) {
  let mac = 0, win = 0, other = 0;
  const rows = rels.map(rel => {
    const assets = rel.assets || [];
    const m = assets.filter(a => /\.(pkg|dmg)$/i.test(a.name))
                    .reduce((s, a) => s + a.download_count, 0);
    const w = assets.filter(a => /\.(exe|msi)$/i.test(a.name))
                    .reduce((s, a) => s + a.download_count, 0);
    const total = assets.reduce((s, a) => s + a.download_count, 0);
    mac += m; win += w; other += total - m - w;
    return { tag: rel.tag_name, published: (rel.published_at || "").slice(0, 10),
             macos: m, windows: w, total };
  }).sort((a, b) => b.published.localeCompare(a.published));

  return { repo, total: mac + win + other, macos: mac, windows: win, other,
           current: rows[0]?.tag ?? null, byRelease: rows };
}

/* ── entry point ────────────────────────────────────────────── */

export function aggregate(data, releases) {
  // Judge every session across all four collections at once, so a download
  // inherits the verdict of the visit it belongs to rather than being judged
  // on its own thinner evidence.
  const bySession = new Map();
  for (const name of COLLECTIONS) {
    for (const d of data[name]) {
      d._collection = name;
      if (!bySession.has(d.session)) bySession.set(d.session, []);
      bySession.get(d.session).push(d);
    }
  }
  const verdicts = new Map();
  for (const [sid, docs] of bySession) {
    docs.sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")));
    verdicts.set(sid, classify(docs));
  }

  const allDays = [...new Set(COLLECTIONS.flatMap(c => data[c].map(dayOf)))]
    .filter(Boolean).sort();
  let daysIndex = allDays;
  if (allDays.length) {
    daysIndex = [];
    const end = new Date(`${allDays[allDays.length - 1]}T00:00:00`);
    for (let d = new Date(`${allDays[0]}T00:00:00`); d <= end; d.setDate(d.getDate() + 1)) {
      daysIndex.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${
        String(d.getDate()).padStart(2, "0")}`);
    }
  }

  const counts = { human: 0, automated: 0, self: 0 };
  for (const [v] of verdicts.values()) counts[v]++;

  const scopes = {};
  for (const s of SCOPES) scopes[s] = buildScope(s, data, verdicts, daysIndex);

  return {
    schemaVersion: 1,
    generated: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    site: SITE,
    window: {
      first: allDays[0] ?? null,
      last: allDays[allDays.length - 1] ?? null,
      days: daysIndex.length,
      requestedDays: null,
    },
    releases,
    sessionVerdicts: { ...counts, total: verdicts.size },
    scopes,
  };
}
