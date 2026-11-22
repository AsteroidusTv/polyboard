"use strict";

const byId = (id) => document.getElementById(id);
const scopeControl = byId("precedent-scope");
const results = byId("precedent-results");
const loading = byId("precedent-loading");
const loadingMessage = byId("precedent-loading-message");
const status = byId("precedent-status");
const error = byId("precedent-error");
const calibrationHorizon = byId("precedent-calibration-horizon");
const scopeButtons = document.querySelectorAll("[data-scope]");
const quoteDate = new Intl.DateTimeFormat("en-US", {dateStyle: "medium", timeStyle: "short", timeZone: "UTC"});
const resolutionDate = new Intl.DateTimeFormat("en-US", {dateStyle: "medium", timeZone: "UTC"});
const contextDate = new Intl.DateTimeFormat("en-US", {month: "short", day: "numeric", year: "numeric",
  hour: "numeric", minute: "2-digit", timeZoneName: "short"});
const numbers = new Intl.NumberFormat("en-US", {maximumFractionDigits: 1});
const signed = new Intl.NumberFormat("en-US", {maximumFractionDigits: 1, signDisplay: "exceptZero"});
const verdicts = {
  insufficient: ["Too few prices to judge reliability", "The matrix shows the prices that are available."],
  no_cases: ["No useful comparison found", "No comparable market with a verified prior resolution was found for this scope."],
  target_unverified: ["Official resolution unavailable", "A comparison for this historical market needs a verified resolution date."]
};
let request;
let busyControl;
let shown;
let report;

function el(tag, value, className) {
  const node = document.createElement(tag);
  if (value != null) node.textContent = value;
  if (className) node.className = className;
  return node;
}

function urlFor(row, label) {
  const link = el("a", label, "precedent-link");
  const url = new URL(row.url);
  if (url.protocol === "https:" && url.hostname === "polymarket.com") link.href = url.href;
  link.target = "_blank";
  link.rel = "noopener";
  return link;
}

function dateLabel(timestamp) {
  return resolutionDate.format(timestamp * 1000);
}

function horizonLabel(seconds) {
  if (seconds % 86400 === 0) return "D−" + seconds / 86400;
  if (seconds % 3600 === 0) return "H−" + seconds / 3600;
  if (seconds % 60 === 0) return "M−" + seconds / 60;
  return "S−" + seconds;
}

function points(value, sign = false) {
  return (sign ? signed : numbers).format(value) + " pts";
}

function identity(imageUrl, titleNode, subtitle) {
  const wrap = el("div", null, "precedent-identity");
  const picture = el("span", null, "icon precedent-thumbnail");
  picture.setAttribute("aria-hidden", "true");
  if (imageUrl?.startsWith("https://")) {
    const image = el("img");
    image.src = imageUrl;
    image.alt = "";
    image.loading = "lazy";
    image.addEventListener("error", () => image.remove(), {once: true});
    picture.append(image);
  }
  const text = el("div", null, "precedent-identity-text");
  text.append(titleNode);
  if (subtitle) text.append(el("span", subtitle, "precedent-subtitle muted"));
  wrap.append(picture, text);
  return wrap;
}

function show(section) {
  for (const item of [loading, results]) item.hidden = item !== section;
  if (section && section !== shown) DashboardWidgets.softUpdate(section);
  shown = section;
}

function begin(message, control = null) {
  request?.abort();
  request = new AbortController();
  busyControl?.removeAttribute("aria-busy");
  busyControl = control;
  busyControl?.setAttribute("aria-busy", "true");
  status.textContent = message;
  error.hidden = true;
  if (!control) {
    loadingMessage.textContent = message;
    show(loading);
    loading.scrollIntoView({block: "nearest"});
  }
  return request;
}

function finish(current) {
  if (current !== request) return;
  busyControl?.removeAttribute("aria-busy");
  busyControl = null;
  status.textContent = "";
}

async function read(params, signal) {
  const response = await fetch("/api/precedents?" + new URLSearchParams(params), {
    signal: AbortSignal.any([signal, AbortSignal.timeout(45000)])
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Polymarket is unavailable.");
  return body;
}

function showFailure(current, failure) {
  if (current !== request) return;
  if (shown === loading) show(null);
  error.textContent = failure.name === "TimeoutError" ? "The request timed out. Try again in a moment." : failure.message;
  error.hidden = false;
}

function resultCell(label, ...values) {
  const td = el("td");
  const caption = el("span", label, "cell-label");
  caption.setAttribute("aria-hidden", "true");
  td.append(caption, ...values);
  return td;
}

function quoteCell(seconds, quote) {
  const stack = el("div", null, "precedent-quote");
  if (!Number.isFinite(quote.price)) {
    stack.append(el("strong", "No price", "muted"), el("span", quote.missing, "precedent-quote-meta muted"));
  } else {
    const result = quote.favorite_correct === true ? "Right" : quote.favorite_correct === false ? "Wrong" : "No favorite";
    const tone = quote.favorite_correct === true ? "positive" : quote.favorite_correct === false ? "negative" : "muted";
    const percent = numbers.format(quote.price * 100);
    const price = percent === "50" && quote.price !== .5 ? (quote.price > .5 ? ">50%" : "<50%") : percent + "%";
    stack.append(el("strong", result, tone), el("span", "Yes " + price),
      el("span", points(quote.outcome_delta, true) + " to result", "precedent-quote-meta muted"));
    stack.title = points(quote.vs_even, true) + " vs 50% · Observed " + quoteDate.format(quote.observed_at * 1000) +
      " UTC · Cutoff " + quoteDate.format(quote.cutoff * 1000) + " UTC";
    stack.lastElementChild.append(el("span", " · " + points(quote.vs_even, true) + " vs 50%", "sr-only"));
  }
  return resultCell(horizonLabel(seconds), stack);
}

function caseRow(row) {
  const tr = el("tr");
  const title = urlFor(row, row.label);
  if (row.title !== row.label) title.title = row.title;
  const market = identity(row.image, title, row.label !== row.event_title ? row.event_title : "");
  const tags = el("span", null, "meta");
  tags.append(el("span", row.reason));
  if (row.traded) tags.append(el("span", "You traded", "side"));
  market.lastElementChild.append(tags);
  const outcome = el("span", row.outcome ? "Yes" : "No", row.outcome ? "side yes" : "side no");
  const resolution = el("div", null, "precedent-resolution");
  resolution.append(outcome, el("span", dateLabel(row.resolved_at), "muted"));
  tr.append(resultCell("Market", market), resultCell("Resolved", resolution));
  for (const {seconds} of report.horizons) tr.append(quoteCell(seconds, row.prices[seconds]));
  return tr;
}

function matrixHead() {
  const tr = el("tr");
  for (const title of ["Market", "Resolved"]) {
    const th = el("th", title);
    th.scope = "col";
    tr.append(th);
  }
  for (const horizon of report.horizons) {
    const th = el("th", null, "precedent-horizon-head");
    th.scope = "col";
    th.append(el("strong", horizonLabel(horizon.seconds)));
    const record = el("span", null, "precedent-horizon-record");
    if (horizon.count) {
      record.append(el("span", horizon.right + " right", "positive"), document.createTextNode(" · "),
        el("span", horizon.wrong + " wrong", "negative"));
      if (horizon.ties) record.append(document.createTextNode(" · " + horizon.ties + " tied"));
    } else {
      record.textContent = "No prices";
    }
    th.append(record);
    if (Number.isFinite(horizon.average_error)) th.append(el("span", points(horizon.average_error) + " avg. error"));
    tr.append(th);
  }
  return tr;
}

function renderCalibration() {
  const selected = report.horizons.find((item) => String(item.seconds) === calibrationHorizon.value);
  const bands = byId("precedent-bands");
  if (!selected) return;
  const rows = selected.calibration.map((band) => {
    const row = el("div", null, "precedent-band");
    row.append(el("strong", `${band.from}–${band.to}% price band`),
      el("span", `${numbers.format(band.mean_price)}% avg. Yes price`),
      el("span", `${band.yes_count}/${band.count} resolved Yes (${numbers.format(band.yes_won)}%)`),
      el("span", `${band.count} markets · ${band.events} events`, "muted"));
    return row;
  });
  if (Number.isFinite(selected.brier_skill)) {
    rows.unshift(el("p", signed.format(selected.brier_skill) + "% Brier skill vs 50%", "muted precedent-brier"));
  }
  bands.replaceChildren(...rows);
}

function syncScope(scope) {
  for (const button of scopeButtons) button.setAttribute("aria-pressed", button.dataset.scope === scope);
}

function contextTime(stamp) {
  if (!Number.isFinite(stamp)) return "—";
  const date = new Date(stamp * 1000);
  const time = el("time", contextDate.format(date));
  time.dateTime = date.toISOString();
  return time;
}

function contextStat(label, ...values) {
  const stat = el("div");
  const details = el("dd");
  details.append(...values);
  stat.append(el("dt", label), details);
  return stat;
}

function renderMarketHeader(target, resetRules) {
  const heading = el("h2", target.title);
  heading.id = "precedent-name";
  heading.tabIndex = -1;
  const parent = target.event_title === target.title ? "" : target.event_title;
  byId("precedent-target-identity").replaceChildren(identity(target.image, heading, parent));
  const href = urlFor(target, "").href;
  byId("precedent-target-link").href = href;
  byId("precedent-rules-source").href = href;
  const context = target.context || {};
  const rulesControl = byId("precedent-rules-control");
  rulesControl.hidden = !context.rules_excerpt;
  byId("precedent-rules-text").textContent = context.rules_excerpt || "";
  if (resetRules || rulesControl.hidden) {
    byId("precedent-rules").hidden = true;
    byId("precedent-rules-trigger").setAttribute("aria-expanded", "false");
  }

  let snapshot;
  if (target.resolution) {
    const {outcome, at} = target.resolution;
    snapshot = contextStat("Resolved", el("span", outcome, "side " + outcome.toLowerCase()), contextTime(at));
  } else if (context.state === "open") {
    const quotes = ["Yes", "No"].flatMap((side) => {
      const price = context.prices?.[side.toLowerCase()];
      return Number.isFinite(price) ? [el("span", side + " " + numbers.format(price * 100) + "¢", "side " + side.toLowerCase())] : [];
    });
    snapshot = contextStat("Indicative prices", ...(quotes.length ? quotes : ["Unavailable"]));
  } else {
    snapshot = contextStat("Market status", context.state === "closed" ? "Trading closed" : "Trading unavailable",
      ...(Number.isFinite(context.closed_at) ? [contextTime(context.closed_at)] : []));
  }
  byId("precedent-market-context").replaceChildren(
    snapshot,
    contextStat("Opened", contextTime(context.opened_at)),
    contextStat("Scheduled end", contextTime(context.scheduled_end))
  );
  return heading;
}

function renderReport(focus) {
  const target = report.target;
  DashboardRisk.setMarket(target, report.scope);
  const heading = renderMarketHeader(target, focus);
  const verdict = byId("precedent-verdict");
  const message = verdicts[report.status];
  verdict.hidden = !message;
  if (message) verdict.replaceChildren(el("strong", message[0]), el("p", message[1], "muted"));
  byId("precedent-details").hidden = !report.cases.length;
  const eventCount = new Set(report.cases.map((row) => row.event)).size;
  const broaderCount = report.cases.filter((row) => row.broader).length;
  const scopeDetail = report.scope === "broad" ? (broaderCount ? ` · ${broaderCount} broader matches` : " · Same-family matches only") : "";
  byId("precedent-count").textContent = `${report.cases.length} markets across ${eventCount} events${scopeDetail}`;
  byId("precedent-horizon-columns").span = report.horizons.length;
  byId("precedent-head").replaceChildren(matrixHead());
  byId("precedent-rows").replaceChildren(...report.cases.map(caseRow));
  const calibrated = report.horizons.filter((row) => Number.isFinite(row.brier_skill));
  byId("precedent-calibration").hidden = !calibrated.length;
  calibrationHorizon.replaceChildren(...calibrated.map(({seconds}) => new Option(horizonLabel(seconds), seconds)));
  renderCalibration();
  const coverage = [];
  if (report.truncated) coverage.push(`Sample capped by search coverage. ${report.cases.length} of ${report.matched} eligible markets shown.`);
  if (report.other_duration) coverage.push(`${report.other_duration} markets excluded because their durations differ substantially.`);
  if (report.unusable) coverage.push(`${report.unusable} candidates lacked a verified prior binary resolution.`);
  if (report.failed_quotes) coverage.push(`${report.failed_quotes} price requests failed.`);
  if (DashboardSettings.wallet && !report.wallet_available) coverage.push("Your trade history could not be checked.");
  byId("precedent-coverage").textContent = coverage.join(" ");
  show(results);
  if (focus) heading.focus({preventScroll: true});
  else if (report.cases.length) DashboardWidgets.softUpdate(byId("precedent-table"));
}

async function compare(market, scope) {
  const keep = report?.target.slug === market && !results.hidden;
  const message = keep && scope === "broad" ? "Checking the broader comparison…" : "Loading market comparison…";
  const current = begin(message, keep ? scopeControl : null);
  results.setAttribute("aria-busy", "true");
  syncScope(scope);
  try {
    const data = await read({market, scope, wallet: DashboardSettings.wallet}, current.signal);
    if (current !== request) return;
    report = data;
    renderReport(!keep);
  } catch (failure) {
    if (current !== request) return;
    if (keep) {
      syncScope(report.scope);
      const params = new URLSearchParams(location.search);
      if (report.scope === "broad") params.set("scope", "broad");
      else params.delete("scope");
      history.replaceState(null, "", "/precedents?" + params);
    }
    showFailure(current, failure);
  } finally {
    if (current === request) {
      finish(current);
      results.removeAttribute("aria-busy");
    }
  }
}

function route() {
  const params = new URLSearchParams(location.search);
  const market = params.get("market");
  if (!market) return location.replace("/markets");
  const catalog = params.get("catalog");
  const back = document.querySelector(".back-link");
  if (catalog !== null) {
    back.href = "/markets" + (catalog.startsWith("?") || catalog === "#watchlist" ? catalog : "");
    back.textContent = "← New trade";
  } else if (params.get("source") === "trades") {
    back.href = "/trades";
    back.textContent = "← Trade history";
  } else {
    back.href = "/";
    back.textContent = "← Portfolio";
  }
  compare(market, params.get("scope") === "broad" ? "broad" : "focused");
}

calibrationHorizon.addEventListener("change", renderCalibration);
for (const button of scopeButtons) {
  button.addEventListener("click", () => {
    const params = new URLSearchParams(location.search);
    if (button.getAttribute("aria-pressed") === "true" || !params.has("market")) return;
    if (button.dataset.scope === "broad") params.set("scope", "broad");
    else params.delete("scope");
    history.replaceState(null, "", "/precedents?" + params);
    route();
  });
}
DashboardSettings.configure({onWallet: route});
window.addEventListener("popstate", route);
route();
