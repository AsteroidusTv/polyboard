"use strict";

const byId = (id) => document.getElementById(id);
const refresh = byId("refresh");
const status = byId("status");
const error = byId("error");
const results = byId("results");
const totals = byId("totals");
const count = byId("count");
const positionsInfo = byId("positions-info");
const empty = byId("empty");
const body = byId("positions");
const positionSort = byId("position-sort");
const sortDirectionButton = byId("sort-direction");
const sortButtons = [...document.querySelectorAll(".sort-button")];
const scenarioToggle = byId("scenario-toggle");
const scenarioDefault = byId("scenario-default");
const scenarioClear = byId("scenario-clear");
const conflict = byId("scenario-conflict");
const codexToggle = byId("codex-toggle");
const codexActions = byId("codex-actions");
const reviewToggle = byId("review-toggle");
const reviewDialog = byId("review-dialog");
const findToggle = byId("find-toggle");
let openDiscoveryOnLoad = new URLSearchParams(location.search).get("find") === "1";
const directReview = DashboardSettings.reviewEnabled;
const reviewRun = byId("review-run");
const reviewConnect = byId("review-connect");
const reviewProgress = byId("review-progress");
const reviewReport = byId("review-report");
const reviewActivity = byId("review-activity");
const reviewUsage = byId("review-usage");
const reviewDots = byId("review-meter");
let positionRequest;
let reviewWallet = "";
let reviewMode = "review";
let reviewAttempt = 0;
const scenarioOverrides = new Map();
const scenarioLabels = {win: "Win", hold: "Keep value", lose: "Lose", sell: "Sell now", exclude: "Exclude"};
let openPositions = [];
let sortKey = "current_value";
let sortDirection = "descending";
let displayedWallet = "";
let updatedAt = "";

const formatter = (options) => new Intl.NumberFormat("en-US", options);
const dollars = formatter({style: "currency", currency: "USD", currencyDisplay: "narrowSymbol"});
const compactDollars = formatter({style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1});
const marketPercent = formatter({style: "percent", maximumFractionDigits: 1});
const signedDollars = formatter({style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", signDisplay: "exceptZero"});
const signedPercent = formatter({style: "percent", maximumFractionDigits: 2, signDisplay: "exceptZero"});
const shares = formatter({maximumFractionDigits: 4});
const positionShares = formatter({minimumFractionDigits: 1, maximumFractionDigits: 1});
const cents = formatter({maximumFractionDigits: 3});
const countNumber = formatter({maximumFractionDigits: 0});
const percentage = formatter({maximumFractionDigits: 2});
const clock = new Intl.DateTimeFormat("en-US", {timeStyle: "medium"});
const marketNames = new Intl.Collator("en-US", {sensitivity: "base", numeric: true});
const color = (value) => value > 0 ? "positive" : value < 0 ? "negative" : "";
const displayPrice = (price) => cents.format(price * 100) + " ¢";
const sum = (positions, amount) => positions.reduce((total, position) => total + amount(position), 0);
const available = (value, format) => Number.isFinite(value) ? format(value) : "—";

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function cell(label, ...children) {
  const td = element("td");
  const caption = element("span", "cell-label", label);
  caption.setAttribute("aria-hidden", "true");
  td.append(caption, ...children);
  return td;
}

function syncScenario() {
  const fallback = scenarioDefault.value;
  const groups = {win: [], hold: [], lose: [], sell: [], exclude: []};
  for (const position of openPositions) groups[scenarioOverrides.get(position.token_id) || fallback].push(position);
  const {win, hold, lose, sell, exclude} = groups;
  const included = [...win, ...hold, ...lose, ...sell];
  const payout = sum(win, (position) => position.current_size);
  const kept = sum(hold, (position) => position.current_value);
  const saleCash = sum(sell, (position) => position.current_value);
  const projected = payout + kept + saleCash;
  const current = sum(included, (position) => position.current_value);
  const cost = sum(included, (position) =>
    position.total_cost_usdc ?? position.entry_cost_usdc + (position.entry_fees_usdc ?? 0));
  const message = scenarioConflict(win, lose);
  const showAmounts = included.length > 0 && !message;
  const counts = [[win, "win", "wins"], [hold, "kept"], [lose, "loss", "losses"], [sell, "sold"], [exclude, "excluded"]];
  byId("scenario-count").textContent = counts.filter(([rows]) => rows.length).map(([rows, singular, plural = singular]) =>
    rows.length + " " + (rows.length === 1 ? singular : plural)).join(" · ");
  const breakdown = byId("scenario-scope");
  breakdown.textContent = showAmounts ? [
    win.length ? dollars.format(payout) + " at resolution" : "",
    hold.length ? dollars.format(kept) + " kept at current value" : ""
  ].filter(Boolean).join(" · ") : "";
  breakdown.hidden = !breakdown.textContent;
  byId("scenario-exit-note").hidden = !sell.length;
  byId("scenario-sale-cash").textContent = dollars.format(saleCash);
  byId("scenario-change-label").textContent = exclude.length ? "vs. included positions" : "vs. current value";
  byId("scenario-value").textContent = showAmounts ? dollars.format(projected) : "—";
  for (const [id, amount] of [["scenario-change", projected - current], ["scenario-pnl", projected - cost]]) {
    const field = byId(id);
    field.textContent = showAmounts ? signedDollars.format(amount) : "—";
    field.className = showAmounts ? color(Math.round(amount * 100)) : "";
  }
  conflict.textContent = message;
  conflict.hidden = !message;
  scenarioClear.disabled = !scenarioOverrides.size;
  for (const select of body.querySelectorAll(".scenario-position")) {
    select.options[0].textContent = "Default · " + scenarioLabels[fallback];
    select.value = scenarioOverrides.get(select.dataset.token) || "";
    select.dataset.outcome = select.value || fallback;
  }
}

function scenarioConflict(wins, losses) {
  const conditions = new Map();
  const events = new Map();
  for (const [positions, winning] of [[wins, true], [losses, false]]) {
    for (const position of positions) {
      if (!position.condition_id) continue;
      const side = String(position.outcome).trim().toLowerCase();
      const outcome = winning ? side : side === "yes" ? "no" : side === "no" ? "yes" : "";
      if (!outcome || outcome === "—") continue;
      const previous = conditions.get(position.condition_id);
      if (previous && previous !== outcome) return "The outcomes conflict on “" + position.title + "”. Change one position’s scenario.";
      conditions.set(position.condition_id, outcome);
      if (outcome !== "yes" || !position.negative_risk || !position.event_id) continue;
      const other = events.get(position.event_id);
      if (other && other.condition_id !== position.condition_id) {
        return "“" + other.title + "” and “" + position.title + "” can’t both resolve Yes. Change one position’s scenario.";
      }
      events.set(position.event_id, position);
    }
  }
  return "";
}

function setScenarioOpen(open) {
  scenarioToggle.setAttribute("aria-expanded", open);
  scenarioToggle.textContent = open ? "Close simulator" : "Simulate outcomes";
  results.classList.toggle("is-simulating", open);
  byId("scenario-tools").hidden = byId("scenario-summary").hidden = !open;
  conflict.hidden = true;
  if (open) syncScenario();
}

function appendList(parent, label, items) {
  if (items.length === 0) return;
  const list = element("ul");
  list.append(...items.map((item) => element("li", "", item)));
  parent.append(element("h3", "", label), list);
}

function reviewPriceLine(position) {
  const mark = "Mark " + displayPrice(position.current_price);
  const book = position.book;
  if (book.status === "stale") return mark + " · Order book stale";
  if (book.status !== "available") return mark + " · Order book unavailable";
  if (book.best_bid === null) return mark + " · No bids";
  const spread = book.spread === null ? "" : " · Spread " + displayPrice(book.spread);
  const unfilled = book.unfilled_shares > 0 ? " · " + shares.format(book.unfilled_shares) + " shares unfilled" : "";
  return mark + " · Best bid " + displayPrice(book.best_bid) + spread +
    " · Gross exit estimate " + dollars.format(book.gross_exit_value) + unfilled;
}

function reviewEntryLine(position) {
  const timeline = position.entry_timeline;
  if (!timeline) return "";
  const entryDate = (stamp) => new Date(stamp * 1000).toLocaleDateString("en-US", {dateStyle: "medium"});
  const parts = [timeline.first_recorded_entry ? "First recorded entry " + entryDate(timeline.first_recorded_entry) : "Entry date unavailable"];
  if (Number.isFinite(position.avg_price)) parts.push("Avg. paid " + displayPrice(position.avg_price));
  if (timeline.latest_buy && timeline.latest_buy.at !== timeline.first_recorded_entry) {
    parts.push("Latest buy " + entryDate(timeline.latest_buy.at) + " at " + displayPrice(timeline.latest_buy.price));
  }
  const history = position.market_history;
  if (history?.state === "available" && history.observations >= 2) {
    parts.push("Observed range " + displayPrice(history.low[1]) + "–" + displayPrice(history.high[1]));
  }
  return parts.join(" · ");
}

function historyCoverage(history) {
  if (!history || history.state === "unavailable") return "Trade history unavailable";
  let coverage = countNumber.format(history.detailed) + " trade fills in detail";
  if (history.detailed < history.fetched) coverage += " · " + countNumber.format(history.fetched - history.detailed) + " summarized";
  if (history.state === "partial") coverage += " · Partial history";
  return coverage;
}

function renderReview({snapshot, report}) {
  const overview = element("div", "report-overview");
  const time = new Date(snapshot.as_of).toLocaleString("en-US", {dateStyle: "medium", timeStyle: "short"});
  overview.append(element("p", "muted report-prices", time + " · " + snapshot.positions.length + " of " + snapshot.open_count + " open positions reviewed"),
    element("p", "muted report-prices", historyCoverage(snapshot.trade_history)));
  if (snapshot.positions.some((position) => position.market_history)) {
    const covered = snapshot.positions.filter((position) => position.market_history?.observations >= 2).length;
    overview.append(element("p", "muted report-prices", "Price history available for " + covered + " of " + snapshot.positions.length + " positions"));
  }
  overview.append(element("p", "", report.summary));
  appendList(overview, "Priorities", report.priorities);
  appendList(overview, "Watchlist", report.watchlist);
  appendList(overview, "Lessons from past trades", report.history_insights || []);
  const positions = new Map(snapshot.positions.map((position) => [position.token_id, position]));
  const cards = report.holdings.map((holding) => {
    const position = positions.get(holding.token_id);
    const card = element("section", "report-position");
    const details = element("dl");
    for (const [label, value] of [
      ["Evidence", holding.evidence],
      ["Price and entry history", holding.price_context],
      ["Case against holding", holding.case_against],
      ["Counterargument", holding.counterargument],
      ["What would change the call", holding.trigger]
    ]) {
      if (!value) continue;
      const group = element("div");
      group.append(element("dt", "", label), element("dd", "", value));
      details.append(group);
    }
    const sources = element("ul");
    for (const source of holding.sources) {
      if (!URL.canParse(source.url)) continue;
      const url = new URL(source.url);
      if (url.protocol !== "https:" || url.username || url.password) continue;
      const item = element("li");
      const link = element("a", "", source.title);
      link.href = url.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      item.append(link);
      sources.append(item);
    }
    const side = position.outcome === "Yes" ? " yes" : position.outcome === "No" ? " no" : "";
    const stance = element("p", "report-prices");
    stance.append(element("span", "side" + side, position.outcome), " · " + holding.stance);
    card.append(element("h3", "", position.title), stance);
    const entry = reviewEntryLine(position);
    if (entry) card.append(element("p", "muted report-prices", entry));
    card.append(element("p", "muted report-prices", reviewPriceLine(position)), details);
    if (sources.childElementCount) card.append(sources);
    return card;
  });
  reviewReport.replaceChildren(overview, ...cards);
  reviewReport.hidden = false;
}

function discoveryMarketCard(market, idea) {
  const card = element("section", "report-position discovery-market");
  const title = element("h3", "", market.title);
  const identity = element("div", "discovery-market-identity");
  if (typeof market.icon === "string" && market.icon.startsWith("https://")) {
    const icon = element("img", "icon");
    icon.src = DashboardWidgets.marketImageSource(market.icon);
    icon.alt = "";
    icon.loading = "lazy";
    icon.addEventListener("error", () => icon.remove(), {once: true});
    identity.append(icon);
  }
  const description = element("div");
  description.append(title);
  if (market.event_title && market.event_title !== market.title) {
    description.append(element("p", "muted discovery-event", market.event_title));
  }
  identity.append(description);

  const book = market.yes_book;
  const bookAge = Date.now() - Number(book?.exchange_timestamp);
  const twoSided = market.state !== "closed" && book?.status === "available" && bookAge >= -30000 && bookAge <= 300000
    && Number.isFinite(book.best_bid) && Number.isFinite(book.best_ask);
  const midpoint = twoSided ? (book.best_bid + book.best_ask) / 2 : null;
  const quotes = market.indicative_prices || {};
  const indicativePrices = {
    yes: quotes.yes ?? (market.state == null ? midpoint : null),
    no: quotes.no ?? (market.state == null && midpoint !== null ? 1 - midpoint : null)
  };
  const prices = element("div", "discovery-prices");
  prices.append(element("span", "muted discovery-prices-label", "Indicative prices"));
  for (const side of ["Yes", "No"]) {
    const price = indicativePrices[side.toLowerCase()];
    if (Number.isFinite(price)) prices.append(element("span", "side " + side.toLowerCase(), side + " " + marketPercent.format(price)));
  }
  if (prices.childElementCount === 1) prices.append(element("span", "muted", market.state === "closed" ? "Trading closed" : "Unavailable"));
  const header = element("header", "discovery-market-header");
  header.append(identity, prices);
  card.append(header);

  const stats = element("div", "muted discovery-stats");
  if (market.end_date && Number.isFinite(Date.parse(market.end_date))) {
    const end = new Date(market.end_date).toLocaleDateString("en-US", {dateStyle: "medium"});
    stats.append(element("span", "", "Scheduled end " + end));
  }
  if (Number.isFinite(market.liquidity_usd)) stats.append(element("span", "", compactDollars.format(market.liquidity_usd) + " liquidity"));
  if (Number.isFinite(market.volume_24h_usd) && market.volume_24h_usd > 0) {
    stats.append(element("span", "", compactDollars.format(market.volume_24h_usd) + " 24h volume"));
  }
  if (twoSided) stats.append(element("span", "", "Yes spread " + displayPrice(book.best_ask - book.best_bid)));
  else if (market.state !== "closed" && (book?.status === "stale" || bookAge > 300000)) {
    stats.append(element("span", "", "Order book stale"));
  }
  const marketMeta = element("div", "discovery-market-meta");
  if (stats.childElementCount) marketMeta.append(stats);
  const openMarket = element("button", "secondary-button discovery-open-market", "Show trade");
  openMarket.type = "button";
  openMarket.setAttribute("aria-haspopup", "dialog");
  openMarket.setAttribute("aria-label", "Show trade · " + market.title);
  openMarket.addEventListener("click", () => DashboardWidgets.openMarket({
    ...market, slug: marketSlug(market), indicative_prices: indicativePrices
  }));
  marketMeta.append(openMarket);
  card.append(marketMeta);

  const details = element("dl", "discovery-notes");
  for (const [name, value] of [["Why track it", idea.interest], ["Reason to pass", idea.countercase], ["What to watch", idea.watch_trigger]]) {
    const row = element("div");
    row.append(element("dt", "", name), element("dd", "", value));
    details.append(row);
  }
  card.append(details);
  return card;
}

function marketSlug(market) {
  if (!URL.canParse(market.url)) return "";
  return new URL(market.url).pathname.split("/").filter(Boolean).at(-1) || "";
}

async function loadDiscoveryMetadata(snapshot) {
  const slugs = new Set([...snapshot.similar, ...snapshot.exploratory].map(marketSlug).filter(Boolean));
  if (!slugs.size) return {};
  const params = new URLSearchParams();
  for (const slug of slugs) params.append("market", slug);
  try {
    const response = await fetch("/api/market-metadata?" + params, {signal: AbortSignal.timeout(6000)});
    if (response.ok) return (await response.json()).markets;
  } catch {
    // The research notes can still render when current metadata is unavailable.
  }
  return {};
}

async function renderDiscovery(data, attempt) {
  const {snapshot, report} = data;
  showReviewProgress({...data, state: "running", phase: "market-details"});
  const metadata = await loadDiscoveryMetadata(snapshot);
  if (attempt !== reviewAttempt) return;
  const overview = element("div", "report-overview");
  const time = new Date(snapshot.as_of).toLocaleString("en-US", {dateStyle: "medium", timeStyle: "short"});
  const floor = snapshot.minimum_liquidity_usd ? " · Minimum liquidity " + dollars.format(snapshot.minimum_liquidity_usd) : "";
  const coverage = countNumber.format(snapshot.markets_scanned) + " open markets scanned" + floor +
    (snapshot.catalog_complete ? "" : " · Partial catalogue");
  overview.append(
    element("p", "muted report-prices", time + " · " + coverage),
    element("p", "", report.profile),
    element("p", "muted report-prices", historyCoverage(snapshot.trade_history))
  );
  const content = [overview];
  for (const [group, label] of [["similar", "Similar to your trades"], ["exploratory", "Exploratory picks"]]) {
    if (!report[group].length) continue;
    content.push(element("h3", "market-group-heading", label));
    const markets = new Map(snapshot[group].map((row) => [row.market_id, row]));
    for (const idea of report[group]) {
      const market = markets.get(idea.market_id);
      if (market) content.push(discoveryMarketCard({...market, ...metadata?.[marketSlug(market)]}, idea));
    }
  }
  if (content.length === 1) content.push(element("p", "muted", "No watchlist ideas met the evidence and liquidity criteria."));
  reviewReport.replaceChildren(...content);
  reviewReport.hidden = false;
}

function quotaLabel(minutes) {
  if (!minutes) return "Codex quota";
  if (minutes % 1440 === 0) return minutes / 1440 + "-day Codex quota";
  if (minutes % 60 === 0) return minutes / 60 + "-hour Codex quota";
  return minutes + "-minute Codex quota";
}

function usageItem(label, value, detail) {
  const row = element("div");
  row.append(element("dt", "", label), element("dd", "", value));
  if (detail) row.append(element("p", "muted usage-detail", detail));
  return row;
}

function renderUsage(data) {
  const rows = [];
  const tokens = data.tokens;
  if (Number.isInteger(tokens?.input_tokens) && Number.isInteger(tokens?.output_tokens)) {
    const input = countNumber.format(tokens.input_tokens) + " input";
    const output = countNumber.format(tokens.output_tokens) + " output";
    const cached = Number.isInteger(tokens.cached_input_tokens)
      ? " · " + countNumber.format(tokens.cached_input_tokens) + " input cached" : "";
    rows.push(usageItem("Review tokens", countNumber.format(tokens.input_tokens + tokens.output_tokens), input + " · " + output + cached));
  } else if (data.state === "complete") {
    rows.push(usageItem("Review tokens", "Unavailable"));
  }
  let hasQuota = false;
  for (const name of ["primary", "secondary"]) {
    const before = data.quota_before?.[name];
    const after = data.quota_after?.[name];
    const current = after || before;
    if (!current) continue;
    hasQuota = true;
    const comparable = before?.resets_at && after && before.resets_at === after.resets_at &&
      before.limit_id === after.limit_id && before.minutes === after.minutes;
    const used = percentage.format(current.used_percent) + "% used";
    const delta = comparable ? after.used_percent - before.used_percent : null;
    let detail = comparable
      ? percentage.format(before.used_percent) + "% before · " + (delta >= 0 ? "+" : "") + percentage.format(delta) + " pp"
      : after ? "After review" : "Before review";
    if (current.resets_at) {
      detail += " · Resets " + new Date(current.resets_at * 1000)
        .toLocaleString("en-US", {dateStyle: "medium", timeStyle: "short"});
    }
    rows.push(usageItem(quotaLabel(current.minutes), used, detail));
  }
  if (!hasQuota && data.state === "complete") rows.push(usageItem("Codex quota", "Unavailable"));
  reviewUsage.replaceChildren(...rows);
  reviewUsage.hidden = rows.length === 0;
  byId("review-usage-note").hidden = !hasQuota;
}

function showReviewProgress(data) {
  const stages = {
    positions: "Fetching open positions…",
    prices: "Loading price history for open positions…",
    books: "Checking live order books…",
    catalog: "Scanning the open market catalogue…",
    "market-details": "Loading prices and market details…",
    history: "Loading past trades…",
    starting: "Starting Codex…",
    analyzing: reviewMode === "discovery" ? "Ranking markets against trade history…" : "Analyzing positions and trade history…",
    researching: "Checking market rules and recent sources…",
    writing: "Writing the report…",
    usage: "Confirming token and quota usage…"
  };
  const searches = data.searches ? " · " + data.searches + (data.searches === 1 ? " search" : " searches") : "";
  const trades = data.phase === "history" && data.trades ? " · " + countNumber.format(data.trades) + " trade fills" : "";
  const scanned = data.phase === "catalog" && data.markets_scanned ? " · " + countNumber.format(data.markets_scanned) + " markets checked" : "";
  const message = data.state === "complete" ? (reviewMode === "discovery" ? "Market search complete." : "Review complete.")
    : data.state === "failed" ? data.error || "The review failed."
    : data.state === "queued" ? "Queued behind another Codex analysis…"
    : (stages[data.phase] || stages.positions) + trades + scanned + searches;
  if (reviewProgress.textContent !== message) reviewProgress.textContent = message;
  const elapsed = data.elapsed_seconds ?? 0;
  byId("review-elapsed").textContent = elapsed < 60 ? elapsed + "s" : Math.floor(elapsed / 60) + "m " + (elapsed % 60) + "s";
  reviewDots.hidden = !["running", "queued"].includes(data.state);
  reviewActivity.hidden = false;
  renderUsage(data);
}

function showReviewSession(signedIn) {
  reviewRun.hidden = !signedIn;
  reviewConnect.hidden = signedIn;
  if (!signedIn) {
    reviewReport.replaceChildren();
    reviewReport.hidden = true;
    reviewActivity.hidden = true;
  }
}

function showReviewError(message) {
  reviewActivity.hidden = false;
  reviewDots.hidden = true;
  reviewProgress.textContent = message;
}

async function monitorReview(start) {
  const address = reviewWallet;
  const mode = reviewMode;
  const attempt = ++reviewAttempt;
  const query = "/api/reviews?" + new URLSearchParams({wallet: address, mode});
  reviewRun.disabled = true;
  try {
    if (start) showReviewProgress({state: "running", phase: "positions"});
    let data = start ? await DashboardSettings.reviewRequest("/api/reviews", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({wallet: address, mode})
    }) : await DashboardSettings.reviewRequest(query);
    if (attempt !== reviewAttempt) return;
    DashboardSettings.reviewSession(true);
    while (["running", "queued"].includes(data.state) && attempt === reviewAttempt) {
      showReviewProgress(data);
      await new Promise((resolve) => setTimeout(resolve, 2500));
      if (attempt !== reviewAttempt) return;
      data = await DashboardSettings.reviewRequest(query);
    }
    if (attempt !== reviewAttempt || (!start && data.state === "idle")) return;
    if (!["complete", "failed"].includes(data.state)) throw new Error("The review was interrupted. Try again.");
    if (data.state === "complete") {
      if (mode === "discovery") await renderDiscovery(data, attempt);
      else renderReview(data);
    }
    if (attempt !== reviewAttempt) return;
    showReviewProgress(data);
  } catch (failure) {
    if (attempt !== reviewAttempt) return;
    if (failure.status === 401) {
      DashboardSettings.reviewSession(false);
      if (start) {
        showReviewError("Refresh your Codex connection in Settings.");
        if (reviewDialog.open) reviewConnect.focus();
      }
      return;
    }
    showReviewError(failure instanceof SyntaxError
      ? "The review service is unavailable. Try again in a moment."
      : failure.message);
  } finally {
    if (attempt === reviewAttempt) reviewRun.disabled = false;
  }
}

function scenarioSelect(position) {
  const select = element("select", "scenario-position");
  select.dataset.token = position.token_id;
  select.setAttribute("aria-label", "Scenario for " + position.outcome + " on " + position.title);
  select.add(new Option("Default · " + scenarioLabels[scenarioDefault.value], ""));
  for (const [outcome, label] of Object.entries(scenarioLabels)) select.add(new Option(label, outcome));
  select.value = scenarioOverrides.get(position.token_id) || "";
  select.dataset.outcome = select.value || scenarioDefault.value;
  select.addEventListener("change", () => {
    if (select.value) scenarioOverrides.set(position.token_id, select.value);
    else scenarioOverrides.delete(position.token_id);
    syncScenario();
  });
  return select;
}

function marketCell(position) {
  const td = element("td");
  const market = element("div", "market");
  if (typeof position.icon === "string" && position.icon.startsWith("https://")) {
    const icon = element("img", "icon");
    icon.alt = "";
    icon.loading = "lazy";
    icon.addEventListener("error", () => icon.remove(), {once: true});
    icon.src = DashboardWidgets.marketImageSource(position.icon);
    market.append(icon);
  }
  const details = element("div");
  const meta = element("div", "meta");
  const side = position.outcome === "Yes" ? " yes" : position.outcome === "No" ? " no" : "";
  meta.append(element("span", "side" + side, position.outcome),
    element("span", "", available(position.current_size, (size) => positionShares.format(size) + " shares")),
    scenarioSelect(position));
  details.append(DashboardWidgets.marketTitle(position, () => {
    DashboardWidgets.openPosition({...position, status: "open"}, displayedWallet);
  }), meta);
  market.append(details);
  td.append(market);
  return td;
}

function positionRow(position) {
  const row = element("tr");
  const prices = element("span", "position-prices");
  prices.append(element("span", "muted", available(position.avg_price, displayPrice)),
    element("span", "muted", "→"), element("span", "", available(position.current_price, displayPrice)));
  const percent = position.entry_cost_usdc > 0 && Number.isFinite(position.percent_pnl)
    ? " (" + signedPercent.format(position.percent_pnl / 100) + ")" : "";
  row.append(
    marketCell(position),
    cell("Avg → Now", prices),
    cell("Cost basis", available(position.entry_cost_usdc, dollars.format)),
    cell("Potential payout", available(position.current_size, dollars.format)),
    cell("Value & P&L", element("strong", "", available(position.current_value, dollars.format)),
      element("span", "pnl " + color(position.unrealized_pnl), available(position.unrealized_pnl, signedDollars.format) + percent))
  );
  return row;
}

function renderPositionRows() {
  const direction = sortDirection === "ascending" ? 1 : -1;
  const sorted = [...openPositions].sort((a, b) => {
    if (sortKey !== "title") {
      if (!Number.isFinite(a[sortKey])) return Number.isFinite(b[sortKey]) ? 1 : 0;
      if (!Number.isFinite(b[sortKey])) return -1;
    }
    const order = sortKey === "title" ? marketNames.compare(a.title, b.title) : a[sortKey] - b[sortKey];
    return direction * order;
  });
  body.replaceChildren(...sorted.map(positionRow));
}

function changePositionSort(key) {
  if (key === sortKey) {
    sortDirection = sortDirection === "ascending" ? "descending" : "ascending";
  } else {
    sortDirection = key === "title" ? "ascending" : "descending";
  }
  sortKey = positionSort.value = key;

  for (const header of body.parentElement.querySelectorAll("th[aria-sort]")) {
    header.removeAttribute("aria-sort");
  }
  for (const button of sortButtons) {
    const active = button.dataset.sortKey === key;
    button.setAttribute("aria-pressed", active);
    if (active) {
      button.dataset.direction = sortDirection;
      button.closest("th").setAttribute("aria-sort", sortDirection);
    } else {
      delete button.dataset.direction;
    }
  }

  const ascending = sortDirection === "ascending";
  sortDirectionButton.textContent = ascending ? "↑" : "↓";
  sortDirectionButton.setAttribute("aria-label", ascending ? "Sort descending" : "Sort ascending");
  renderPositionRows();
}

function render(positions) {
  if (!Array.isArray(positions)) throw new Error("Polymarket returned unreadable positions.");
  const numericFields = ["current_size", "avg_price", "current_price", "entry_cost_usdc", "current_value", "unrealized_pnl"];
  openPositions = positions.filter((position) => typeof position?.token_id === "string" && position.token_id)
    .map((position) => ({...position, title: position.title || "Unknown market", outcome: position.outcome || "—"}));
  const omitted = positions.length - openPositions.length;
  const incomplete = openPositions.filter((position) => numericFields.some((field) => !Number.isFinite(position[field]))).length;
  const notice = byId("position-coverage");
  notice.textContent = [omitted ? `${omitted} positions could not be identified.` : "",
    incomplete ? `${incomplete} positions have missing prices or amounts.` : ""].filter(Boolean).join(" ");
  notice.hidden = !notice.textContent;
  positions = openPositions;
  const totalFor = (key) => !omitted && positions.every((position) => Number.isFinite(position[key]))
    ? sum(positions, (position) => position[key]) : null;
  const scenarioReady = !omitted && ["current_size", "entry_cost_usdc", "current_value"].every((key) => totalFor(key) !== null);
  const liveTokens = new Set(positions.map((position) => position.token_id));
  for (const token of scenarioOverrides.keys()) {
    if (!liveTokens.has(token)) scenarioOverrides.delete(token);
  }
  conflict.hidden = true;
  const pnl = totalFor("unrealized_pnl");
  renderPositionRows();
  byId("total-cost").textContent = available(totalFor("entry_cost_usdc"), dollars.format);
  byId("total-value").textContent = available(totalFor("current_value"), dollars.format);
  byId("total-pnl").textContent = available(pnl, signedDollars.format);
  byId("total-pnl").className = color(pnl);
  count.textContent = positions.length;
  count.hidden = false;
  positionsInfo.hidden = totals.hidden = results.hidden = positions.length === 0;
  scenarioToggle.hidden = !scenarioReady || !positions.length;
  if (!scenarioReady && positions.length) notice.append(" Some amounts are needed to simulate outcomes.");
  reviewToggle.hidden = !directReview || positions.length === 0;
  codexToggle.hidden = findToggle.hidden = !directReview;
  empty.hidden = positions.length !== 0 || omitted > 0;
  if (scenarioToggle.hidden) setScenarioOpen(false);
  if (!byId("scenario-summary").hidden) syncScenario();
}

async function load(fresh = false) {
  const address = DashboardSettings.wallet;
  if (!address) return DashboardSettings.open();
  positionRequest?.abort();
  const request = new AbortController();
  positionRequest = request;
  error.hidden = true;
  byId("wallet-empty").hidden = true;
  refresh.disabled = true;
  if (displayedWallet !== address) {
    byId("position-coverage").hidden = true;
    displayedWallet = updatedAt = "";
    openPositions = [];
    scenarioOverrides.clear();
    scenarioDefault.value = "hold";
    setScenarioOpen(false);
    positionsInfo.hidden = true;
    codexActions.hidePopover();
    codexToggle.hidden = findToggle.hidden = reviewToggle.hidden = scenarioToggle.hidden = count.hidden = totals.hidden = results.hidden = empty.hidden = true;
  }
  status.textContent = "Loading positions…";
  const query = new URLSearchParams({wallet: address});
  if (fresh) query.set("fresh", "1");
  try {
    const read = fetch("/api/positions?" + query, {
      cache: "no-store",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(30000)])
    });
    DashboardWidgets.portfolio(byId("portfolio-chart"), address, fresh);
    const response = await read;
    const data = await response.json();
    if (request !== positionRequest) return;
    if (!response.ok) throw new Error(data.error || "Could not load positions.");
    render(data.positions);
    displayedWallet = address;
    DashboardWidgets.restorePortfolioPosition(data.positions, address, request.signal);
    if (openDiscoveryOnLoad && directReview && !reviewDialog.open) {
      openDiscoveryOnLoad = false;
      const url = new URL(location.href);
      url.searchParams.delete("find");
      history.replaceState(null, "", url);
      openReview("discovery");
    }
    updatedAt = "Updated at " + clock.format(new Date());
  } catch (failure) {
    if (request !== positionRequest) return;
    error.textContent = failure instanceof TypeError || failure.name === "TimeoutError"
      ? "Connection interrupted. Try refreshing in a moment."
      : failure.message;
    error.hidden = false;
  } finally {
    if (request === positionRequest) {
      status.textContent = updatedAt;
      refresh.disabled = false;
    }
  }
}

refresh.addEventListener("click", () => load(true));
for (const button of sortButtons) {
  button.addEventListener("click", () => changePositionSort(button.dataset.sortKey));
}
positionSort.value = sortKey;
positionSort.addEventListener("change", () => changePositionSort(positionSort.value));
sortDirectionButton.addEventListener("click", () => changePositionSort(sortKey));
scenarioToggle.addEventListener("click", () => {
  setScenarioOpen(scenarioToggle.getAttribute("aria-expanded") === "false");
});
scenarioDefault.addEventListener("change", syncScenario);
scenarioClear.addEventListener("click", () => {
  scenarioOverrides.clear();
  syncScenario();
});
function openReview(mode) {
  const discovery = mode === "discovery";
  byId("review-title").textContent = discovery ? "Personalized picks" : "Portfolio review";
  byId("review-help").textContent = discovery
    ? "Find open markets that fit your trade history and explore a few unfamiliar ideas."
    : "Codex checks entry dates, price history, liquidity, and recent sources for each position.";
  byId("review-wallet").textContent = displayedWallet;
  reviewRun.textContent = discovery ? "Find picks" : "Run review";
  const changed = reviewWallet !== displayedWallet || reviewMode !== mode;
  if (changed) {
    reviewWallet = displayedWallet;
    reviewMode = mode;
    reviewAttempt++;
    reviewRun.disabled = false;
    reviewActivity.hidden = true;
    reviewProgress.textContent = "";
    reviewReport.replaceChildren();
    reviewReport.hidden = true;
    byId("review-body").scrollTop = 0;
  }
  showReviewSession(DashboardSettings.signedIn);
  reviewDialog.showModal();
  if (!reviewRun.disabled) monitorReview(false);
}

function openCodexAction(mode) {
  codexActions.hidePopover();
  codexToggle.focus();
  openReview(mode);
}

reviewToggle.addEventListener("click", () => openCodexAction("review"));
findToggle.addEventListener("click", () => openCodexAction("discovery"));
byId("review-dismiss").addEventListener("click", () => reviewDialog.close());
byId("review-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!reviewRun.disabled) monitorReview(true);
});
reviewConnect.addEventListener("click", () => {
  reviewDialog.close();
  DashboardSettings.open("codex");
});
DashboardSettings.configure({
  onWallet: load, onRange: DashboardWidgets.setPortfolioRange,
  onReviewSession(signedIn) {
    showReviewSession(signedIn);
    if (!signedIn) {
      reviewAttempt++;
      reviewRun.disabled = false;
    }
  }
});
if (DashboardSettings.wallet) load();
else byId("wallet-empty").hidden = false;
