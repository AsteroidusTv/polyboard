"use strict";

(() => {
  const byId = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const slug = params.get("market");
  const back = byId("holder-back");
  const catalog = params.get("catalog");
  if (params.get("source") === "precedents" && slug) {
    const prev = new URLSearchParams({market: params.get("from") || slug, scope: params.get("scope") || "focused"});
    if (catalog !== null) prev.set("catalog", catalog);
    if (params.has("return_source")) prev.set("source", params.get("return_source"));
    back.href = "/precedents?" + prev;
    back.textContent = "← Market precedents";
  } else if (catalog?.startsWith("?") || /^#watchlist(?:\/market\/[a-z0-9-]+)?$/.test(catalog || "")) {
    back.href = "/markets" + catalog;
  } else if (params.get("source") === "trades") {
    back.href = "/trades";
    back.textContent = "← Trade history";
  } else if (params.get("source") === "portfolio") {
    back.href = "/";
    back.textContent = "← Portfolio";
  }

  const count = new Intl.NumberFormat("en-US");
  const shares = new Intl.NumberFormat("en-US", {maximumFractionDigits: 1});
  const compact = new Intl.NumberFormat("en-US", {style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1});
  const money = new Intl.NumberFormat("en-US", {style: "currency", currency: "USD", signDisplay: "exceptZero"});
  const chance = new Intl.NumberFormat("en-US", {maximumFractionDigits: 2});
  const date = new Intl.DateTimeFormat("en-US", {dateStyle: "medium", timeStyle: "short"});
  const day = new Intl.DateTimeFormat("en-US", {dateStyle: "medium"});
  const PAGE_SIZE = 12;
  const BATCH_SIZE = 4;
  const cohort = byId("holder-limit");
  const scope = byId("holder-scope");
  const outcomeButtons = [...byId("holder-outcomes").children];
  const reviewDialog = byId("holder-review-dialog");
  const walletDialog = byId("holder-wallet-dialog");
  const reviewRun = byId("holder-review-run");
  const reviewConnect = byId("holder-review-connect");
  const reviewDots = byId("holder-review-dots");
  const progress = byId("holder-review-status");
  const scanButton = byId("holder-scan");
  const scanProgress = byId("holder-scan-progress");
  const scanStatus = byId("holder-scan-status");
  const scanMeter = byId("holder-scan-meter");
  const scanPercent = byId("holder-scan-percent");
  const stopButton = byId("holder-stop");
  let available, listRequest, scan, walletRequest, reviewRequest;
  let loadingRoster = false;
  let slices = newSlices();
  let side = 0;
  let page = 0;
  let period = "recent";

  function newSlices() {
    return Object.fromEntries(Object.entries({history: ["recent", "history"], similar: ["similar"]}).map(([part, periods]) => [part,
      [0, 1].map(() => ({offsets: new Set(), profiles: new Map(), incomplete: false, comparableCount: null,
        totals: Object.fromEntries(periods.map((key) => [key, {profit: 0, loss: 0, right: 0, wrong: 0, wallets: 0}]))}))]));
  }

  function analysisPart() {
    return period === "similar" ? "similar" : "history";
  }

  function addProfiles(slice, data) {
    slice.offsets.add(data.offset);
    slice.comparableCount = data.similar_markets;
    for (const row of data.profiles) {
      if (slice.profiles.has(row.wallet)) continue;
      slice.profiles.set(row.wallet, row);
      slice.incomplete ||= row.history_complete === false;
      for (const [key, total] of Object.entries(slice.totals)) {
        const direction = key === "similar" ? row.similar : key === "recent" ? row.recent_direction : row.direction;
        total.profit += row[key]?.profit || 0;
        total.loss += row[key]?.loss || 0;
        total.right += direction?.right || 0;
        total.wrong += direction?.wrong || 0;
        if (key === "similar" ? direction?.right + direction?.wrong > 0 : row.history_available) total.wallets++;
      }
    }
  }

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function timestamp(seconds, format = date) {
    return Number.isFinite(seconds) ? format.format(seconds * 1000) : "—";
  }

  function badge(label, value, description) {
    const item = node("div");
    const amount = node("dd");
    amount.append(value);
    item.append(node("dt", label), amount);
    if (description) item.append(node("small", description));
    return item;
  }

  async function fetchHolders(view, extra, signal) {
    const query = new URLSearchParams({market: slug, view, ...extra});
    const response = await fetch("/api/holders?" + query, {signal: AbortSignal.any([signal, AbortSignal.timeout(45000)])});
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Holder data couldn’t load.");
    return body;
  }

  function renderMarket() {
    const {market, as_of: asOf} = available;
    byId("holder-market-title").textContent = market.title;
    byId("holder-event-title").textContent = market.title === market.event_title ? "" : market.event_title || "";
    byId("holder-polymarket").href = market.url;
    byId("holder-market-date").textContent = market.closed
      ? (market.resolved_at ? "Resolved " + timestamp(market.resolved_at) : "Trading closed")
      : (market.closes_at ? "Scheduled end " + timestamp(market.closes_at) : "Open market");
    const image = byId("holder-market-icon");
    image.hidden = !market.image?.startsWith("https://");
    if (!image.hidden) image.src = market.image;
    const note = byId("holder-historical-note");
    note.hidden = !market.closed;
    note.textContent = "Retrospective view. The roster shows remaining shares today. Redeemed wallets may be absent. Performance uses records available before market close.";
    byId("holder-coverage").textContent = "Public snapshot " + timestamp(asOf);
    outcomeButtons.forEach((button, index) => {
      const group = available.sides[index];
      button.dataset.tone = outcomeTone(group.label, index);
      const label = node("strong", group.label, "holder-outcome-label");
      const coverage = node("small", count.format(group.rows.length) + " in sample", "muted");
      coverage.id = "holder-outcome-count-" + index;
      button.replaceChildren(label, coverage);
      button.setAttribute("aria-label", group.label);
      button.setAttribute("aria-describedby", coverage.id);
      button.setAttribute("aria-pressed", String(side === index));
    });
  }

  function outcomeTone(label, index) {
    const normalized = String(label || "").toLowerCase();
    if (normalized === "yes" || normalized === "no") return normalized;
    return index === 0 ? "first" : index === 1 ? "second" : "";
  }

  function moneyTone(amount) {
    return amount >= .005 ? "positive" : amount <= -.005 ? "negative" : "muted";
  }

  function rateValue(result, left, right) {
    const good = result?.[left], bad = result?.[right];
    const total = good + bad;
    const value = node("strong", undefined, "holder-score");
    if (!total) {
      value.textContent = "—";
      return value;
    }
    const tone = total >= 5 && good !== bad ? (good > bad ? "positive" : "negative") : "";
    value.append(node("span", count.format(good), tone), node("span", " / " + count.format(total), "muted"));
    return value;
  }

  function rateCell(result, left, right, trailing) {
    const wrapper = node("span", undefined, "holder-rate");
    wrapper.append(rateValue(result, left, right));
    if (trailing) wrapper.append(trailing instanceof HTMLElement ? trailing : node("small", trailing, "muted"));
    return wrapper;
  }

  function holderCell(label, content) {
    const cell = node("td");
    const caption = node("span", label, "cell-label");
    caption.setAttribute("aria-hidden", "true");
    cell.append(caption, content);
    return cell;
  }

  function walletLabel(holder) {
    if (holder.name && !/^0x[0-9a-f]{40}(?:-\d+)?$/i.test(holder.name)) return holder.name;
    return holder.wallet.slice(0, 6) + "…" + holder.wallet.slice(-4);
  }

  function renderScanProgress(checked = 0, total = 0) {
    const pending = loadingRoster || Boolean(scan);
    const failed = scanStatus.classList.contains("negative");
    scanProgress.hidden = !pending && !checked && !failed;
    scanMeter.hidden = !pending && !checked;
    scanPercent.hidden = loadingRoster || !total || (!pending && !checked);
    if (loadingRoster) {
      scanMeter.removeAttribute("value");
    } else if (total) {
      scanMeter.max = total;
      scanMeter.value = checked;
      scanPercent.textContent = Math.floor(100 * checked / total) + "%";
    }
    if (failed && !pending) return;
    const progress = count.format(checked) + " / " + count.format(total) + " wallets checked";
    const message = loadingRoster ? "Loading holder list…"
      : pending ? progress + "…" : checked ? progress : "";
    if (scanStatus.textContent !== message) scanStatus.textContent = message;
  }

  function renderList() {
    if (!available) return;
    const group = available.sides[side];
    const shown = group.rows.length;
    const {profiles, totals, incomplete, comparableCount} = slices[analysisPart()][side];
    const record = totals[period];
    byId("holder-results").replaceChildren(
      badge("Holders in sample", count.format(shown), shown ? shares.format(group.shares) + " net shares" : ""),
      badge("Top 5 concentration", group.top_five_pct == null ? "—" : group.top_five_pct + "%", "Of sampled shares"),
      badge(period === "similar" ? "Correct comparable picks" : "Profitable markets",
        period === "similar" ? rateValue(record, "right", "wrong") : rateValue(record, "profit", "loss"),
        record.wallets ? count.format(record.wallets) + " wallets with records" : profiles.size ? "No graded records yet" : "Wallet coverage pending")
    );
    const checked = profiles.size;
    const notes = [];
    if (available.partial) notes.push("Polymarket returned a partial holder list.");
    else if (available.cohort === "all" && !available.complete) notes.push("All available is capped at " + count.format(available.cap) + " per outcome.");
    if (period === "similar") {
      if (comparableCount === null) notes.push("Comparable market coverage has yet to load or is unavailable.");
      else notes.push(comparableCount ? comparableCount + " resolved markets in the comparison sample." : "No comparable verified resolutions found in this scope.");
    } else if (incomplete) {
      notes.push("Some wallet histories are sampled or incomplete.");
    }
    byId("holder-table-note").textContent = notes.join(" ");
    const noComparison = period === "similar" && comparableCount === 0;
    scanButton.disabled = loadingRoster || Boolean(scan) || noComparison || !shown || checked >= shown;
    scanButton.textContent = scan ? "Analyzing…" : noComparison ? "No comparable markets" : checked === shown && shown ? "Analysis complete"
      : checked ? "Analyze remaining " + count.format(shown - checked) : "Analyze holders";
    stopButton.hidden = !scan;
    renderScanProgress(noComparison ? 0 : checked, shown);
    byId("holder-empty").hidden = Boolean(shown);
    byId("holder-table").hidden = !shown;
    byId("holder-pages").hidden = shown <= PAGE_SIZE;
    const pages = Math.max(1, Math.ceil(shown / PAGE_SIZE));
    byId("holder-prev").disabled = page === 0;
    byId("holder-next").disabled = page + 1 >= pages;
    byId("holder-page").textContent = "Page " + count.format(page + 1) + " of " + count.format(pages);
    const head = byId("holder-table").tHead.rows[0].cells;
    head[2].textContent = period === "similar" ? "Matched markets" : "Profitable markets";
    const body = byId("holder-rows");
    const focus = body.contains(document.activeElement) ? document.activeElement.dataset.wallet : undefined;
    const rows = group.rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((holder, index) => {
      const rank = page * PAGE_SIZE + index;
      const row = node("tr");
      const profile = profiles.get(holder.wallet);
      const wallet = node("button", undefined, "text-button holder-wallet-button");
      wallet.type = "button";
      wallet.dataset.wallet = holder.wallet;
      wallet.setAttribute("aria-haspopup", "dialog");
      wallet.append(node("span", "#" + (rank + 1), "holder-rank"), node("span", walletLabel(holder)));
      wallet.addEventListener("click", () => openWallet(holder, rank));
      const direction = period === "similar" ? profile?.similar : period === "history" ? profile?.direction : profile?.recent_direction;
      const pnl = profile?.[period]?.pnl;
      const economic = period === "similar"
        ? (direction ? node("strong", count.format(direction.right + direction.wrong) + (direction.excluded ? " graded" : "")) : node("span", "—"))
        : rateCell(profile?.[period], "profit", "loss", Number.isFinite(pnl) ? node("small", money.format(pnl), moneyTone(pnl)) : null);
      row.append(holderCell("Holder", wallet), holderCell("Net shares", node("strong", shares.format(holder.shares))),
        holderCell(head[2].textContent, economic),
        holderCell("Correct picks", rateCell(direction, "right", "wrong", direction?.excluded ? direction.excluded + " excluded" : "")));
      return row;
    });
    body.replaceChildren(...rows);
    if (focus) body.querySelector(`button[data-wallet="${focus}"]`)?.focus({preventScroll: true});
  }

  function renderSignals(signal) {
    const output = byId("holder-signal");
    byId("holder-signal-window").textContent = signal.end ? "Window ending " + timestamp(signal.end) : "";
    if (signal.state !== "available") {
      const message = signal.state === "no_cutoff" ? "A verified cutoff is unavailable for this closed market."
        : !signal.complete ? "Only part of the public trade window is available."
          : "Too few trades in the comparison windows to judge activity.";
      output.replaceChildren(node("p", message, "muted"));
      return;
    }
    const label = available.market.labels[signal.lean];
    const summary = node("p", signal.flag ? "Unusual directional turnover" : "No directional turnover alert", signal.flag ? "holder-signal-flag" : "");
    const details = node("dl", undefined, "holder-metrics");
    details.append(badge("Turnover in 6h", compact.format(signal.recent_turnover), signal.recent_fills + " public fills"),
      badge("Hourly turnover", chance.format(signal.volume_multiple) + "×", "vs previous 18h"),
      badge("Directional share", signal.directional_pct + "%", "Toward " + label));
    const change = (signal.first_price_move > 0 ? "+" : "") + signal.first_price_move;
    const points = [available.market.labels[0] + " trade-price change " + change + " pts",
      Number.isFinite(signal.peak_hour) ? "Peak turnover hour " + timestamp(signal.peak_hour) : "",
      Number.isFinite(signal.top_three_turnover_pct) ? "Top 3 wallets " + signal.top_three_turnover_pct + "% of turnover" : ""];
    const note = node("p", points.filter(Boolean).join(" · ") + ". Public trades alone cannot establish access to private information.", "muted");
    output.replaceChildren(summary, details, note);
  }

  async function load() {
    if (!slug) {
      byId("holder-loading").hidden = true;
      byId("holder-error").hidden = false;
      byId("holder-error").querySelector("p").textContent = "Open a market to see its public holders.";
      byId("holder-retry").hidden = true;
      return;
    }
    stop();
    listRequest?.abort();
    const current = new AbortController();
    listRequest = current;
    const selected = cohort.value;
    loadingRoster = true;
    scanStatus.classList.remove("negative");
    renderScanProgress();
    byId("holder-loading").hidden = !byId("holder-view").hidden;
    byId("holder-error").hidden = true;
    cohort.disabled = true;
    scanButton.disabled = true;
    try {
      available = await fetchHolders("list", {limit: selected}, current.signal);
      if (current.signal.aborted) return;
      loadingRoster = false;
      slices = newSlices();
      page = 0;
      scanStatus.classList.remove("negative");
      renderMarket();
      renderList();
      byId("holder-view").hidden = false;
      byId("holder-review-launch").hidden = !DashboardSettings.reviewEnabled;
      fetchHolders("signals", {}, current.signal).then((result) => {
        if (!current.signal.aborted) renderSignals(result);
      }).catch(() => {
        if (!current.signal.aborted) byId("holder-signal").textContent = "Trading activity couldn’t load.";
      });
      if (available.sides[side].rows.length) analyze(false);
    } catch (error) {
      if (current.signal.aborted) return;
      loadingRoster = false;
      if (available) {
        cohort.value = available.cohort;
        renderList();
      }
      byId("holder-error").querySelector("p").textContent = error.message || "Holder list couldn’t load.";
      byId("holder-error").hidden = false;
    } finally {
      if (current === listRequest) {
        loadingRoster = false;
        byId("holder-loading").hidden = true;
        cohort.disabled = false;
      }
    }
  }

  function stop() {
    scan?.controller.abort();
    scan = undefined;
  }

  async function analyze(all) {
    if (scan || !available || loadingRoster) return;
    const selection = side, part = analysisPart(), slice = slices[part][side], size = available.sides[side].rows.length;
    if (part === "similar" && slice.comparableCount === 0) return;
    const start = all ? 0 : page * PAGE_SIZE;
    const end = all ? size : Math.min(start + PAGE_SIZE, size);
    const offsets = Array.from({length: Math.ceil((end - start) / BATCH_SIZE)}, (_, index) => start + index * BATCH_SIZE)
      .filter((offset) => !slice.offsets.has(offset));
    if (!offsets.length) return;
    const controller = new AbortController();
    const current = {controller, preview: !all};
    scan = current;
    scanStatus.classList.remove("negative");
    renderList();
    try {
      for (const offset of offsets) {
        const data = await fetchHolders("performance", {snapshot: available.snapshot, side: selection, offset,
          part, scope: scope.value, take: BATCH_SIZE}, controller.signal);
        if (controller.signal.aborted) return;
        addProfiles(slice, data);
        renderList();
        if (part === "similar" && data.similar_markets === 0) break;
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      scanStatus.classList.add("negative");
      scanStatus.textContent = error.message || "Wallet histories couldn’t load.";
    } finally {
      if (scan === current) {
        scan = undefined;
        renderList();
      }
    }
  }

  function walletSection(title, items, render, empty) {
    const section = node("div", undefined, "holder-wallet-section");
    section.append(node("h3", title));
    if (items.length) {
      const list = node("ul");
      list.append(...items.map(render));
      section.append(list);
    } else section.append(node("p", empty, "muted"));
    return section;
  }

  function walletItem(row, ...details) {
    const item = node("li");
    const thumb = node("span", undefined, "holder-market-thumb");
    thumb.setAttribute("aria-hidden", "true");
    if (row.image?.startsWith("https://")) {
      const image = node("img");
      image.src = row.image;
      image.alt = "";
      image.loading = "lazy";
      image.decoding = "async";
      image.addEventListener("error", () => image.remove(), {once: true});
      thumb.append(image);
    }
    const content = node("div", undefined, "holder-wallet-market");
    const meta = node("div", undefined, "holder-wallet-meta");
    meta.append(...details.filter(Boolean).map((entry) => typeof entry === "string" ? node("span", entry, "muted") : entry));
    content.append(node("strong", row.title), meta);
    item.append(thumb, content);
    return item;
  }

  function outcomeChip(outcome) {
    return outcome ? node("span", outcome, "side " + outcomeTone(outcome)) : null;
  }

  async function openWallet(holder, rank) {
    walletRequest?.abort();
    const current = new AbortController();
    walletRequest = current;
    walletDialog.dataset.wallet = holder.wallet;
    const body = byId("holder-wallet-body");
    byId("holder-wallet-title").textContent = walletLabel(holder);
    byId("holder-wallet-address").textContent = holder.wallet;
    byId("holder-wallet-profile").href = "https://polymarket.com/profile/" + encodeURIComponent(holder.wallet);
    body.replaceChildren(node("p", "Loading wallet activity…", "muted"));
    walletDialog.showModal();
    byId("holder-wallet-scroll").scrollTop = 0;
    const market = available.market;
    const closeTimes = [market.closed_at, market.resolved_at].filter(Number.isFinite);
    const cutoff = market.closed ? (closeTimes.length ? Math.min(...closeTimes) : null) : undefined;
    DashboardWidgets.walletPerformance(byId("holder-wallet-chart"), holder.wallet, current.signal, {
      cutoff, note: Number.isFinite(cutoff) ? "History before market close · " + timestamp(cutoff) : undefined
    });
    const common = {snapshot: available.snapshot, side, scope: scope.value};
    const cached = slices;
    async function detail(part) {
      return cached[part][common.side].profiles.get(holder.wallet) ||
        (await fetchHolders("performance", {...common, part, offset: rank, take: 1}, current.signal)).profiles[0];
    }
    let profile, similar, latest;
    function show() {
      if (current.signal.aborted) return;
      const metrics = node("dl", undefined, "holder-metrics");
      metrics.append(badge("Recent profitable", rateValue(profile?.recent, "profit", "loss")),
        badge("History correct", rateValue(profile?.direction, "right", "wrong"), profile ? profile.direction_checked + " markets checked" : ""),
        badge("Similar correct", rateValue(similar?.similar, "right", "wrong")));
      const sections = [metrics];
      const pnl = latest?.stats?.realized_market_pnl;
      if (Number.isFinite(pnl)) sections.push(node("p", "Polymarket lifetime realized market P&L " + money.format(pnl), "holder-note"));
      sections.push(walletSection("Decided positions", profile?.recent_positions || [], (row) =>
        walletItem(row, node("span", Number.isFinite(row.pnl) ? money.format(row.pnl) : "P&L unavailable", moneyTone(row.pnl ?? NaN)),
          timestamp(row.at, day)),
      profile === undefined ? "Loading decided positions…" : profile ? "No decided positions were returned." : "Wallet performance couldn’t load."));
      sections.push(walletSection("Most recent comparable picks", similar?.similar?.rows || [], (row) =>
        walletItem(row, outcomeChip(row.outcome), node("span", row.correct ? "Correct" : "Incorrect", row.correct ? "positive" : "negative"),
          timestamp(row.at, day)),
      similar === undefined ? "Checking comparable markets…" : similar?.similar ? "No graded comparable picks in this sample." : "Comparable picks couldn’t load."));
      sections.push(walletSection("Latest public fills", latest?.fills || [], (row) =>
        walletItem(row, node("span", row.side === "BUY" ? "Buy" : row.side === "SELL" ? "Sell" : "Fill", "holder-fill " + (row.side === "BUY" ? "buy" : row.side === "SELL" ? "sell" : "")),
          outcomeChip(row.outcome), Number.isFinite(row.price) ? chance.format(row.price * 100) + "¢" : "",
          Number.isFinite(row.size) ? shares.format(row.size) + " shares" : "", timestamp(row.at)),
      latest === undefined ? "Loading public fills…" : latest ? "No fills were returned." : "Public fills couldn’t load."));
      body.replaceChildren(...sections);
    }
    show();
    detail("history").catch(() => null).then((result) => { profile = result ?? null; show(); });
    detail("similar").catch(() => null).then((result) => { similar = result ?? null; show(); });
    fetchHolders("wallet", {...common, offset: rank}, current.signal).catch(() => null).then((result) => { latest = result; show(); });
  }

  function renderReview({report, snapshot}) {
    const output = byId("holder-review-report");
    const scopeLabel = snapshot.outcomes.map((outcome) => outcome.wallets + " " + outcome.label).join(" · ");
    const sourceLinks = node("ul");
    const seen = new Set();
    for (const source of report.sources) {
      if (!URL.canParse(source.url)) continue;
      const url = new URL(source.url);
      if (url.protocol !== "https:" || url.username || url.password || seen.has(url.href)) continue;
      const item = node("li");
      const link = node("a", source.title);
      link.href = url.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      item.append(link);
      if (source.date) item.append(" · " + source.date);
      sourceLinks.append(item);
      seen.add(url.href);
      if (seen.size === 2) break;
    }
    output.replaceChildren(node("h3", report.verdict), node("p", scopeLabel + " · " + timestamp(snapshot.as_of), "muted"),
      node("p", report.summary), node("h3", "Other explanations", "holder-wallet-section"), node("p", report.alternative),
      node("h3", "What to check next", "holder-wallet-section"), node("p", report.next_check));
    if (sourceLinks.childElementCount) output.append(sourceLinks);
    output.hidden = false;
  }

  async function monitor(start) {
    reviewRequest?.abort();
    const current = new AbortController();
    reviewRequest = current;
    const signal = current.signal;
    const args = {mode: "holders", market: slug, scope: scope.value + ":" + cohort.value};
    const url = "/api/reviews?" + new URLSearchParams(args);
    const phases = {market: "Loading market details…", holders: "Checking holder histories and trading activity…",
      researching: "Checking recent public sources…", analyzing: "Comparing the evidence…", writing: "Writing the review…", usage: "Finishing the review…"};
    reviewRun.hidden = reviewConnect.hidden = true;
    reviewDots.hidden = !start;
    progress.textContent = start ? "Starting review…" : "Checking Codex access…";
    progress.classList.remove("negative");
    try {
      let data = start ? await DashboardSettings.reviewRequest("/api/reviews", {
        method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(args), signal
      }) : await DashboardSettings.reviewRequest(url, {signal});
      while (!signal.aborted && ["running", "queued"].includes(data.state)) {
        reviewDots.hidden = false;
        progress.textContent = data.state === "queued" ? "Queued behind another analysis…" : phases[data.phase] || "Reviewing holder activity…";
        await new Promise((resolve) => setTimeout(resolve, 2300));
        if (signal.aborted) return;
        data = await DashboardSettings.reviewRequest(url, {signal});
      }
      if (signal.aborted) return;
      if (data.state === "failed") throw new Error(data.error || "The review couldn’t finish.");
      if (data.state === "complete") renderReview(data);
      reviewRun.textContent = data.state === "complete" ? "Refresh review" : "Run review";
      reviewRun.hidden = false;
      progress.textContent = data.state === "complete" ? "" : "Codex weighs public evidence, timing and ordinary explanations.";
    } catch (error) {
      if (signal.aborted) return;
      if (error.status === 401) {
        reviewConnect.hidden = false;
        progress.textContent = "Connect Codex in Settings to run a holder review.";
      } else {
        progress.classList.add("negative");
        progress.textContent = error.message || "The review couldn’t finish.";
        reviewRun.textContent = "Try again";
        reviewRun.hidden = false;
      }
    } finally {
      if (!signal.aborted) reviewDots.hidden = true;
    }
  }

  outcomeButtons.forEach((button, index) => button.addEventListener("click", () => {
    if (side === index) return;
    stop();
    side = index;
    page = 0;
    scanStatus.classList.remove("negative");
    outcomeButtons.forEach((tab, position) => tab.setAttribute("aria-pressed", String(position === side)));
    renderList();
    if (available.sides[side].rows.length) analyze(false);
  }));
  byId("holder-period").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-period]");
    if (!button || button.dataset.period === period) return;
    const previous = analysisPart();
    period = button.dataset.period;
    if (analysisPart() !== previous) {
      stop();
      scanStatus.classList.remove("negative");
    }
    for (const tab of byId("holder-period").children) tab.setAttribute("aria-pressed", String(tab === button));
    renderList();
    if (analysisPart() !== previous) analyze(false);
  });
  for (const [key, amount] of [["holder-prev", -1], ["holder-next", 1]]) {
    byId(key).addEventListener("click", () => {
      page += amount;
      if (scan?.preview) stop();
      renderList();
      if (!scan) analyze(false);
    });
  }
  byId("holder-market-icon").addEventListener("error", () => { byId("holder-market-icon").hidden = true; });
  cohort.addEventListener("change", load);
  scope.addEventListener("change", () => {
    slices.similar = newSlices().similar;
    if (analysisPart() !== "similar") return;
    stop();
    scanStatus.classList.remove("negative");
    renderList();
    analyze(false);
  });
  byId("holder-retry").addEventListener("click", load);
  scanButton.addEventListener("click", () => analyze(true));
  stopButton.addEventListener("click", () => { stop(); renderList(); });
  walletDialog.addEventListener("close", () => {
    if (walletDialog.open) return;
    walletRequest?.abort();
    const trigger = [...byId("holder-rows").querySelectorAll("button[data-wallet]")]
      .find((button) => button.dataset.wallet === walletDialog.dataset.wallet);
    trigger?.focus({preventScroll: true});
  });
  byId("holder-review-launch").addEventListener("click", () => {
    byId("holder-review-report").hidden = true;
    reviewDialog.showModal();
    monitor(false);
  });
  reviewRun.addEventListener("click", () => monitor(true));
  reviewConnect.addEventListener("click", () => { reviewDialog.close(); DashboardSettings.open("codex"); });
  reviewDialog.addEventListener("close", () => { if (!reviewDialog.open) reviewRequest?.abort(); });
  window.addEventListener("pagehide", () => { stop(); listRequest?.abort(); walletRequest?.abort(); reviewRequest?.abort(); });
  load();
})();
