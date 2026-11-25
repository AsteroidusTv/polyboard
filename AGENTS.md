# Polyboard

Polyboard is a Polymarket portfolio dashboard. It uses a Python standard-library HTTP server and plain HTML, CSS, and JavaScript. See [README.md](README.md) for user-facing features and configuration.

## Work in a fresh chat

- Use one chat per feature. Start by checking `git status --short --branch` and `git log -1 --oneline`. Start from the branch, PR, or commit named in the request, or use the latest `origin/main` as the baseline for new work.
- Keep follow-ups in the feature chat. For work that continues elsewhere, record the branch or PR, the commit, the verification performed, and any outstanding work. Put lasting project instructions here and operational steps in the [deployment runbook](docs/deployment.md).
- Treat the source revision on GitHub and the deployed revision as separate facts. Verify each when it matters.

## Find the code

| Area | Entry points |
| --- | --- |
| HTTP routes, static assets, and portfolio reads | `server.py` |
| Positions and portfolio UI | `index.html`, `app.js`, `dashboard-widgets.js`, `dashboard-settings.js`, `charts.js` |
| Trade history and summaries | `trades.html`, `trades.js`, `trade_summary.py` |
| Market search and live suggestions | `markets.html`, `markets.js`, `markets.css`, `market_catalog.py` |
| Market discovery and precedents | `market_discovery.py`, `precedents.py`, `precedents.js` |
| Holder analysis | `holders.py`, `holders.js`, `holders.html` |
| Watchlist and push alerts | `watchlist.py`, `watchlist.js`, `watchlist-sw.js` |
| Public exports and private Codex reviews | `public_api.py`, `review_server.py` |

Reuse `http_reads.py` and `read_cache.py` for shared upstream reads and caching. If adding a public static asset, check the route map in `server.py`; HTML responses rewrite local asset links to include a content version. Watchlists persist in SQLite and browser push uses a persistent VAPID key. Preserve existing stored data and API consumers when changing these features.

## Run and verify

```sh
python3 server.py
python3 -m unittest discover -s tests
for file in *.js; do node --check "$file" || exit; done
```

The default local URL is `http://127.0.0.1:8765`. CI runs the test suite and JavaScript syntax checks with Python 3.12 and Node.js 22. Production deployment is a separate operation. Follow the [runbook](docs/deployment.md) when a deployment is requested.
