# REMI DSP — metrics dashboard

What remidsp.com is doing, live, in the site's own design language.

**Live:** https://frankawesome.github.io/remi-dashboard/ — sign in with Google.

Two sources, side by side:

- **GitHub release counters** — installers actually fetched, from any source,
  since the first release. This is the number that saw the bytes move.
- **Firestore analytics** written by `js/analytics.js` on remidsp.com —
  pageviews, downloads, clicks and engagement, with geo, referrer and placement.

Almost none of the raw traffic is a person. Your own browsing, the headless QA
runs and a steady drip of scanners dwarf real visitors, so every **session** is
classified `human` / `automated` / `self` and the page opens on human. The
switch at the top is a filter over documents already in memory, not a refetch.

---

## Live, not built

The page subscribes to Firestore with `onSnapshot` and re-renders when a row
lands. There is no build step, no committed snapshot, and no window during
which you are looking at yesterday.

`onSnapshot` rather than polling, for two reasons. It is genuinely live — a
download shows up the moment it happens, not on the next tick — and it is far
cheaper: Firestore bills the first snapshot in full and then only the documents
that changed. Polling four collections every five minutes would re-read the
whole database 288 times a day and exhaust the free tier before lunch.

## How it stays private

`firestore.rules` grants **read** to exactly one verified Google account and
refuses everyone else. The check is server-side on every query, so the public
API key in the page grants nothing — an unauthenticated read returns
`403 PERMISSION_DENIED` (verified).

Writing stays public and unauthenticated, because a visitor's browser does the
writing. Reading was previously blocked outright; going live is the one thing
that required opening it, and it was opened as narrowly as the rules allow.

Adding a second reader is one more address in `dashboardReader()` in
`remidsp-site/firestore.rules`.

### Setup (one time, free tier)

1. [Authentication → Get started](https://console.firebase.google.com/project/remidsp-98208/authentication/providers),
   enable the **Google** provider, save.
2. [Authentication → Settings → Authorized domains](https://console.firebase.google.com/project/remidsp-98208/authentication/settings)
   → **Add domain** → `frankawesome.github.io`.

The sign-in screen detects both of these being missing and shows the steps
inline, so you do not have to come back here for them.

---

## The command line

`tools/export.py` is no longer in the dashboard's path, and is kept for two
jobs that still matter: getting the numbers without a browser, and being the
**reference implementation** of the classification and aggregation rules.

```bash
python3 tools/export.py                # -> data/metrics.json (gitignored)
python3 tools/export.py --days 30      # only the last month
```

It authenticates with your own `firebase login`, or with `REMI_SA_KEY` for a
read-only service account (`tools/setup_service_account.py` creates one holding
exactly `roles/datastore.viewer`; it cannot write, verified).

**`js/aggregate.js` is a line-for-line port of `export.py`** and is verified to
produce byte-identical output over the same documents. If you change a rule in
one, change it in the other. Two differences that were found by that check and
are worth not reintroducing:

- Hour-of-day uses `hourCycle:"h23"`, not `hour12:false` — the latter resolves
  to h24 in several engines and renders midnight as "24", dropping it.
- Ranked lists break ties by **code point**, not `localeCompare` — locale
  collation is case-insensitive and would order `other` before `Safari` in one
  implementation and after it in the other.

---

## Layout

```
index.html              the page
css/dash.css            the site's design system, pointed at data
js/live.js              Firebase auth + Firestore subscriptions
js/aggregate.js         classification + aggregation (port of export.py)
js/dash.js              subscribe → aggregate → render
js/charts.js            SVG charts, no library
js/map.js               world map
js/world.js             GENERATED — country paths + centroids
tools/export.py         the same numbers, on the command line
tools/build_world.py    regenerates world.js and centroids.py
tools/setup_service_account.py
```

`tools/build_world.py` only needs re-running to re-simplify the map; its output
is committed.

---

## Reading the numbers honestly

- **Ad blockers** drop `firestore.googleapis.com`. Site numbers are a floor —
  expect 10–30% low for a developer/musician audience. The release counter does
  not have this problem.
- **A download row is a click** on the installer link, not a completed transfer.
- **Coordinates start 2026-07-29.** Earlier rows are placed at their country's
  centroid and drawn hollow and dashed. A dot meaning "somewhere in Canada" is
  never given a city name — see the `places` grouping.
- **Engagement starts 2026-07-29.** Before that, `dwellMs` and `maxScroll` do
  not exist, so those tiles read zero for older windows.
- **`human` means no automation signals**, not a verified person.
- **`self` is your *city*, localhost, or a denylisted test session** —
  `HOME_CITIES`. It was a whole country (`{"ZA"}`) until 2026-07-29, which
  swallowed the friends in Pretoria and Johannesburg who actually downloaded
  the plugin: human downloads read 1 when the true figure was 3. A country is
  not one person.

  The cost of city-level attribution is that **anyone else in Cape Town is
  still counted as you** — roughly two sessions and one download in the data as
  of 2026-07-29. If that ever matters more than the convenience, narrow `self`
  to a device allowlist; the fingerprints that have browsed localhost are
  provably yours.
- **Verdicts are ordered: certainty, then evidence, then geography.** Location
  is checked *last*. It used to be first, which meant a crawler resolving to
  your own city was filed as you and never tested for automation — that is how
  a burst of link-preview bots, triggered by a friend sharing the URL in
  Microsoft Teams, was counted as you browsing your own site.
- Site analytics start 2026-07-17; releases predate them.
