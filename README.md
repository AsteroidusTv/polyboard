# Polyboard

A read-only dashboard for Polymarket portfolios, market discovery, and price alerts.

## Run locally

Open a terminal in the repository folder. With Python 3 and an internet connection, run:

```sh
python3 server.py
```

Open [the local dashboard](http://127.0.0.1:8765). To look up a wallet, open **Settings**, enter its public address, and click **Apply wallet**. Press Ctrl+C to stop the server. If the port is busy, run `python3 server.py --port 8766` and open [port 8766](http://127.0.0.1:8766).

The server listens on localhost and queries the [Polymarket Data API v2](https://docs.polymarket.com/migrate/data-api-v1-to-v2) for positions with status `OPEN`. A public wallet address is all you need. The core app uses Python's standard library. Browser push is optional.

## Read the table

- **Avg → Now** shows the average entry price and current price, in cents per share.
- **Cost** is the API's entry cost for the position, excluding entry fees (`entry_cost_usdc`).
- **Payout** assumes a gross payout of $1 per share if the held outcome wins.
- **Value & P&L** shows the API's current value and unrealized P&L. The percentage comes from Polymarket and appears when the entry cost is positive.
- The totals cover open positions. On narrow screens, the table switches to cards.

## Trade history

Click **Show all trades** to open the history for the saved wallet. **Positions** groups buys, sells, and payouts by market outcome, including re-entries. Filter by result or sort by P&L, return, amount invested, average buy or sell price, or activity date. Select a market title to open its transactions, newest first.

Both **Positions** and **Executions** show more rows as you scroll. Filters and sorting apply to the full history.

Net P&L adds sales, payouts, and any remaining current or claimable value, then subtracts the amounts paid for buys. The dashboard uses Polymarket's reported position P&L if activity cannot establish the full cost basis. **Executions** shows individual buys and sells, with sorting by date, price, shares, and gross amount. Gross amounts are fill price multiplied by shares before fees. The feeds are paginated through their full public history. Dates use the browser's local time.

The overview reports gross gains and gross losses across closed positions. **Win rate** is the fraction of wins among wins and losses. **Profit factor** is gross gains divided by the absolute gross losses.

**Trading fees** shows the wallet's lifetime fees charged, refunded, and paid after refunds, using the latest cumulative snapshot from [Polymarket's P&L API](https://docs.polymarket.com/api-reference/wallet/get-a-users-pnl-series).

## Charts

The portfolio chart shows cumulative realized and unrealized position P&L reported by Polymarket. Select a market title in the portfolio or trade history to see the available price series for that outcome with buy and sell markers. For a closed position, the shaded area shows the market after the last sale when later prices are available. A price history chart needs at least two observations at different times. Use the range buttons, pointer, or arrow keys to inspect the chart.

## Market precedents

Open a market from **New trade**, the portfolio, or trade history, then select **Compare with past markets** for that market's comparison. **Same family** looks for recurring questions, event series, and matching referendum families. **Broader** can add related questions and international referendums. The saved public wallet is used to identify markets you traded.

The matrix adapts its offsets to the selected market's scheduled duration. Daily markets use hours, monthly markets use days, and longer markets retain horizons up to D−90. All offsets are measured before official Polymarket resolution. The selection prioritizes markets with comparable durations and samples distinct events before repeating thresholds. Each cell shows the Yes price, whether the favorite won, and the signed gap to the result. Hover a quote to see its distance from 50%, observation time, and cutoff. Prices must come from complete observations before each cutoff, within half the offset and at most 36 hours, with a minimum tolerance of 30 seconds. Average error and calibration need five markets across three events. Reports display search limits and missing data. Each report studies up to 24 resolved binary markets.

On the hosted dashboard, **Risk check** is available beside an open market. The existing private Codex connection runs a brief recommendation based on executable quotes, market rules, comparable markets, and any positions in the same event from the configured public wallet. Reading the latest result is free of additional Codex usage. **Run risk check** and **Refresh analysis** start new analyses.

## Public exports

- `/positions?user=ADDRESS` returns open positions, prices per share in dollars, and current valuation and P&L totals in USD.
- `/trades?user=ADDRESS` returns individual buys and sells across the public history. The default page size is 250. Set `limit` from 1 to 1,000 and follow `next` until it is `null`. Trade gross amounts exclude fees.
- `/portfolio?user=ADDRESS` returns open positions, the 15 most recent trades, and market concentration as a percentage of the current value of open positions.

The exports use the public Polymarket Data API v2. Append `&format=text` for plain text. The response shows the snapshot time in UTC and successful snapshots are cached for 45 seconds on the server. The endpoints support GET and HEAD. The public `robots.txt` explicitly allows OpenAI's search crawler.

## Simulate outcomes

After loading a wallet, click **Simulate outcomes** and check the side you hold on each position you want to model as a winner. **Gross payout** is $1 per winning share. **Net P&L** subtracts the cost of the positions included in the scenario, including reported entry fees.

The default calculation covers checked positions. Enable **Value unchecked positions at $0** for a downside estimate that subtracts the cost of every open position. Check each position you want to include as a winner, including any related positions that would pay out in the same scenario. The simulator prevents checking opposite sides of a market and multiple Yes winners within a [Polymarket negative-risk event](https://docs.polymarket.com/concepts/negative-risk).

Selections stay in the page when you refresh the same wallet. Loading another wallet or reloading the page clears them.

## Review the portfolio in Codex

**Settings** remembers the applied public wallet address and the default portfolio chart range in this browser. On the hosted dashboard, open **Settings → Codex reviews** and connect with your private dashboard access key. The server creates a secure browser session for 30 days. Use **Sign out of reviews** in Settings to end the session on this browser. Reports require authentication and stay in server memory for up to an hour or until replaced.

The worker takes a new snapshot of positions and order books and fetches past buy and sell fills from the public Data API. It reviews up to twelve open holdings ranked by the larger of current value and entry cost and uses trade history to critique sizing, entries and exits. The report shows history coverage. The latest 400 fills can be included individually, with older retrieved fills summarized by month and side. Large or unavailable feeds may be partial.

While a review runs, the panel shows its current stage and elapsed time. At completion it shows tokens reported for the review and, when available, account-level Codex quota readings before and after. Other Codex activity can affect the quota readings.

## New trade

Open **New trade** or go to `/markets` to browse open markets without a wallet. **Trending** ranks events by 24-hour volume. Search by title or paste a Polymarket event or market link. Filters apply to individual markets, and events group the matches. Select a card to see its markets or open its sole market directly. The market detail shows price history and offers **Compare with past markets** where supported.

The event overview charts up to four markets and lists all matching submarkets with their current indicative prices. Select a series in the legend to hide or show it, or open a row to inspect that market.

Use **Filters** to select a Yes or No price band, a scheduled end range, minimum liquidity, maximum spread, or categories to hide. Applied filters are saved in a browser cookie and shown as removable chips. Filter parameters in a shared URL take precedence. Catalogue and search results load more as you scroll, with a **Load more** button also available. The catalogue is read-only and uses the public [Polymarket Gamma API](https://docs.polymarket.com/api-reference/events/list-events-keyset-pagination).

### Watchlist and price alerts

Select **Follow** in a market’s price-history dialog. **Watchlist** under **New trade** shows followed markets and their alerts. An alert can track either outcome crossing a price in cents or moving by a percentage from its midpoint when you followed it. The dashboard checks the public order-book midpoints about once a minute. Each alert fires once and can be rearmed from the Watchlist. The notification bell lists triggered alerts and links to the market’s chart.

The dashboard stores follows and alerts in SQLite, tied to an HttpOnly cookie in the current browser. Set `POLYMARKET_WATCHLIST_DIR` to a writable private directory to override the default `~/.local/state/polymarket-dashboard` (or the service’s `STATE_DIRECTORY`). For optional browser notifications, install `requirements-push.txt` and set `POLYMARKET_PUSH_CONTACT` to a valid `mailto:` or HTTPS contact for VAPID. Serve the dashboard over HTTPS and use **Enable browser alerts** in the notification dialog. Keep the private VAPID key in the same state directory across deployments. The dashboard can still record alerts in the bell when browser push is disabled.

## Find markets

On the hosted dashboard, load a wallet and click **Find markets** in Portfolio or **Personalized picks** in New trade. It uses the same private review key. The worker scans open Polymarket markets with at least $500 in reported liquidity, shortlists by trade history and spread, and checks the shortlisted order books. Codex returns up to five related markets and up to two exploratory ideas with reasons to pass and a trigger to watch. The report shows scan coverage.

### Hosted review worker

`review_server.py` listens on loopback port 4313. It runs Codex in a separate service account signed in with ChatGPT. Set `REVIEW_KEY_DIGEST_FILE` to a protected file containing the SHA-256 digest of a randomly generated 32-byte base64url access key without padding. Set `REVIEW_CODEX_BIN` if Codex is outside the service's path. The worker needs a writable state directory for hashed browser session tokens (`STATE_DIRECTORY`, with `CODEX_HOME` as the fallback). Proxy only `/api/reviews` over HTTPS, preserve the host and origin headers, and enable the hosted controls with the `data-review-enabled` attribute on `<body>` in the dashboard pages. Keep the access key and the Codex session files outside the source tree.

## Check the live connection

With the server running, execute this command in another terminal:

```sh
curl -fsS 'http://127.0.0.1:8765/api/positions?wallet=PUBLIC_WALLET_ADDRESS' | python3 -c 'import json, sys; print(len(json.load(sys.stdin)["positions"]), "open positions")'
```

Replace `PUBLIC_WALLET_ADDRESS` with the public wallet you want to check.
