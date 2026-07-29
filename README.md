# REMI DSP — metrics dashboard

What remidsp.com actually did, on one page, in the site's own design language.

**Live:** https://frankawesome.github.io/remi-dashboard/ — passphrase-gated.

Two sources, side by side:

- **GitHub release counters** — installers actually fetched, from any source,
  since the first release. This is the number that saw the bytes move.
- **Firestore analytics** written by `js/analytics.js` on remidsp.com —
  pageviews, downloads, clicks and engagement, with geo, referrer and placement.

Almost none of the raw traffic is a person. Your own browsing, the headless QA
runs and a steady drip of scanners dwarf real visitors, so every **session** is
classified `human` / `automated` / `self` and the page opens on human. The
switch at the top is a filter over data already decrypted, not a refetch.

---

## How it stays private

The page is on public GitHub Pages. The numbers are not.

`tools/export.py` encrypts the aggregated JSON with **AES-256-GCM** under a
**PBKDF2-SHA256** key (310 000 iterations) before it is ever committed, so the
host only ever serves ciphertext. The page asks for the passphrase and decrypts
in the tab via WebCrypto — the passphrase is never sent anywhere and is dropped
when the tab closes.

A wrong passphrase fails GCM's authentication tag. There is no separate check to
get wrong and no way to half-decrypt.

**Firestore reads stay blocked from the browser**, which is the point of
`firestore.rules`. The dashboard never queries the database: a build step reads
with a credential and ships a static file. Nothing that can read the database is
ever served to a visitor.

The page makes **no third-party requests at all** — no CDN, no tile server, no
font host, no analytics on the analytics. The world map is inline SVG baked into
`js/world.js`; the charts are hand-built SVG.

---

## Refreshing

Automatic: `.github/workflows/refresh.yml` runs daily at 05:17 UTC, and on
demand from the Actions tab.

By hand, using your own `firebase login`:

```bash
REMI_DASH_PASSPHRASE='…' python3 tools/export.py
```

To read the numbers locally without encrypting anything:

```bash
python3 tools/export.py --no-encrypt --plain /tmp/metrics.json
```

`--days N` limits the window. `data/metrics.json` is gitignored so a plaintext
dump cannot be committed by accident.

---

## The credential

The workflow authenticates as `remi-dashboard-reader@remidsp-98208.iam.gserviceaccount.com`,
which holds exactly `roles/datastore.viewer` on the analytics project. It cannot
write to Firestore (verified), cannot reach any other project, and can be
revoked on its own.

This matters: the credential the firebase CLI holds is a Google **refresh token
for your whole account**, valid until revoked. That belongs on your laptop, not
in a repo secret.

Recreate it with `python3 tools/setup_service_account.py`.

### Secrets

| name | what |
|---|---|
| `REMI_SA_KEY` | the service account JSON |
| `REMI_DASH_PASSPHRASE` | what the page asks for |

Rotating the passphrase is one `gh secret set` plus one workflow run — the salt
travels inside the file, so nothing in the page needs changing.

---

## Layout

```
index.html              the page
css/dash.css            the site's design system, pointed at data
js/dash.js              fetch → unlock → render
js/crypto.js            WebCrypto unlock
js/charts.js            SVG charts, no library
js/map.js               world map
js/world.js             GENERATED — country paths
tools/export.py         Firestore + GitHub → encrypted JSON
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
  never given a city name — see the `places` grouping in `export.py`.
- **Engagement starts 2026-07-29.** Before that, `dwellMs` and `maxScroll` do
  not exist, so those tiles read zero for older windows.
- **`human` means no automation signals**, not a verified person.
- **`self` is your *city*, localhost, or a denylisted test session** —
  `HOME_CITIES` in `export.py`. It was a whole country (`{"ZA"}`) until
  2026-07-29, which swallowed the friends in Pretoria and Johannesburg who
  actually downloaded the plugin: human downloads read 1 when the true figure
  was 3. A country is not one person.

  The cost of city-level attribution is that **anyone else in Cape Town is
  still counted as you**. On the data as of 2026-07-29 that is roughly two
  sessions and one download — a macOS 1728×1117 machine that has never
  appeared on localhost. If that ever matters more than the convenience,
  narrow `self` to a device allowlist instead; the fingerprints that have
  browsed localhost are provably yours.
- **Verdicts are ordered: certainty, then evidence, then geography.** Location
  is checked *last*. It used to be checked first, which meant a crawler that
  resolved to your own city was filed as you and never tested for automation —
  that is how a burst of link-preview bots (triggered by a friend sharing the
  URL in Microsoft Teams) was counted as you browsing your own site.
- Site analytics start 2026-07-17; releases predate them.
