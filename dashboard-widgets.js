"use strict";

const DashboardWidgets = (() => {
  const statuses = {open: "Open", won: "Profitable", lost: "Unprofitable", even: "Break-even", unknown: "Incomplete"};
  const price = new Intl.NumberFormat("en-US", {maximumFractionDigits: 2});
  const shares = new Intl.NumberFormat("en-US", {minimumFractionDigits: 1, maximumFractionDigits: 1});
  const dollars = new Intl.NumberFormat("en-US", {style: "currency", currency: "USD"});
  const signedDollars = new Intl.NumberFormat("en-US", {style: "currency", currency: "USD", signDisplay: "exceptZero"});
  const shortDollars = new Intl.NumberFormat("en-US", {style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1});
  const date = new Intl.DateTimeFormat("en-US", {dateStyle: "medium"});
  const time = new Intl.DateTimeFormat("en-US", {timeStyle: "short"});
  const formatPrice = (value) => price.format(value * 100) + "¢";
  const plotHelp = "Use Left and Right Arrow to inspect points. Home and End go to the first and last point.";
  let portfolioPanel;
  let portfolioRequest;
  const walletCharts = new WeakMap();
  let detail;
  let detailRequest;
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const activeUpdates = new WeakMap();
  const marketImageOrigin = "https://polymarket-upload.s3.us-east-2.amazonaws.com/";

  function marketImageSource(url) {
    if (!document.body.hasAttribute("data-market-thumbnails") || !url.startsWith(marketImageOrigin)) return url;
    const filename = url.slice(marketImageOrigin.length);
    return /^[a-z\d_-][a-z\d_.-]{0,190}\.(?:png|jpe?g|webp)$/i.test(filename)
      ? "/media/market/v1/" + filename : url;
  }

  function softUpdate(element) {
    if (reduceMotion.matches || !element.animate) return;
    activeUpdates.get(element)?.cancel();
    activeUpdates.set(element, element.animate([{opacity: .72}, {opacity: 1}], {duration: 180, easing: "ease-out"}));
  }

  reduceMotion.addEventListener("change", () => {
    if (!reduceMotion.matches) return;
    for (const element of document.querySelectorAll("canvas, #trade-results, #trade-rows, #precedent-loading, #precedent-results, #precedent-table")) {
      activeUpdates.get(element)?.cancel();
    }
  });

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function slidingSelection(group) {
    const buttons = group.querySelectorAll(":scope > button");
    function update() {
      const active = [...buttons].find((button) => !button.hidden && button.getAttribute("aria-pressed") === "true");
      if (!active?.offsetWidth) return;
      group.style.setProperty("--selection-x", active.offsetLeft + "px");
      group.style.setProperty("--selection-width", active.offsetWidth + "px");
      group.classList.add("sliding-selection");
    }
    const resize = new ResizeObserver(update);
    resize.observe(group);
    for (const button of buttons) resize.observe(button);
    new MutationObserver(update).observe(group, {subtree: true, attributes: true, attributeFilter: ["aria-pressed", "hidden"]});
    update();
  }

  function loadOnScroll(target, loadMore) {
    if (!("IntersectionObserver" in window)) return () => {};
    const observer = new IntersectionObserver((entries) => {
      if (!entries.at(-1)?.isIntersecting) return;
      observer.unobserve(target);
      loadMore();
    }, {rootMargin: "0px 0px 320px"});
    return (enabled) => {
      observer.unobserve(target);
      observer.takeRecords();
      if (enabled) observer.observe(target);
    };
  }

  function positionBadges(position) {
    const badges = [];
    if (position.outcome) {
      const variant = position.outcome === "Yes" ? " yes" : position.outcome === "No" ? " no" : "";
      badges.push(node("span", position.outcome, "side" + variant));
    }
    if (statuses[position.status]) {
      const status = node("span", statuses[position.status], "position-state");
      status.dataset.status = position.status;
      badges.push(status);
    }
    if (position.claimable) badges.push(node("span", "Claimable"));
    return badges;
  }

  function marketTitle(position, onClick) {
    const button = node("button", position.title || "Unknown market", "title history-market-title");
    button.type = "button";
    button.title = "View price history and trades";
    button.setAttribute("aria-haspopup", "dialog");
    const arrow = node("span", "›", "history-market-arrow");
    arrow.setAttribute("aria-hidden", "true");
    button.append(arrow);
    button.addEventListener("click", onClick);
    return button;
  }

  function chartPanel(root, isPrice, onTrade, showActivity = !isPrice) {
    root.innerHTML = `
      <div class="chart-header">
        <div><h2></h2><div class="chart-value" hidden></div></div>
        <div class="chart-controls" hidden>
          <div class="chart-ranges" role="group" aria-label="Chart range" hidden>
            <button type="button" data-days="7" aria-pressed="false">1W</button>
            <button type="button" data-days="30" aria-pressed="false">1M</button>
            <button type="button" data-days="90" aria-pressed="false">3M</button>
            <button type="button" data-days="0" aria-pressed="true">All</button>
          </div>
          ${isPrice ? `<div class="chart-ranges" role="group" aria-label="Price scale">
            <button type="button" data-scale="fit" aria-label="Fit price scale" aria-pressed="true">Fit</button>
            <button type="button" data-scale="full" aria-label="0 to 100 cents" aria-pressed="false">0–100¢</button>
          </div>` : showActivity ? `<button type="button" class="secondary-button chart-trades-toggle" aria-pressed="false">Show trades</button>` : ""}
        </div>
      </div>
      <p class="chart-status muted" role="status" hidden></p>
      <div class="chart-plot" hidden>
        <canvas tabindex="0" role="img"></canvas>
        <div class="chart-tooltip" hidden>
          <strong></strong><span class="chart-tooltip-market" hidden></span>
          <span class="chart-tooltip-time" hidden></span><span class="chart-tooltip-detail"></span>
          <ul class="chart-tooltip-trades" aria-label="Trades in this marker" tabindex="0" hidden></ul>
          <button type="button" class="chart-tooltip-open secondary-button" aria-haspopup="dialog" hidden>Open position</button>
        </div>
        <span class="chart-announcement sr-only" aria-live="polite"></span>
      </div>
      <div class="chart-footer" hidden>
        <div class="chart-legend" hidden></div>
        <p class="chart-note muted" role="status" hidden></p>
      </div>`;
    const label = isPrice ? "Market price" : "Cumulative position P&L";
    const value = isPrice ? formatPrice : signedDollars.format;
    const heading = root.querySelector("h2");
    const defaultHeading = isPrice ? "Price history" : label;
    heading.textContent = defaultHeading;
    const canvas = root.querySelector("canvas");
    const activation = isPrice ? " Press Enter on a trade marker to show its transaction."
      : showActivity ? " With trades visible, press Enter on a marker to pin its details." : "";
    canvas.setAttribute("aria-label", label + " chart. " + plotHelp + activation);
    const plot = root.querySelector(".chart-plot");
    const controls = root.querySelector(".chart-controls");
    const ranges = controls.firstElementChild;
    for (const group of controls.querySelectorAll(".chart-ranges")) slidingSelection(group);
    const tradesToggle = controls.querySelector(".chart-trades-toggle");
    const status = root.querySelector(".chart-status");
    const total = root.querySelector(".chart-value");
    const footer = root.querySelector(".chart-footer");
    const legend = root.querySelector(".chart-legend");
    const note = root.querySelector(".chart-note");
    const chart = new DashboardLineChart(plot, {
      label, value, price: isPrice, tick: isPrice ? formatPrice : shortDollars.format,
      onTrade: isPrice ? (index) => selectTrade(index, true) : undefined,
      onOpenPosition: showActivity ? (marker) => data.openTrade(marker) : undefined
    });
    let data;
    let range = 0;
    let fullScale = false;
    let selectedTrade = null;
    let tradesVisible = false;
    const hiddenKinds = new Set();
    function draw() {
      chart.setData(data.points, data.markers, data.after, range, fullScale, hiddenKinds, data.alertTarget);
      if (selectedTrade !== null) {
        const marker = chart.markers.find(({tradeIndex}) => tradeIndex === selectedTrade);
        if (marker) {
          chart.pin(marker);
        } else {
          selectedTrade = null;
          onTrade?.(null);
        }
      }
      for (const button of ranges.children) button.setAttribute("aria-pressed", Number(button.dataset.days) === range);
      for (const button of controls.querySelectorAll("[data-scale]")) {
        button.setAttribute("aria-pressed", (button.dataset.scale === "full") === fullScale);
      }
    }

    function showFooter(items, message = "") {
      legend.replaceChildren(...items.map(([kind, name]) => {
        const item = node(isPrice ? "span" : "button", name, "legend-" + kind);
        if (!isPrice) {
          item.type = "button";
          item.dataset.kind = kind;
          item.setAttribute("aria-pressed", String(!hiddenKinds.has(kind)));
        }
        return item;
      }));
      legend.hidden = items.length === 0;
      note.textContent = message;
      note.hidden = !message;
      footer.hidden = legend.hidden && note.hidden;
    }
    legend.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-kind]");
      if (!button) return;
      const {kind} = button.dataset;
      if (!hiddenKinds.delete(kind)) hiddenKinds.add(kind);
      button.setAttribute("aria-pressed", String(!hiddenKinds.has(kind)));
      draw();
    });

    async function showPortfolioTrades(visible) {
      const current = data;
      if (!current?.loadTrades) return;
      tradesVisible = visible;
      tradesToggle.setAttribute("aria-pressed", String(visible));
      if (!visible) {
        current.markers = [];
        showFooter([]);
        draw();
        return;
      }
      showFooter([], "Loading portfolio activity…");
      try {
        const request = current.tradeRequest ||= current.loadTrades();
        const {markers, warning} = await request;
        if (current !== data || !tradesVisible) return;
        current.markers = markers;
        if (warning) current.tradeRequest = null;
        const types = [["buy", "Buy"], ["sell", "Sell"], ["won", "Won"], ["lost", "Lost"], ["deposit", "Top-up"]]
          .filter(([kind]) => markers.some((marker) => marker.kind === kind));
        showFooter(types, warning || (markers.length ? "" : "No activity returned for this wallet."));
        draw();
      } catch {
        if (current !== data) return;
        current.tradeRequest = null;
        if (!tradesVisible) return;
        tradesVisible = false;
        tradesToggle.setAttribute("aria-pressed", "false");
        showFooter([], "Activity couldn’t load. Select Show trades to retry.");
      }
    }
    tradesToggle?.addEventListener("click", () => showPortfolioTrades(!tradesVisible));

    function selectTrade(index, fromChart = false) {
      const marker = data?.markers.find(({tradeIndex}) => tradeIndex === index);
      if (!marker) return;
      selectedTrade = index;
      if (chart.markers.includes(marker)) {
        chart.pin(marker);
      } else {
        range = 0;
        draw();
      }
      onTrade?.(index, fromChart);
      if (!fromChart) {
        canvas.focus({preventScroll: true});
        canvas.scrollIntoView({block: "nearest"});
      }
    }

    ranges.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-days]");
      if (!button || !data) return;
      setRange(Number(button.dataset.days));
    });
    controls.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-scale]");
      if (!button || !data) return;
      const nextScale = button.dataset.scale === "full";
      if (fullScale === nextScale) return;
      fullScale = nextScale;
      draw();
      softUpdate(canvas);
    });

    function availableRange(days) {
      const button = ranges.querySelector(`[data-days="${days}"]`);
      return button && !button.hidden ? days : 0;
    }

    function setRange(days) {
      if (!data || plot.hidden) return;
      const nextRange = availableRange(days);
      if (range === nextRange) return;
      range = nextRange;
      draw();
      softUpdate(canvas);
    }

    return {
      selectTrade, setRange,
      show(message, nextData = null, preferredRange = 0) {
        data = nextData;
        heading.textContent = data?.heading || defaultHeading;
        selectedTrade = null;
        onTrade?.(null);
        const visible = Boolean(data && (data.points.length || data.markers.length));
        status.textContent = message;
        status.hidden = !message;
        plot.hidden = !visible;
        controls.hidden = !visible;
        total.hidden = !visible || !data.subtitle;
        if (!visible) {
          footer.hidden = true;
          return;
        }
        total.textContent = data.subtitle || "";
        total.className = "chart-value" + (data.tone ? " " + data.tone : "");
        showFooter(data.legend || [], data.note);
        let first = data.points[0]?.[0] ?? Infinity;
        let last = data.points.at(-1)?.[0] ?? -Infinity;
        for (const marker of data.markers) {
          first = Math.min(first, marker.time);
          last = Math.max(last, marker.time);
        }
        for (const button of ranges.children) {
          const days = Number(button.dataset.days);
          button.hidden = days > 0 && last - first <= days * 86400;
        }
        ranges.hidden = last - first <= 7 * 86400;
        range = availableRange(preferredRange);
        fullScale = false;
        draw();
        if (tradesVisible) showPortfolioTrades(true);
      }
    };
  }

  async function json(path, params, signal) {
    const response = await fetch(path + "?" + new URLSearchParams(params), {
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)])
    });
    if (!response.ok) throw new Error("History is unavailable");
    return response.json();
  }

  async function loadPortfolioChart(panel, wallet, signal, {cutoff = Infinity, note, activity, retry, fresh} = {}) {
    if (cutoff === null) {
      panel.show("A market close time is needed for historical wallet P&L.");
      return;
    }
    panel.show("Loading portfolio history…");
    try {
      const params = fresh ? {wallet, fresh: "1"} : {wallet};
      const data = await json("/api/portfolio-history", params, signal);
      if (signal.aborted) return;
      const points = data.points.filter(([time]) => time < cutoff);
      if (!points.length) return panel.show(Number.isFinite(cutoff)
        ? "No wallet P&L history before this market closed." : "No portfolio history for this wallet.");
      const latest = points.at(-1)[1];
      panel.show("", {points, markers: [], subtitle: signedDollars.format(latest), note,
        tone: latest >= .005 ? "positive" : latest <= -.005 ? "negative" : "",
        ...activity}, DashboardSettings.chartRange);
    } catch {
      if (!signal.aborted) panel.show("Portfolio history couldn’t load. " + retry);
    }
  }

  async function portfolio(root, wallet, fresh = false) {
    portfolioRequest?.abort();
    const request = new AbortController();
    portfolioRequest = request;
    portfolioPanel ||= chartPanel(root, false);
    root.hidden = false;
    let positions;
    return loadPortfolioChart(portfolioPanel, wallet, request.signal, {
      retry: "Use Refresh to try again.",
      fresh,
      activity: {
        loadTrades: () => portfolioTimeline(wallet, request.signal, fresh),
        openTrade(marker) {
          positions ||= json("/api/trade-summary", {wallet}, request.signal)
            .then(({positions}) => new Map(positions.map((position) => [String(position.token_id), position])))
            .catch(() => {
              positions = undefined;
              return null;
            });
          openPosition(marker.position, wallet, {
            summary: positions.then((rows) => rows?.get(String(marker.position.token_id))),
            fill: marker.fill
          });
        }
      }
    });
  }

  function walletPerformance(root, wallet, signal, {cutoff, note} = {}) {
    if (!walletCharts.has(root)) walletCharts.set(root, chartPanel(root, false, undefined, false));
    return loadPortfolioChart(walletCharts.get(root), wallet, signal, {cutoff, note, retry: "Reopen this profile to try again."});
  }

  async function portfolioTimeline(wallet, signal, fresh) {
    const [fills, events] = await Promise.allSettled([
      portfolioTradeMarkers(wallet, signal, fresh),
      json("/api/portfolio-events", fresh ? {wallet, fresh: "1"} : {wallet}, signal)
    ]);
    if (fills.status === "rejected" && events.status === "rejected") throw fills.reason;
    const markers = fills.value || [];
    let warning = "";
    if (events.status === "fulfilled" && Array.isArray(events.value?.settlements) && Array.isArray(events.value.deposits)) {
      for (const result of events.value.settlements) {
        if (!validChartTime(result?.timestamp) || !["won", "lost"].includes(result.kind) ||
            result.payout !== (result.kind === "won" ? 1 : 0)) continue;
        const action = result.kind === "won" ? "Won" : "Lost";
        markers.push({
          kind: result.kind, tradeIndex: markers.length, time: result.timestamp, value: result.payout,
          priceLabel: formatPrice(result.payout), label: result.outcome ? action + " " + result.outcome : action,
          market: result.title || "Polymarket position", detail: "Settlement payout per share",
          position: markerPosition(result, {status: result.kind, settlement_price: result.payout})
        });
      }
      for (const deposit of events.value.deposits) {
        if (!validChartTime(deposit?.timestamp) || !Number.isFinite(deposit.amount) || deposit.amount <= 0) continue;
        markers.push({kind: "deposit", tradeIndex: markers.length, time: deposit.timestamp, value: 0,
          priceLabel: dollars.format(deposit.amount), label: "Top-up"});
      }
    } else {
      warning = "Results and top-ups couldn’t load. Toggle Show trades to retry.";
    }
    if (fills.status === "rejected") warning = "Buy and sell fills couldn’t load. Toggle Show trades to retry.";
    return {markers: markers.sort((a, b) => a.time - b.time), warning};
  }

  async function portfolioTradeMarkers(wallet, signal, fresh) {
    const markers = [];
    const seen = new Set();
    let cursor = null;
    do {
      const params = {wallet};
      if (cursor) params.cursor = cursor;
      if (fresh) params.fresh = "1";
      const {trades, next_cursor: next} = await json("/api/trades", params, signal);
      if (!Array.isArray(trades) || !trades.every((trade) => trade && typeof trade === "object")) {
        throw new Error("Invalid trade page");
      }
      for (const trade of trades) {
        if (!plottableTrade(trade)) continue;
        const kind = trade.side === "BUY" ? "buy" : "sell";
        const action = kind === "buy" ? "Buy" : "Sell";
        const size = Number.isFinite(trade.size) ? trade.size : null;
        const amount = size === null ? null : size * trade.price;
        const fill = {...trade, type: "TRADE", usdc_size: amount};
        markers.push({
          kind, tradeIndex: markers.length, time: trade.timestamp, value: trade.price, priceLabel: formatPrice(trade.price),
          label: trade.outcome ? action + " " + trade.outcome : action, market: trade.title || "Unknown market",
          detail: size === null ? "" : shares.format(size) + " shares · " + dollars.format(amount),
          position: markerPosition(trade, {executions: [fill]}), fill
        });
      }
      if (next !== null) {
        if (typeof next !== "string" || !next || seen.has(next)) throw new Error("Invalid trade cursor");
        seen.add(next);
      }
      cursor = next;
    } while (cursor !== null);
    return markers;
  }

  function markerPosition({token_id, condition_id, title, outcome, slug}, extras) {
    if (!/^\d{1,78}$/.test(token_id || "")) return undefined;
    return {token_id, condition_id, title, outcome, slug, ...extras};
  }

  function validChartTime(timestamp) {
    return Number.isFinite(timestamp) && timestamp > 0 && timestamp <= 8.64e12;
  }

  function plottableTrade(item) {
    return (item.side === "BUY" || item.side === "SELL") &&
      validChartTime(item.timestamp) &&
      Number.isFinite(item.price) && item.price >= 0 && item.price <= 1;
  }

  function hasTradeMarker(item) {
    return item.type === "TRADE" && plottableTrade(item);
  }

  function transactionRow(item, index, chartReady) {
    const dateCell = node("time");
    const stamp = Number.isFinite(item.timestamp) ? item.timestamp * 1000 : NaN;
    if (Number.isFinite(new Date(stamp).getTime())) {
      dateCell.className = "trade-date";
      dateCell.dateTime = new Date(stamp).toISOString();
      dateCell.append(node("span", date.format(stamp)), node("span", time.format(stamp), "muted"));
    } else dateCell.textContent = "—";
    const action = item.type === "REDEEM" ? "Payout" : item.side === "BUY" ? "Buy" : item.side === "SELL" ? "Sell" : "Trade";
    const row = node("tr");
    let actionLabel = node("span", action, "side");
    if (chartReady && hasTradeMarker(item)) {
      row.dataset.tradeIndex = index;
      const kind = item.side === "BUY" ? "buy" : "sell";
      actionLabel = node("button", action, "transaction-marker legend-" + kind);
      actionLabel.type = "button";
      actionLabel.title = "Show on chart";
      const priceLabel = formatPrice(item.price);
      actionLabel.setAttribute("aria-label", `Show ${kind} at ${priceLabel} on chart`);
      actionLabel.setAttribute("aria-pressed", "false");
    }
    const metrics = [
      ["Date", dateCell], ["Type", actionLabel],
      ["Shares", Number.isFinite(item.size) ? shares.format(item.size) : "—"],
      ["Price", item.type === "TRADE" && Number.isFinite(item.price) ? formatPrice(item.price) : "—"],
      ["Amount", Number.isFinite(item.usdc_size) ? dollars.format(item.usdc_size) : "—"]
    ];
    for (const [label, value] of metrics) {
      const cell = node("td");
      const caption = node("span", label, "cell-label");
      caption.setAttribute("aria-hidden", "true");
      cell.append(caption, value);
      row.append(cell);
    }
    return row;
  }

  function positionDialog() {
    const dialog = node("dialog");
    dialog.id = "position-dialog";
    dialog.setAttribute("aria-labelledby", "activity-market-title");
    dialog.innerHTML = `
      <header class="activity-header">
        <div><h2 id="activity-market-title"></h2><div class="meta" id="activity-meta"></div></div>
        <form method="dialog"><button type="submit" class="text-button activity-dismiss" aria-label="Close position" autofocus>×</button></form>
        <dl class="activity-metrics" id="activity-summary" aria-label="Position summary">
          <div><dt id="activity-entry-label">Avg. entry</dt><dd id="activity-entry">—</dd></div>
          <div><dt id="activity-price-label">Current price</dt><dd id="activity-price">—</dd></div>
          <div><dt id="activity-pnl-label">Unrealized P&amp;L</dt><dd id="activity-pnl">—</dd></div>
        </dl>
        <div class="activity-actions">
          <button type="button" class="secondary-button" id="activity-follow" hidden>Follow</button>
          <button type="button" class="secondary-button" id="activity-alert" hidden>Add alert</button>
          <a class="secondary-button button-link" id="activity-precedents" hidden>Compare with past markets</a>
          <a class="secondary-button button-link" id="activity-holders" hidden>Holder analysis</a>
          <a class="secondary-button button-link activity-external" id="activity-polymarket" target="_blank" rel="noopener noreferrer">Open on Polymarket ↗</a>
          <p id="activity-watch-error" class="negative" role="alert"></p>
        </div>
      </header>
      <div class="activity-body" id="activity-body">
        <div id="activity-chart" class="market-chart"></div>
        <div id="activity-transactions">
          <h3 id="transactions-heading">Transactions</h3>
          <table id="activity-table" aria-labelledby="transactions-heading" hidden>
            <thead><tr><th scope="col">Date</th><th scope="col">Type</th><th scope="col">Shares</th><th scope="col">Price</th><th scope="col">Amount</th></tr></thead>
            <tbody></tbody>
          </table>
          <p id="activity-empty" class="muted" role="status" hidden></p>
          <p id="activity-source" class="muted" hidden>P&amp;L reported by Polymarket.</p>
        </div>
      </div>`;
    const table = dialog.querySelector("#activity-table");
    const panel = chartPanel(dialog.querySelector("#activity-chart"), true, (index, scrollToRow) => {
      const previous = table.querySelector(".is-chart-selected");
      const active = index === null ? null : table.querySelector(`[data-trade-index="${index}"]`);
      if (previous && previous !== active) {
        previous.classList.remove("is-chart-selected");
        previous.querySelector("button").setAttribute("aria-pressed", "false");
      }
      if (active) {
        active.classList.add("is-chart-selected");
        active.querySelector("button").setAttribute("aria-pressed", "true");
        if (scrollToRow) active.scrollIntoView({block: "nearest"});
      }
    });
    table.addEventListener("click", (event) => {
      const row = event.target.closest("[data-trade-index]");
      if (row) panel.selectTrade(Number(row.dataset.tradeIndex));
    });
    dialog.addEventListener("close", () => {
      if (!dialog.open) detailRequest?.abort();
    });
    document.querySelector("main").append(dialog);
    return {dialog, panel};
  }

  function transactions(dialog, history, message, chartReady = false) {
    const table = dialog.querySelector("#activity-table");
    const rows = document.createDocumentFragment();
    for (const [index, transaction] of history.entries()) rows.append(transactionRow(transaction, index, chartReady));
    table.querySelector("tbody").replaceChildren(rows);
    table.hidden = !history.length;
    const empty = dialog.querySelector("#activity-empty");
    empty.textContent = message || "No individual transactions were returned for this position.";
    empty.hidden = Boolean(history.length);
  }

  function chartData(points, history, position, settled) {
    const markers = [];
    for (const [tradeIndex, item] of history.entries()) {
      if (!hasTradeMarker(item)) continue;
      const buy = item.side === "BUY";
      markers.push({tradeIndex, time: item.timestamp, value: item.price, kind: buy ? "buy" : "sell", label: buy ? "Buy" : "Sell",
        detail: Number.isFinite(item.size) ? shares.format(item.size) + " shares" : ""});
    }
    const last = points.at(-1);
    const lastSell = markers.find(({kind}) => kind === "sell");
    const after = position.status !== "open" && last && lastSell && last[0] > lastSell.time ? lastSell.time : null;
    if (settled && last) markers.push({time: last[0], value: last[1], label: "Settlement", kind: "settlement"});
    const legend = [["line", "Market price"], ["buy", "Buy"], ["sell", "Sell"], ["settlement", "Settlement"]]
      .filter(([kind]) => kind === "line" ? points.length : markers.some((marker) => marker.kind === kind));
    const comparison = after && `Last sell ${formatPrice(lastSell.value)} · ${settled ? "Settlement" : "Latest"} ${formatPrice(last[1])}`;
    return {points, markers, after, legend,
      subtitle: comparison || "",
      note: after ? "Shaded area shows the market after your last sale." : ""};
  }

  function positionMetrics(dialog, position, market = null) {
    const open = position.status === "open";
    const entry = position.avg_price ?? position.entry_price;
    const latest = market?.points.at(-1)?.[1];
    const exit = Number.isFinite(position.exit_price);
    const settled = Number.isFinite(position.settlement_price);
    const quote = open ? position.current_price ?? latest : position.exit_price ?? position.settlement_price ?? latest;
    const label = open ? "Current price" : exit ? "Avg. sell" : settled || market?.settled ? "Settlement" : "Market price";
    const profit = open ? position.unrealized_pnl : position.pnl;
    dialog.querySelector("#activity-entry-label").textContent = "Avg. entry";
    dialog.querySelector("#activity-entry").textContent = Number.isFinite(entry) ? formatPrice(entry) : "—";
    dialog.querySelector("#activity-price-label").textContent = label;
    dialog.querySelector("#activity-price").textContent = Number.isFinite(quote) ? formatPrice(quote) : "—";
    dialog.querySelector("#activity-pnl-label").textContent = open ? "Unrealized P&L" : "Net P&L";
    const result = dialog.querySelector("#activity-pnl");
    result.className = profit >= .005 ? "positive" : profit <= -.005 ? "negative" : "";
    result.textContent = Number.isFinite(profit) ? signedDollars.format(Math.abs(profit) < .005 ? 0 : profit) : "—";
  }

  function positionHeader(dialog, position, market, preview) {
    dialog.querySelector("#activity-market-title").textContent = position.title || "Unknown market";
    const compare = dialog.querySelector("#activity-precedents");
    const holders = dialog.querySelector("#activity-holders");
    const closed = market?.settled || ["won", "lost", "settled"].includes(position.status);
    DashboardWatchlist.mountActions(dialog.querySelector("#activity-follow"), dialog.querySelector("#activity-alert"),
      dialog.querySelector("#activity-watch-error"), {...position, ...preview, state: preview?.state || (closed ? "closed" : undefined)});
    const namedOutcome = !preview && position.outcome && !/^(yes|no)$/i.test(position.outcome);
    compare.hidden = !/^[a-z0-9][a-z0-9-]{0,250}$/.test(position.slug || "") ||
      preview?.compare === false || Boolean(position.is_combo || namedOutcome);
    compare.onclick = compare.hidden ? null : preview?.onCompare || null;
    holders.hidden = !/^[a-z0-9][a-z0-9-]{0,250}$/.test(position.slug || "") || Boolean(position.is_combo);
    if (holders.hidden) holders.removeAttribute("href");
    else {
      const params = new URLSearchParams({market: position.slug});
      if (preview?.catalog_query !== undefined) params.set("catalog", preview.catalog_query);
      else if (location.pathname === "/trades") params.set("source", "trades");
      else if (location.pathname === "/") params.set("source", "portfolio");
      holders.href = "/holders?" + params;
    }
    holders.onclick = holders.hidden ? null : preview?.onCompare || null;
    if (compare.hidden) compare.removeAttribute("href");
    else {
      const destination = {market: position.slug};
      if (preview?.catalog_query !== undefined) destination.catalog = preview.catalog_query;
      else if (location.pathname === "/trades") destination.source = "trades";
      compare.href = "/precedents?" + new URLSearchParams(destination);
    }
    const meta = dialog.querySelector("#activity-meta");
    dialog.querySelector("#activity-summary").setAttribute("aria-label", preview ? "Market summary" : "Position summary");
    dialog.querySelector(".activity-dismiss").setAttribute("aria-label", preview ? "Close market" : "Close position");
    if (preview) {
      const subtitle = preview.event_title && preview.event_title !== preview.title ? preview.event_title : "";
      meta.replaceChildren();
      if (subtitle) meta.append(node("span", subtitle, "muted"));
      if (preview.state === "open" || preview.state === "closed") {
        const state = node("span", preview.state === "open" ? "Open" : "Trading closed", "position-state");
        state.dataset.status = preview.state;
        meta.append(state);
      }
      const end = Number.isFinite(preview.end_at) ? preview.end_at * 1000 : Date.parse(preview.end_date);
      const [first, second] = preview.outcomes || [
        {label: "Yes", price: preview.indicative_prices?.yes},
        {label: "No", price: preview.indicative_prices?.no}
      ];
      for (const [id, label, value] of [
        ["entry", first.label + " price", first.price],
        ["price", second.label + " price", second.price],
        ["pnl", "Scheduled end", Number.isFinite(end) ? date.format(end) : "—"]
      ]) {
        dialog.querySelector(`#activity-${id}-label`).textContent = label;
        const field = dialog.querySelector(`#activity-${id}`);
        field.className = "";
        field.textContent = Number.isFinite(value) ? formatPrice(value) : value || "—";
      }
      return;
    }
    meta.replaceChildren(...positionBadges(position));
    positionMetrics(dialog, position, market);
    dialog.querySelector("#activity-source").hidden = position.pnl_source !== "polymarket";
  }

  async function positionLink(dialog, position, preview, signal) {
    const link = dialog.querySelector("#activity-polymarket");
    const valid = (slug) => /^[a-z0-9][a-z0-9-]{0,250}$/.test(slug || "");
    const slug = position.slug;
    link.dataset.slug = slug || "";
    const url = (event) => "https://polymarket.com/event/" + event + (event !== slug ? "/" + slug : "");
    const event = preview?.event_slug || position.event_slug;
    if (valid(slug) && valid(event)) {
      link.href = url(event);
      return;
    }
    const search = "https://polymarket.com/search?" + new URLSearchParams({q: position.title || slug || ""});
    link.href = search;
    if (!valid(slug)) return;
    try {
      const {markets} = await json("/api/market-metadata", {market: slug}, signal);
      if (signal.aborted || link.dataset.slug !== slug) return;
      const parent = markets?.[slug]?.event_slug;
      if (markets?.[slug]) link.href = valid(parent) ? url(parent) : url(slug);
    } catch {
      // Search remains available when metadata is temporarily unavailable.
    }
  }

  function openMarket(market) {
    const {title, slug, token_id = market.yes_token, condition_id} = market;
    return openPosition({title, slug, token_id, condition_id}, undefined, {preview: market});
  }

  async function openPosition(position, wallet, {summary, fill, preview} = {}) {
    detail ||= positionDialog();
    detailRequest?.abort();
    const request = new AbortController();
    detailRequest = request;
    const {dialog, panel} = detail;
    const heading = preview ? (preview.outcomes?.[0]?.label || "Yes") + " price history" : undefined;
    const emptyHistory = {heading, points: [], markers: []};
    positionHeader(dialog, position, null, preview);
    positionLink(dialog, position, preview, request.signal);
    dialog.querySelector("#activity-transactions").hidden = Boolean(preview);
    let history = [...(position.executions || [])].sort((a, b) => b.timestamp - a.timestamp);
    if (!preview) transactions(dialog, history, wallet ? "Loading transactions…" : "");
    panel.show("Loading market prices…", emptyHistory);
    if (!dialog.open) dialog.showModal();
    dialog.querySelector("#activity-body").scrollTop = 0;

    if (preview && !/^\d{1,78}$/.test(position.token_id || "")) {
      panel.show("Price history unavailable", emptyHistory);
      return;
    }

    const params = {token: position.token_id};
    if (/^0x[0-9a-f]{64}$/i.test(position.condition_id || "")) params.condition = position.condition_id;
    if (wallet && params.condition) params.wallet = wallet;
    const [market, fullPosition] = await Promise.all([
      json("/api/market-history", params, request.signal).catch(() => ({points: [], price_error: true, settled: false})),
      summary
    ]);
    if (request.signal.aborted) return;
    if (fullPosition) {
      position = {...position, ...fullPosition, slug: fullPosition.slug || position.slug,
        settlement_price: fullPosition.settlement_price ?? position.settlement_price};
    }
    if (fullPosition?.executions?.length) {
      history = [...fullPosition.executions].sort((a, b) => b.timestamp - a.timestamp);
    } else if (wallet && Array.isArray(market.executions) && (market.executions.length || !history.length)) {
      history = market.executions.sort((a, b) => b.timestamp - a.timestamp);
    }
    market.points = (Array.isArray(market.points) ? market.points : []).filter((point) =>
      Array.isArray(point) && validChartTime(point[0]) && Number.isFinite(point[1]) && point[1] >= 0 && point[1] <= 1);
    const hasHistory = !market.price_error && market.points.length >= 2 && market.points[0][0] < market.points.at(-1)[0];
    if (!preview) transactions(dialog, history, wallet && !market.executions ? "Transactions couldn’t load for this market." : "", hasHistory);
    if (fullPosition) {
      positionHeader(dialog, position, market);
      positionLink(dialog, position, preview, request.signal);
    }
    else if (!preview) positionHeader(dialog, position, market);
    if (!hasHistory) {
      panel.show("Price history unavailable", emptyHistory);
      return;
    }
    const data = chartData(market.points, history, position, market.settled);
    const alertTarget = preview?.alert_target;
    if (Number.isFinite(alertTarget)) data.legend.push(["alert", "Alert threshold " + formatPrice(alertTarget)]);
    panel.show("", preview ? {...data, heading, alertTarget} : data);
    if (fill) {
      const candidates = history.map((item, index) => ({item, index})).filter(({item}) =>
        item.type === "TRADE" && item.timestamp === fill.timestamp && item.side === fill.side &&
        item.price === fill.price && (!item.transaction_hash || !fill.transaction_hash || item.transaction_hash === fill.transaction_hash));
      let match = candidates.find(({item}) => item.size === fill.size);
      if (!match && candidates.length === 1 && fill.transaction_hash &&
          candidates[0].item.transaction_hash === fill.transaction_hash) {
        // The execution and wallet activity feeds can report different share amounts for the same fill.
        match = candidates[0];
      }
      if (match) panel.selectTrade(match.index, true);
    }
  }

  for (const group of document.querySelectorAll(".chart-ranges, .history-tabs")) slidingSelection(group);
  for (const trigger of document.querySelectorAll("[data-info-trigger]")) {
    const wrapper = trigger.closest(".info-control");
    const tip = document.getElementById(trigger.getAttribute("aria-controls"));
    const toggle = (open) => {
      trigger.setAttribute("aria-expanded", open);
      tip.hidden = !open;
    };
    trigger.addEventListener("click", () => toggle(tip.hidden));
    wrapper.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !tip.hidden) toggle(false);
    });
    document.addEventListener("pointerdown", (event) => {
      if (!tip.hidden && !wrapper.contains(event.target)) toggle(false);
    });
  }

  return {portfolio, walletPerformance, openMarket, openPosition, marketTitle, marketImageSource, positionBadges, statuses, softUpdate, slidingSelection, loadOnScroll,
    setPortfolioRange(days) { portfolioPanel?.setRange(days); }};
})();
