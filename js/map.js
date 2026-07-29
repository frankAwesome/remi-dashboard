/* ══════════════════════════════════════════════════════════════
   World map — inline SVG, no tiles, no library.

   Country outlines are baked into js/world.js by tools/build_world.py in the
   same equirectangular projection used here, so plotting a point is one
   addition and a subtraction. That keeps the map on-brand (it is drawn with
   the same hairlines as everything else) and means the dashboard makes no
   third-party requests at all.

   Pins are area-proportional: a circle whose *area* tracks the count, because
   scaling the radius instead would make ten downloads look a hundred times
   bigger than one. Downloads are solid, pageviews translucent, and anything
   placed from a country centroid is drawn hollow and dashed — a dot that only
   means "somewhere in Canada" must not look like a street address.
   ══════════════════════════════════════════════════════════════ */

import { VIEWBOX, COUNTRIES, project } from "./world.js";
import { fmt } from "./charts.js";

const NS = "http://www.w3.org/2000/svg";
const el = (name, attrs = {}) => {
  const n = document.createElementNS(NS, name);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
};

const esc = s => String(s ?? "").replace(/[&<>"]/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function drawMap(host, places, tip, opts = {}) {
  const { metric = "downloads" } = opts;
  host.innerHTML = "";

  const svg = el("svg", { viewBox: VIEWBOX, role: "img",
                          "aria-label": "World map of visitor locations" });

  // graticule first — it reads as the grid the countries sit on
  const grat = el("g", { class: "map__grat" });
  for (let lon = -180; lon <= 180; lon += 30) {
    const [x] = project(lon, 0);
    grat.appendChild(el("line", { x1: x, x2: x, y1: 0, y2: 145 }));
  }
  for (let lat = -60; lat <= 85; lat += 30) {
    const [, y] = project(0, lat);
    grat.appendChild(el("line", { x1: 0, x2: 360, y1: y, y2: y }));
  }
  svg.appendChild(grat);

  // countries with any traffic get a lifted fill, so the map reads even
  // before you look at a single pin
  const hit = new Set(places.map(p => p.country).filter(Boolean));
  const land = el("g");
  for (const c of COUNTRIES) {
    land.appendChild(el("path", {
      d: c.d,
      class: "map__land" + (hit.has(c.id) ? " map__land--hit" : ""),
    }));
  }
  svg.appendChild(land);

  const shown = places.filter(p => (p[metric] || 0) > 0);
  const top = Math.max(...shown.map(p => p[metric]), 1);
  const pins = el("g");

  // largest first so a big translucent pin never sits on top of a small one
  for (const p of [...shown].sort((a, b) => b[metric] - a[metric])) {
    const [x, y] = project(p.lon, p.lat);
    const n = p[metric];
    const r = 0.9 + Math.sqrt(n / top) * 6.4;      // area-proportional

    if (n === top && top > 1) {
      pins.appendChild(el("circle", { class: "map__halo", cx: x, cy: y, r: r + 2.6 }));
    }

    const dot = el("circle", {
      cx: x, cy: y, r,
      class: "map__pin"
           + (metric === "downloads" ? " map__pin--dl" : "")
           + (p.exact ? "" : " map__pin--approx"),
      style: "cursor:crosshair",
    });

    const where = p.exact
      ? `${esc(p.city || "—")}, ${esc(p.country || "")}`
      : `${esc(p.countryName || p.country || "unknown")}`;
    const precision = p.exact ? "city, ±11 km" : "country centroid — approximate";

    dot.addEventListener("pointerenter", e => tip?.show(e,
      `<b>${where}</b><s>${fmt(p.downloads)} downloads · ${fmt(p.pageviews)} pageviews`
      + `<br>${precision}</s>`));
    dot.addEventListener("pointermove", e => tip?.move(e));
    dot.addEventListener("pointerleave", () => tip?.hide());
    pins.appendChild(dot);
  }
  svg.appendChild(pins);
  host.appendChild(svg);

  return { plotted: shown.length, approx: shown.filter(p => !p.exact).length };
}
