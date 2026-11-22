"use strict";

const byId = (id) => document.getElementById(id);
const refresh = byId("refresh");
const results = byId("trade-results");
const error = byId("error");
const loading = byId("trade-loading");
const tradeTable = byId("trade-table");
const tradeRows = byId("trade-rows");
const search = byId("trade-search");
const side = byId("trade-side");
const order = byId("trade-order");
const pagination = byId("trade-pagination");
const observeTradeScroll = DashboardWidgets.loadOnScroll(pagination, appendTrades);
const pageSize = 25;
const counts = new Intl.NumberFormat("en-US");
const shares = new Intl.NumberFormat("en-US", {minimumFractionDigits: 1, maximumFractionDigits: 1});
const cents = new Intl.NumberFormat("en-US", {maximumFractionDigits: 2});
const dollars = new Intl.NumberFormat("en-US", {style: "currency", currency: "USD"});
const signedDollars = new Intl.NumberFormat("en-US", {style: "currency", currency: "USD", signDisplay: "exceptZero"});
const returns = new Intl.NumberFormat("en-US", {style: "percent", maximumFractionDigits: 1, signDisplay: "exceptZero"});
const tradeDate = new Intl.DateTimeFormat("en-US", {dateStyle: "medium"});
const tradeTime = new Intl.DateTimeFormat("en-US", {timeStyle: "short"});
const positionsView = byId("view-positions");
const executionsView = byId("view-executions");
const historyOverview = byId("history-overview");
const statusLabels = DashboardWidgets.statuses;
const winRate = new Intl.NumberFormat("en-US", {style: "percent", maximumFractionDigits: 1});
const factor = new Intl.NumberFormat("en-US", {maximumFractionDigits: 2});
const exitHeading = "Avg buy → exit";
const views = {
  positions: {
    headings: ["Market", exitHeading, "Invested", "Last activity", "Net P&L"],
    filters: [["", "All statuses"], ...Object.entries(statusLabels)],
    sorts: [
      ["Recent activity", "last_activity", -1, 3], ["Oldest activity", "last_activity", 1, 3],
      ["Highest profit", "pnl", -1, 4], ["Biggest loss", "pnl", 1, 4],
      ["Highest return", "roi", -1, 4], ["Lowest return", "roi", 1, 4],
      ["Most invested", "invested", -1, 2], ["Least invested", "invested", 1, 2],
      ["Highest buy price", "entry_price", -1, 1], ["Lowest buy price", "entry_price", 1, 1],
      ["Highest exit price", "exit_price", -1, 1], ["Lowest exit price", "exit_price", 1, 1]
    ]
  },
  executions: {
    headings: ["Market", "Side", "Price", "Shares", "Gross amount", "Date"],
    filters: [["", "All sides"], ["BUY", "Buys"], ["SELL", "Sells"]],
    sorts: [
      ["Newest first", "timestamp", -1, 5], ["Oldest first", "timestamp", 1, 5],
      ["Highest price", "price", -1, 2], ["Lowest price", "price", 1, 2],
      ["Most shares", "size", -1, 3], ["Fewest shares", "size", 1, 3],
      ["Largest amount", "gross", -1, 4], ["Smallest amount", "gross", 1, 4]
    ]
  }
};
let view = "positions";
let records = [];
let loadedWallet = "";
const historyCache = new Map();
let matching = [];
let currentRequest;

function element(tag, className, label) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (label !== undefined) node.textContent = label;
  return node;
}

function cell(label, value) {
  const td = element("td");
  const caption = element("span", "cell-label", label);
  caption.setAttribute("aria-hidden", "true");
  td.append(caption, value);
  return td;
}

function marketCell(trade, title = element("span", "title", trade.title || "Unknown market")) {
  const td = element("td");
  const market = element("div", "market");
  if (trade.is_combo || (typeof trade.icon === "string" && trade.icon.startsWith("https://"))) {
    const image = element("img", trade.is_combo ? "icon combo-icon" : "icon");
    image.src = trade.is_combo ? "/combo.svg" : trade.icon;
    image.alt = "";
    if (trade.is_combo) image.title = "Polymarket Combo";
    image.loading = "lazy";
    image.addEventListener("error", () => image.remove(), {once: true});
    market.append(image);
  }
  const details = element("div");
  details.append(title);
  const badges = DashboardWidgets.positionBadges(trade);
  if (badges.length) {
    const meta = element("div", "meta");
    meta.append(...badges);
    details.append(meta);
  }
  market.append(details);
  td.append(market);
  return td;
}

function displayPrice(value) {
  return Number.isFinite(value) ? cents.format(value * 100) + "¢" : "—";
}

function displayShares(value) {
  return Number.isFinite(value) ? shares.format(value) : "—";
}

function displayDate(timestamp, withTime = false) {
  const date = new Date(Number.isFinite(timestamp) ? timestamp * 1000 : NaN);
  if (!Number.isFinite(date.getTime())) return "—";
  const time = element("time", withTime ? "trade-date" : "muted");
  time.dateTime = date.toISOString();
  if (withTime) {
    time.append(element("span", "", tradeDate.format(date)), element("span", "muted", tradeTime.format(date)));
  } else {
    time.textContent = tradeDate.format(date);
  }
  return time;
}

function tradeRow(trade) {
  const row = element("tr");
  const action = trade.side === "BUY" ? "Buy" : trade.side === "SELL" ? "Sell" : "—";
  const actionClass = trade.side === "BUY" ? " yes" : trade.side === "SELL" ? " no" : "";
  const fill = {...trade, type: "TRADE", usdc_size: trade.gross};
  const title = /^\d{1,78}$/.test(trade.token_id || "") ? DashboardWidgets.marketTitle(trade, () => {
    const summary = historyCache.get("positions")?.rows.find((position) => position.token_id === trade.token_id);
    DashboardWidgets.openPosition({...trade, executions: [fill]}, DashboardSettings.wallet, {fill, summary});
  }) : undefined;
  row.append(marketCell(trade, title), cell("Side", element("span", "side" + actionClass, action)),
    cell("Price", displayPrice(trade.price)), cell("Shares", displayShares(trade.size)),
    cell("Gross amount", formatMoney(trade.gross)), cell("Date", displayDate(trade.timestamp, true)));
  return row;
}

function searchableTitle(text) {
  return String(text).toLocaleLowerCase("en-US").normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

function formatMoney(value, format = dollars) {
  return Number.isFinite(value) ? format.format(Math.abs(value) < .005 ? 0 : value) : "—";
}

function pnlColor(value) {
  return value >= .005 ? "positive" : value <= -.005 ? "negative" : "";
}

function positionRow(position) {
  const row = element("tr");
  const title = DashboardWidgets.marketTitle(position, () => DashboardWidgets.openPosition(position));

  const pnl = element("span");
  pnl.append(element("strong", pnlColor(position.pnl), formatMoney(position.pnl, signedDollars)));
  if (Number.isFinite(position.roi)) pnl.append(element("span", "pnl muted", returns.format(position.roi)));

  const prices = element("span", "position-prices");
  prices.append(element("span", "muted", displayPrice(position.entry_price)),
    element("span", "muted", "→"),
    element("span", "", displayPrice(position.exit_price ?? position.settlement_price)));
  const priceGroup = element("span", "position-price-group");
  priceGroup.append(prices);
  if (Number.isFinite(position.settlement_price)) {
    const label = Number.isFinite(position.exit_price) ? `Settled at ${displayPrice(position.settlement_price)}` : "Settlement";
    priceGroup.append(element("small", "price-settlement muted", label));
  }

  row.append(marketCell(position, title), cell(exitHeading, priceGroup),
    cell("Invested", formatMoney(position.invested)), cell("Last activity", displayDate(position.last_activity)),
    cell("Net P&L", pnl));
  return row;
}

function updateOverview(fees) {
  const grouped = view === "positions";
  historyOverview.hidden = byId("history-fees").hidden = !grouped;
  if (!grouped) return;
  byId("fee-net").textContent = formatMoney(fees?.net_paid_usd);
  byId("fee-charged").textContent = formatMoney(fees?.charged_usd);
  byId("fee-refunded").textContent = formatMoney(fees?.refunded_usd);

  const closed = records.filter((row) => ["won", "lost", "even"].includes(row.status));
  const won = closed.filter((row) => row.status === "won");
  const lost = closed.filter((row) => row.status === "lost");
  const gains = won.reduce((amount, row) => amount + row.pnl, 0);
  const losses = lost.reduce((amount, row) => amount + row.pnl, 0);
  const total = closed.reduce((amount, row) => amount + row.pnl, 0);
  const decided = won.length + lost.length;
  const pnl = byId("history-pnl");
  pnl.className = pnlColor(total);
  pnl.textContent = formatMoney(total, signedDollars);
  byId("history-gains").textContent = formatMoney(gains, signedDollars);
  byId("history-losses").textContent = formatMoney(losses, signedDollars);
  byId("history-record").textContent = counts.format(won.length) + " profit · " + counts.format(lost.length) + " loss";
  byId("history-win-rate").textContent = decided ? winRate.format(won.length / decided) : "—";
  byId("history-profit-factor").textContent = losses < 0 ? factor.format(gains / -losses) + "×" : "—";
  byId("history-open").textContent = counts.format(records.filter((row) => row.status === "open").length);
}

function configureView() {
  const config = views[view];
  const grouped = view === "positions";
  positionsView.setAttribute("aria-pressed", grouped);
  executionsView.setAttribute("aria-pressed", !grouped);
  byId("history-filter-label").textContent = grouped ? "Status" : "Side";
  byId("history-method").hidden = !grouped;
  side.replaceChildren(...config.filters.map(([value, name]) => new Option(name, value)));
  order.replaceChildren(...config.sorts.map(([name], index) => new Option(name, index)));
  byId("trade-columns").replaceChildren(...config.headings.map(() => element("col")));
  byId("trade-headings").replaceChildren(...config.headings.map((name) => {
    const heading = element("th", "", name);
    heading.scope = "col";
    return heading;
  }));
  tradeTable.setAttribute("aria-label", grouped ? "Position history" : "Trade executions");
  tradeTable.classList.toggle("is-position-history", grouped);
}

function renderTrades(keepRows = false) {
  const grouped = view === "positions";
  const query = searchableTitle(search.value.trim());
  const activeSide = side.value;
  matching = records.filter((trade) => (!activeSide || (grouped ? trade.status : trade.side) === activeSide) &&
    searchableTitle(trade.title || "").includes(query));
  const [, key, direction, column] = views[view].sorts[Number(order.value)];
  const sortValue = (trade) => key === "exit_price" ? trade.exit_price ?? trade.settlement_price : trade[key];
  matching.sort((a, b) => {
    const first = sortValue(a);
    const second = sortValue(b);
    if (!Number.isFinite(first)) return Number.isFinite(second) ? 1 : 0;
    if (!Number.isFinite(second)) return -1;
    return direction * (first - second);
  });

  const label = grouped ? "position" : "trade";
  const noMatches = byId("no-matches");
  noMatches.hidden = matching.length > 0;
  noMatches.textContent = records.length
    ? "No " + label + "s match these filters."
    : "No " + label + "s found for this wallet.";
  tradeTable.hidden = matching.length === 0;
  const headings = byId("trade-headings").children;
  for (const heading of headings) heading.removeAttribute("aria-sort");
  headings[column].setAttribute("aria-sort", direction === 1 ? "ascending" : "descending");
  const restoreRows = keepRows ? Math.max(pageSize, tradeRows.childElementCount) : pageSize;
  tradeRows.replaceChildren();
  appendTrades(restoreRows);
}

function appendTrades(limit = pageSize) {
  if (results.hidden) return;
  const start = tradeRows.childElementCount;
  const end = Math.min(start + (typeof limit === "number" ? limit : pageSize), matching.length);
  tradeRows.append(...matching.slice(start, end).map(view === "positions" ? positionRow : tradeRow));
  const label = view === "positions" ? "position" : "trade";
  const total = counts.format(matching.length) + " " + label + (matching.length === 1 ? "" : "s");
  byId("trade-count").textContent = end < matching.length ? counts.format(end) + " of " + total : total;
  pagination.hidden = end >= matching.length;
  observeTradeScroll(!pagination.hidden);
}

async function loadTrades(force = false) {
  const address = DashboardSettings.wallet;
  if (!address) return DashboardSettings.open();

  currentRequest?.abort();
  const request = new AbortController();
  currentRequest = request;
  if (force || loadedWallet !== address) historyCache.clear();
  loadedWallet = address;
  const group = view === "positions";
  const requestedView = view;
  let fetched = [];
  let fees = null;
  let partial = false;
  let rendered = false;
  const seen = new Set();
  let cursor = null;
  byId("wallet-empty").hidden = true;
  refresh.disabled = true;
  results.hidden = true;
  observeTradeScroll(false);
  error.hidden = true;
  const coverage = byId("history-coverage");
  coverage.hidden = true;
  loading.hidden = false;
  loading.textContent = group ? "Loading position history…" : "Loading executions…";
  const cached = historyCache.get(view);
  function reveal(keepRows = false) {
    records = fetched;
    results.hidden = false;
    updateOverview(fees);
    renderTrades(keepRows);
    rendered = true;
  }
  try {
    if (cached) {
      fetched = cached.rows;
      fees = cached.fees;
      partial = cached.partial;
    } else if (group) {
      const query = new URLSearchParams({wallet: address});
      if (force) query.set("fresh", "1");
      const response = await fetch("/api/trade-summary?" + query, {
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(25000)])
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to load positions.");
      if (!Array.isArray(data.positions)) throw new Error("Polymarket returned unreadable positions.");
      fetched = data.positions;
      fees = data.trading_fees;
      partial = Boolean(data.partial);
    } else {
      do {
        const params = new URLSearchParams({wallet: address});
        if (cursor) params.set("cursor", cursor);
        const response = await fetch("/api/trades?" + params, {
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)])
        });
        const batch = await response.json();
        if (request !== currentRequest) return;
        if (!response.ok) throw new Error(batch.error || "Unable to load trades.");
        if (!Array.isArray(batch.trades) || !batch.trades.every((trade) => trade && typeof trade === "object")) {
          throw new Error("Polymarket returned an unreadable trade page.");
        }
        for (const trade of batch.trades) {
          trade.gross = Number.isFinite(trade.price) && Number.isFinite(trade.size) ? trade.price * trade.size : null;
          fetched.push(trade);
        }
        cursor = batch.next_cursor;
        if (cursor !== null) {
          if (typeof cursor !== "string" || !cursor || seen.has(cursor)) {
            throw new Error("Polymarket returned an invalid history cursor.");
          }
          seen.add(cursor);
        }
        if (cursor) {
          coverage.textContent = counts.format(fetched.length) + " executions loaded. Search and sorting use the available rows while the rest load.";
          coverage.hidden = false;
          loading.hidden = true;
          if (!rendered || !tradeRows.contains(document.activeElement)) reveal(rendered);
        }
      } while (cursor !== null);
    }
  } catch (failure) {
    if (request !== currentRequest) return;
    const message = ["TimeoutError", "TypeError", "SyntaxError"].includes(failure.name)
      ? "Connection interrupted. Try refreshing in a moment."
      : failure.message;
    error.textContent = fetched.length ? "History is incomplete. " + message : message;
    error.hidden = false;
  }
  if (request !== currentRequest) return;
  currentRequest = undefined;
  refresh.disabled = false;
  loading.hidden = true;
  if (fetched.length || error.hidden) {
    if (rendered && tradeRows.contains(document.activeElement)) {
      records = fetched;
      const currentView = view;
      tradeRows.addEventListener("focusout", () => {
        queueMicrotask(() => {
          if (view === currentView && records === fetched && !tradeRows.contains(document.activeElement)) renderTrades(true);
        });
      }, {once: true});
    } else reveal(rendered);
    if (cached) DashboardWidgets.softUpdate(results);
  }
  coverage.textContent = partial ? "Partial history. Statistics cover the available positions only."
    : !error.hidden && !group && fetched.length ? "Search and sorting cover the executions loaded so far." : "";
  coverage.hidden = !coverage.textContent;
  if (error.hidden) {
    historyCache.set(requestedView, {rows: fetched, fees, partial});
  }
}

refresh.addEventListener("click", () => loadTrades(true));
for (const [control, event] of [[search, "input"], [side, "change"], [order, "change"]]) {
  control.addEventListener(event, renderTrades);
}
byId("more-trades").addEventListener("click", appendTrades);

function showView(nextView) {
  if (view === nextView) return;
  currentRequest?.abort();
  currentRequest = undefined;
  view = nextView;
  configureView();
  results.hidden = true;
  loading.hidden = true;
  if (DashboardSettings.wallet) loadTrades();
}

positionsView.addEventListener("click", () => showView("positions"));
executionsView.addEventListener("click", () => showView("executions"));
configureView();

DashboardSettings.configure({onWallet: () => loadTrades(true)});
if (DashboardSettings.wallet) loadTrades();
else byId("wallet-empty").hidden = false;
