/* ══════════════════════════════════════════════════════════════
   Charts — hand-built inline SVG.

   No chart library. The whole vocabulary here is four marks (area, line,
   bar, sparkline) and the site's type scale already describes how they
   should look, so a dependency would cost more than it saves — and this
   page loads nothing from anyone else's server by design.
   ══════════════════════════════════════════════════════════════ */

export const fmt = n =>
  n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M"
: n >= 1e4 ? (n / 1e3).toFixed(0) + "k"
: n.toLocaleString("en");

/* DSEG7 has no thousands separator glyph and looks wrong with one — the LED
   readouts are padded instead, the way a piece of hardware would show them. */
export const led = (n, width = 0) => String(Math.round(n)).padStart(width, "0");

export const pct = n => (n * 100).toFixed(n >= 0.1 ? 0 : 1) + "%";

/* [value, unit] rather than one string: DSEG7 is a seven-segment face, so an
   's' in it renders as a 5 and "0s" reads as "05". Units belong in the UI face,
   outside the LED span — the same split a real piece of hardware uses. */
export function duration(ms) {
  if (!ms) return ["0", "s"];
  const s = Math.round(ms / 1000);
  if (s < 60) return [String(s), "s"];
  const m = Math.floor(s / 60);
  return [m + ":" + String(s % 60).padStart(2, "0"), "min"];
}

const svgEl = (name, attrs = {}) => {
  const el = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
};

const esc = s => String(s ?? "").replace(/[&<>"]/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ── ranked bars ────────────────────────────────────────────── */
export function bars(host, rows, opts = {}) {
  const { limit = 10, suffix = "", note = null } = opts;
  host.innerHTML = "";
  const data = rows.filter(r => r.n > 0).slice(0, limit);
  if (!data.length) {
    host.innerHTML = '<p class="empty">no data in this scope</p>';
    return;
  }
  const top = Math.max(...data.map(r => r.n));
  const wrap = document.createElement("div");
  wrap.className = "bars";
  wrap.innerHTML = data.map((r, i) => `
    <div class="bar">
      <div class="bar__k" title="${esc(r.label)}">${esc(r.label)}${
        r.sub ? ` <span>${esc(r.sub)}</span>` : ""}</div>
      <div class="bar__n">${fmt(r.n)}${suffix}</div>
      <div class="bar__t"><i class="bar__f" style="transform:scaleX(${
        (r.n / top).toFixed(4)});animation-delay:${i * 40}ms"></i></div>
    </div>`).join("");
  host.appendChild(wrap);
  if (note) {
    const p = document.createElement("p");
    p.className = "stat__note";
    p.textContent = note;
    host.appendChild(p);
  }
}

/* ── sparkline ──────────────────────────────────────────────── */
export function spark(host, values, opts = {}) {
  const { stroke = "var(--gold-hi)" } = opts;
  host.innerHTML = "";
  if (!values.length) return;
  const W = 240, H = 34, top = Math.max(...values, 1);
  const x = i => (values.length === 1 ? W / 2 : (i / (values.length - 1)) * W);
  const y = v => H - 2 - (v / top) * (H - 5);

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none",
                             width: "100%", height: H });
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  svg.appendChild(svgEl("path", {
    d: `M0,${H} L${pts.join(" L")} L${W},${H} Z`,
    fill: "rgba(159,216,232,.10)", stroke: "none",
  }));
  svg.appendChild(svgEl("path", {
    d: `M${pts.join(" L")}`, fill: "none", stroke,
    "stroke-width": 1.4, "vector-effect": "non-scaling-stroke",
  }));
  host.appendChild(svg);
}

/* ── time series: pageview area + download line, shared x-axis ── */
export function timeseries(host, days, tip) {
  host.innerHTML = "";
  if (!days.length) {
    host.innerHTML = '<p class="empty">no data in this scope</p>';
    return;
  }
  const W = 1000, H = 300, L = 44, R = 42, T = 18, B = 30;
  const iw = W - L - R, ih = H - T - B;

  const pvMax = Math.max(...days.map(d => d.pageviews), 1);
  const dlMax = Math.max(...days.map(d => d.downloads), 1);
  const x = i => L + (days.length === 1 ? iw / 2 : (i / (days.length - 1)) * iw);
  const yPv = v => T + ih - (v / pvMax) * ih;
  const yDl = v => T + ih - (v / dlMax) * ih;

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart",
                             preserveAspectRatio: "none" });

  // horizontal gridlines + left (pageviews) axis labels
  for (let g = 0; g <= 4; g++) {
    const v = (pvMax / 4) * g, yy = yPv(v);
    svg.appendChild(svgEl("line", { class: "gl", x1: L, x2: W - R, y1: yy, y2: yy }));
    const t = svgEl("text", { class: "axlab", x: L - 8, y: yy + 3, "text-anchor": "end" });
    t.textContent = fmt(Math.round(v));
    svg.appendChild(t);
  }
  // right axis: downloads
  for (let g = 0; g <= 4; g++) {
    const v = (dlMax / 4) * g;
    const t = svgEl("text", { class: "axlab", x: W - R + 8, y: yDl(v) + 3 });
    t.textContent = fmt(Math.round(v));
    svg.appendChild(t);
  }

  const pv = days.map((d, i) => `${x(i).toFixed(1)},${yPv(d.pageviews).toFixed(1)}`);
  svg.appendChild(svgEl("path", {
    class: "ser-pv",
    d: `M${L},${T + ih} L${pv.join(" L")} L${x(days.length - 1)},${T + ih} Z`,
  }));
  svg.appendChild(svgEl("path", {
    class: "ser-dl",
    d: `M${days.map((d, i) => `${x(i).toFixed(1)},${yDl(d.downloads).toFixed(1)}`).join(" L")}`,
  }));
  days.forEach((d, i) => {
    if (d.downloads > 0) {
      svg.appendChild(svgEl("circle", { class: "dot", cx: x(i), cy: yDl(d.downloads), r: 2.6 }));
    }
  });

  // date labels — thinned so they never collide
  const step = Math.max(1, Math.ceil(days.length / 9));
  days.forEach((d, i) => {
    if (i % step && i !== days.length - 1) return;
    const t = svgEl("text", { class: "axlab", x: x(i), y: H - 10, "text-anchor": "middle" });
    t.textContent = d.date.slice(5);
    svg.appendChild(t);
  });
  svg.appendChild(svgEl("line", { class: "ax", x1: L, x2: W - R, y1: T + ih, y2: T + ih }));

  // one hover band per day — invisible, full height, so the pointer never misses
  const marker = svgEl("line", { class: "hover", y1: T, y2: T + ih, opacity: 0 });
  svg.appendChild(marker);
  const bandW = iw / Math.max(days.length - 1, 1);
  days.forEach((d, i) => {
    const band = svgEl("rect", {
      x: x(i) - bandW / 2, y: T, width: bandW, height: ih,
      fill: "transparent", style: "cursor:crosshair",
    });
    band.addEventListener("pointerenter", e => {
      marker.setAttribute("x1", x(i)); marker.setAttribute("x2", x(i));
      marker.setAttribute("opacity", 1);
      tip?.show(e, `<b>${d.date}</b><s>${fmt(d.pageviews)} pageviews · ${
        fmt(d.sessions)} sessions<br>${fmt(d.downloads)} downloads · ${
        fmt(d.clicks)} clicks</s>`);
    });
    band.addEventListener("pointermove", e => tip?.move(e));
    band.addEventListener("pointerleave", () => {
      marker.setAttribute("opacity", 0); tip?.hide();
    });
    svg.appendChild(band);
  });

  host.appendChild(svg);
}

/* ── hours of day ───────────────────────────────────────────── */
export function hours(host, values) {
  host.innerHTML = "";
  const top = Math.max(...values, 1);
  const strip = document.createElement("div");
  strip.className = "hours";
  strip.innerHTML = values.map((v, h) =>
    `<div style="height:${v ? Math.max(4, (v / top) * 100) : 1}%" data-zero="${
      v ? 0 : 1}" title="${String(h).padStart(2, "0")}:00 — ${v} pageviews"></div>`).join("");
  const ax = document.createElement("div");
  ax.className = "hourax";
  ax.innerHTML = values.map((_, h) => `<span>${String(h).padStart(2, "0")}</span>`).join("");
  host.append(strip, ax);
}

/* ── tooltip ────────────────────────────────────────────────── */
export function tooltip() {
  const el = document.createElement("div");
  el.className = "tip";
  document.body.appendChild(el);
  const move = e => {
    el.style.left = e.clientX + "px";
    el.style.top = e.clientY + "px";
  };
  return {
    show(e, html) { el.innerHTML = html; el.dataset.on = "1"; move(e); },
    move,
    hide() { el.dataset.on = "0"; },
  };
}
