/* ══════════════════════════════════════════════════════════════
   REMI DSP — dashboard

   Sign in, subscribe to Firestore, aggregate, render. There is no build step
   and no snapshot file: a download appears here the moment the row lands.

   Every scope (human / automated / self / all) is computed from the same
   in-memory documents, so the scope switch is a re-render over data already
   held — no refetch, no spinner, no second read billed.
   ══════════════════════════════════════════════════════════════ */

import { watchAuth, signIn, leave, subscribe, fetchReleases,
         describeAuthError, GH_REPO } from "./live.js";
import { aggregate, buildReleases } from "./aggregate.js";
import { bars, spark, timeseries, hours, tooltip, fmt, led, pct, duration }
  from "./charts.js";
import { drawMap } from "./map.js";

const $ = id => document.getElementById(id);

let metrics = null;
let releases = { repo: GH_REPO, total: 0, macos: 0, windows: 0, other: 0,
                 current: null, byRelease: [] };
let raw = null;
let scope = "human";
let mapMetric = "downloads";
let tip = null;
let unsubscribe = null;
let lastUpdate = null;

const esc = s => String(s ?? "").replace(/[&<>"]/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const when = ts => {
  const d = new Date(ts);
  return isNaN(d) ? "—" : d.toLocaleString("en-GB",
    { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
};

/* ── gate ───────────────────────────────────────────────────── */

function showGate({ message = "", setup = false } = {}) {
  $("lock").hidden = false;
  $("app").hidden = true;
  $("lockErr").textContent = message;
  $("lockSetup").hidden = !setup;
}

function showApp() {
  $("lock").hidden = true;
  $("app").hidden = false;
}

$("signIn").addEventListener("click", async () => {
  $("lockErr").textContent = "";
  try {
    await signIn();
  } catch (e) {
    showGate(describeAuthError(e));
  }
});

$("lockBtn").addEventListener("click", () => leave());

/* ── data ───────────────────────────────────────────────────── */

watchAuth(user => {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }

  if (!user) {
    metrics = null;
    showGate();
    return;
  }

  $("lockErr").textContent = "Loading…";

  // Releases come from the public GitHub API and change rarely; one fetch per
  // sign-in is plenty and costs one of the 60/hour anonymous requests.
  fetchReleases()
    .then(r => { releases = buildReleases(r, GH_REPO); if (raw) rebuild(); })
    .catch(() => { /* the site numbers are still worth showing without it */ });

  unsubscribe = subscribe(
    (data, meta) => {
      raw = data;
      lastUpdate = new Date();
      showApp();
      rebuild(meta);
    },
    err => showGate(describeAuthError(err)),
  );
});

function rebuild(meta = {}) {
  metrics = aggregate(raw, releases);
  render();
  $("liveDot").dataset.state = meta.fromCache ? "cache" : "live";
  $("liveText").textContent = meta.fromCache
    ? "CACHED" : `LIVE · ${lastUpdate.toLocaleTimeString("en-GB")}`;
}

/* ── render ─────────────────────────────────────────────────── */

function render() {
  const m = metrics;
  const s = m.scopes[scope];
  const rel = m.releases;
  const v = m.sessionVerdicts;

  const w = m.window;
  $("mWindow").textContent = w.first
    ? `${w.first} → ${w.last} · ${w.days} DAYS` : "NO DATA";

  for (const b of document.querySelectorAll("#scope button")) {
    const key = b.dataset.scope;
    b.setAttribute("aria-pressed", String(key === scope));
    b.querySelector("b").textContent = key === "all" ? fmt(v.total) : fmt(v[key] ?? 0);
  }

  const label = { human: "human traffic", automated: "automated traffic",
                  self: "your own traffic", all: "all traffic" }[scope];
  $("mScopeNote").textContent = label.toUpperCase();

  // ── 01 headline ──
  $("kRelease").textContent = led(rel.total);
  $("kReleaseNote").innerHTML = rel.byRelease.length
    ? `GitHub release assets — <b>${fmt(rel.macos)}</b> macOS · <b>${fmt(rel.windows)}</b> Windows. `
      + `Every fetch from any source, all scopes, since ${rel.byRelease.at(-1)?.published ?? "—"}.`
    : "GitHub release counts unavailable right now.";

  const t = s.totals;
  $("kDownloads").textContent = led(t.downloads);
  $("kDownloadsNote").textContent = `Installer links clicked in ${label}.`;
  $("kPageviews").textContent = led(t.pageviews);
  $("kPageviewsNote").innerHTML = `Across <b>${fmt(t.sessions)}</b> sessions.`;
  $("kClicks").textContent = led(t.clicks);
  $("kClicksNote").textContent = "Links other than installers.";
  $("kSessions").textContent = led(t.sessions);
  $("kSessionsNote").innerHTML =
    `<b>${fmt(v.human)}</b> human · <b>${fmt(v.automated)}</b> bot · <b>${fmt(v.self)}</b> yours`;

  $("kRate").textContent = pct(s.downloadRate);
  const [dwellValue, dwellUnit] = duration(s.engagement.medianDwellMs);
  $("kDwell").innerHTML = `${esc(dwellValue)}<span class="stat__unit">${esc(dwellUnit)}</span>`;
  $("kScroll").textContent = pct(s.engagement.avgScroll);
  $("kScrollNote").innerHTML = s.totals.visits
    ? `<b>${pct(s.engagement.readThrough)}</b> reached the bottom, over `
      + `<b>${fmt(s.totals.visits)}</b> measured visits.`
    : "No visits measured yet — engagement started 2026-07-29.";
  $("kScrollMeter").style.width = (s.engagement.avgScroll * 100).toFixed(1) + "%";

  spark($("kDownloadsSpark"), s.byDay.map(d => d.downloads));
  spark($("kPageviewsSpark"), s.byDay.map(d => d.pageviews));
  spark($("kClicksSpark"), s.byDay.map(d => d.clicks));

  // ── 02 map ──
  const drew = drawMap($("map"), s.places, tip, { metric: mapMetric });
  $("mMapNote").textContent = drew.plotted
    ? `${drew.plotted} LOCATIONS · ${drew.approx} COUNTRY-LEVEL ONLY`
    : "NO LOCATIONS IN THIS SCOPE";
  for (const b of document.querySelectorAll("#mapMetric button")) {
    b.setAttribute("aria-pressed", String(b.dataset.metric === mapMetric));
  }

  bars($("countries"), s.countries.map(c => ({
    label: c.name, sub: c.downloads ? `${c.downloads} dl` : "", n: c.pageviews,
  })), { limit: 12 });

  // ── 03 time ──
  timeseries($("chart"), s.byDay, tip);
  hours($("hours"), s.byHour);

  // ── 04 arrival ──
  bars($("referrers"), s.referrers);
  bars($("campaigns"), s.campaigns, {
    note: s.campaigns.length ? null : "No utm-tagged links have been used yet.",
  });
  bars($("sections"), s.engagement.sections);

  // ── 05 behaviour ──
  bars($("clickLabels"), s.clickLabels);
  bars($("clickPlacements"), s.clickPlacements);
  bars($("dlPlacements"), s.downloadPlacements);

  // ── 06 machines ──
  bars($("platforms"), s.platforms);
  bars($("browsers"), s.browsers);
  bars($("downloadOs"), s.downloadOs);

  // ── 07 releases ──
  $("mRelNote").textContent =
    `${fmt(rel.total)} ASSETS FETCHED · ${rel.byRelease.length} RELEASES`;
  $("releases").innerHTML = rel.byRelease.map((r, i) => `
    <tr class="${i === 0 ? "is-current" : ""}">
      <td>${esc(r.tag)}</td>
      <td>${esc(r.published)}</td>
      <td class="n">${fmt(r.macos)}</td>
      <td class="n">${fmt(r.windows)}</td>
      <td class="n">${fmt(r.total)}</td>
      <td>${i === 0 ? '<span class="tag">the site links here</span>' : ""}</td>
    </tr>`).join("");

  // ── 08 log ──
  const log = s.recentDownloads;
  $("log").innerHTML = log.length ? log.map(d => `
    <tr>
      <td>${esc(when(d.ts))}</td>
      <td class="${d.os === "macos" ? "tag--macos" : ""}">${esc(d.os)}</td>
      <td>${esc(d.asset)}</td>
      <td>${esc([d.city, d.country].filter(Boolean).join(", ") || "—")}</td>
      <td>${esc(d.placement)}</td>
      <td><span class="tag ${d.verdict === "human" ? "tag--human" : ""}">${esc(d.verdict)}</span></td>
    </tr>`).join("")
    : `<tr><td colspan="6"><p class="empty">no downloads in this scope</p></td></tr>`;

  $("mFooter").textContent = `${fmt(v.total)} sessions classified · live from Firestore`;
}

/* ── wiring ─────────────────────────────────────────────────── */

$("scope").addEventListener("click", e => {
  const b = e.target.closest("button[data-scope]");
  if (!b || b.dataset.scope === scope) return;
  scope = b.dataset.scope;
  render();
});

$("mapMetric").addEventListener("click", e => {
  const b = e.target.closest("button[data-metric]");
  if (!b || b.dataset.metric === mapMetric) return;
  mapMetric = b.dataset.metric;
  render();
});

// The authorized-domain step needs the exact host, and it differs between
// localhost and Pages — so read it off the page rather than hardcoding it.
$("thisHost").textContent = location.hostname;

tip = tooltip();
