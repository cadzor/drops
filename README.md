# OSRS boss loot variance

Pick any boss, set a kill count, and see the expected value, the spread around it, and
the odds on every line of the drop table.

## How it's put together

```
index.html                            the app — no framework, no build step
data/bosses.json                      list of bosses
data/drops/<slug>.json                one drop table per boss, prices baked in
tools/build-data.mjs                  fetches all of that from the wiki
.github/workflows/refresh-data.yml    runs the fetch daily and deploys Pages
```

The page never talks to the wiki. It reads a snapshot from `./data`, same origin. All the
scraping happens in GitHub Actions, once per scheduled build rather than once per visitor.

That matters for three reasons:

1. **No CORS.** Cross-origin requests are what fails in restricted previews and behind
   corporate proxies. Same-origin JSON always works.
2. **The User-Agent problem goes away.** The wiki asks that automated tooling identify
   itself, and a browser won't let a page set its own User-Agent — so a browser-based
   scraper can't comply, wherever it's hosted. A Node script can, and does.
3. **It's much faster.** One small JSON file per boss instead of parsing a full wiki page
   in the visitor's browser.

## Setting it up

1. Push this folder to a repo.
2. **Settings → Pages → Source: GitHub Actions.**
3. **Settings → Secrets and variables → Actions → Variables → New variable:**
   name `WIKI_UA`, value something that identifies you, e.g.
   `osrs-loot-variance - yourname on Discord`. Without it the workflow falls back to your
   repo URL, which is acceptable but less useful to the wiki admins if they need to reach you.
4. **Actions → Refresh data and deploy → Run workflow.**

The first run takes a few minutes — it walks every boss page at about four requests per
second. After that it re-runs daily at 04:17 UTC and redeploys.

`data/` ships with a one-boss starter snapshot (Vardorvis) so the page renders before
you've run anything. The first real build overwrites it.

### Running the fetch locally

```bash
cd tools
npm install
WIKI_UA="your-name - your@email" npm run build-data
cd .. && python3 -m http.server        # then open http://localhost:8000
```

Pass boss names to do just a few: `npm run build-data -- Vorkath Zulrah`.

Opening `index.html` straight off disk won't work — `fetch` refuses `file://` URLs. Serve
it over http, as above.

## Why not a proxy?

A Cloudflare Worker in front of the wiki would also fix CORS, but it doesn't fix the
User-Agent problem — you'd still be scraping a full wiki page on every page view, just
through a middleman. The scheduled build is less code, less traffic, and faster to load.

## How the maths works

Each line of the drop table is an independent chance per kill, taken from the wiki's
effective rate. Counts are drawn per segment of the trip:

- **Guaranteed drops** (bones, ashes) are deterministic — no fake variance.
- **Frequent lines** are pooled into one normal draw per segment using binomial variance.
- **Everything rarer** is sampled line by line, binomially when trial counts are small and
  by Poisson otherwise.

Expected value is closed-form, so it's exact. The simulation only supplies the spread: the
percentile bands, the histogram, and the share of trips that beat the average.

### Known limits

Flat per-kill rates are exact for most bosses but hide staged mechanics:

- **Ultor vestige** needs three separate 1/362.66 rolls, so a completed vestige is far
  rarer in a short trip than the listed 1/1,088 suggests.
- **Chambers of Xeric, Tombs of Amascut, Theatre of Blood** scale with points, invocation
  level and team size. A flat rate is a rough stand-in at best.
- **Blood quartz** and similar first-drop-boosted items arrive sooner than the flat rate.
- Lines the wiki lists as *Common*, *Uncommon* or *Varies* have no number attached and are
  left out. Type a rate into the "1 in" column to include one.
- Untradeables have no GE price and fall back to high alch, or zero.

Every rate and price in the table is editable, so any of these can be corrected by hand.
Prices are the midpoint of the real-time high and low at build time, so they lag the live
Grand Exchange by up to a day.

## URL state

Settings live in the hash, so a link carries the whole setup:

```
#boss=vardorvis&kc=80&kph=30&cost=0
```
