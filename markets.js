"use strict";

(() => {
  const byId = (id) => document.getElementById(id);
  const categories = new Map([
    ["trending", "Trending"], ["new", "New"], ["live", "Live"], ["politics", "Politics"], ["geopolitics", "Geopolitics"],
    ["elections", "Elections"], ["finance", "Finance"], ["economy", "Economy"], ["tech", "Tech"],
    ["pop-culture", "Culture"], ["sports", "Sports"], ["esports", "Esports"], ["crypto", "Crypto"],
    ["weather", "Weather"]
  ]);
  const topics = [...categories].slice(3);
  const filterNames = ["side", "band", "ends", "from", "through", "liquidity", "spread"];
  const filterCookie = "polymarket_market_filters";
  const fields = Object.fromEntries(filterNames.map((name) => [name, byId("catalog-" + name)]));
  const sort = byId("catalog-sort");
  const searchForm = byId("catalog-search");
  const input = byId("catalog-query");
  const suggestions = byId("catalog-suggestions");
  const suggestionList = byId("catalog-suggestion-list");
  const suggestionStatus = byId("catalog-suggestion-status");
  const filtersDialog = byId("catalog-filter-dialog");
  const eventDialog = byId("catalog-event-dialog");
  const eventViewport = eventDialog.querySelector(".market-dialog-scroll");
  const eventThumbnails = new IntersectionObserver((entries, observer) => {
    for (const {target, isIntersecting} of entries) {
      if (isIntersecting && target.isConnected) {
        target.src = target.dataset.imageSrc;
        delete target.dataset.imageSrc;
        observer.unobserve(target);
      }
    }
  }, {root: eventViewport, rootMargin: "160px 0px"});
  const eventSearch = byId("catalog-event-search");
  const eventCanvas = byId("event-history-chart");
  const eventCursor = byId("event-history-cursor");
  const eventAnnouncement = byId("event-history-announcement");
  const eventRangeControls = byId("event-history-ranges");
  const eventLegend = byId("event-history-legend");
  const eventHistoryStatus = byId("event-history-status");
  const eventListStatus = byId("catalog-event-list-status");
  const eventRetry = byId("catalog-event-retry");
  const grid = byId("catalog-grid");
  const more = byId("catalog-more");
  const moreLabel = byId("catalog-more-label");
  const moreLoader = byId("catalog-more-loader");
  const pagination = byId("catalog-pagination");
  const moreStatus = byId("catalog-more-status");
  const pane = byId("catalog-pane");
  const observeMarketScroll = DashboardWidgets.loadOnScroll(pagination, appendMarkets);
  const status = byId("catalog-status");
  const error = byId("catalog-error");
  const percent = new Intl.NumberFormat("en-US", {style: "percent", maximumFractionDigits: 2});
  const shortPercent = new Intl.NumberFormat("en-US", {style: "percent", maximumFractionDigits: 1});
  const dollars = new Intl.NumberFormat("en-US", {style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1});
  const date = new Intl.DateTimeFormat("en-US", {dateStyle: "medium"});
  const cursorDate = new Intl.DateTimeFormat("en-US", {month: "short", day: "numeric", hour: "numeric", minute: "2-digit"});
  const shortDate = new Intl.DateTimeFormat("en-US", {month: "short", day: "numeric"});
  const seriesColors = ["#acbbff", "#66dcbb", "#ffc17d", "#eb96ca"];
  const pageSize = 12;
  let state;
  let entries = new Map();
  let cursor = null;
  let limit = pageSize;
  let request;
  let selectedEvent;
  let eventMarkets = [];
  let eventSeries = [];
  let eventRange = 30;
  let eventRequest;
  let eventPlot;
  let eventCursorTime;
  let catalogLocation;
  let restoreRequest;
  let suggestionTimer;
  let suggestionRequest;
  let sparsePages = 0;
  const renderedCards = new Map();
  const seenCursors = new Set();

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function button(text, className, action) {
    const element = node("button", text, className);
    element.type = "button";
    element.addEventListener("click", action);
    return element;
  }

  for (let band = 0; band < 10; band++) {
    fields.band.add(new Option(band * 10 + "–" + (band + 1) * 10 + "%", String(band)));
  }
  for (const [key, label] of categories) {
    const item = button(label, "", () => {
      if (state.category !== key) navigate({...state, category: key});
    });
    item.dataset.category = key;
    byId("catalog-categories").append(item);
  }
  for (const [key, title] of topics) {
    const label = node("label");
    const checkbox = node("input");
    checkbox.type = "checkbox";
    checkbox.value = key;
    label.append(checkbox, title);
    byId("catalog-exclude").append(label);
  }
  const exclusions = [...byId("catalog-exclude").querySelectorAll("input")];

  function savedFilters() {
    try {
      const prefix = filterCookie + "=";
      const entry = document.cookie.split(";").map((value) => value.trim()).find((value) => value.startsWith(prefix));
      return new URLSearchParams(entry ? decodeURIComponent(entry.slice(prefix.length)) : "");
    } catch {
      return new URLSearchParams();
    }
  }

  function readState() {
    const params = new URLSearchParams(location.search);
    const hasFilters = [...filterNames, "exclude"].some((key) => params.has(key));
    const filterParams = hasFilters || history.state?.catalogFilters ? params : savedFilters();
    const category = params.get("category");
    const selectedSort = params.get("sort");
    const filters = {};
    for (const name of filterNames) {
      const field = fields[name];
      field.value = filterParams.get(name) || (name === "side" ? "yes" : "");
      filters[name] = field.value || (name === "side" ? "yes" : "");
    }
    const exclude = [...new Set((filterParams.get("exclude") || "").split(","))]
      .filter((key) => topics.some(([tag]) => tag === key));
    return {
      q: (params.get("q") || "").slice(0, 700).trim(),
      category: categories.has(category) && !exclude.includes(category) ? category : "trending",
      sort: [...sort.options].some((option) => option.value === selectedSort) ? selectedSort : "auto",
      exclude,
      ...filters,
    };
  }

  function filterParameters(current) {
    const params = new URLSearchParams();
    if (current.band && current.side === "no") params.set("side", "no");
    for (const key of ["band", "ends", "liquidity", "spread"]) if (current[key]) params.set(key, current[key]);
    if (current.exclude.length) params.set("exclude", current.exclude.join(","));
    if (current.ends === "custom") {
      if (current.from) params.set("from", current.from);
      if (current.through) params.set("through", current.through);
    }
    return params;
  }

  function parameters(current) {
    const params = new URLSearchParams();
    if (current.q) params.set("q", current.q);
    if (current.category !== "trending") params.set("category", current.category);
    if (current.sort !== "auto") params.set("sort", current.sort);
    for (const [key, value] of filterParameters(current)) params.set(key, value);
    return params;
  }

  function saveFilters(current) {
    const value = filterParameters(current).toString();
    const secure = location.protocol === "https:" ? "; Secure" : "";
    try {
      document.cookie = filterCookie + "=" + encodeURIComponent(value) + "; Path=/markets; SameSite=Lax; Max-Age=" +
        (value ? 180 * 86400 : 0) + secure;
    } catch {
      // The page URL still carries filters when cookies are unavailable.
    }
  }

  function midnight(value, nextDay = false) {
    const day = new Date(value + "T00:00:00");
    if (nextDay) day.setDate(day.getDate() + 1);
    return Math.round(day.getTime() / 1000);
  }

  function updateLocation(next, replace = false, selection) {
    const params = parameters(next);
    catalogLocation = params.toString();
    if (selection?.event) params.set("event", selection.event);
    if (selection?.market) params.set("market", selection.market);
    if (selection?.overview) params.set("overview", "1");
    const query = params.toString();
    const url = "/markets" + (query ? "?" + query : "") + location.hash;
    if (replace || location.pathname + location.search + location.hash !== url) {
      history[replace ? "replaceState" : "pushState"]({catalogFilters: true}, "", url);
    }
  }

  function navigate(next) {
    closeSuggestions();
    restoreRequest?.abort();
    state = next;
    updateLocation(next);
    load(true);
  }

  function renderControls() {
    input.value = state.q;
    for (const field of byId("catalog-categories").children) {
      const tag = field.dataset.category;
      field.setAttribute("aria-pressed", String(tag === state.category));
      field.disabled = state.exclude.includes(tag);
      field.title = field.disabled ? "Excluded by filters" : "";
    }
    sort.options[0].textContent = state.q ? "Relevance" : "Default order";
    sort.value = state.sort;
    byId("catalog-heading").textContent = state.q ? "Search results" : state.category === "new" ? "Recently listed"
      : state.category === "trending" && ["auto", "trending"].includes(state.sort) ? "Trending by 24h activity"
        : categories.get(state.category) + " markets";
    const tags = [];
    const add = (text, patch) => {
      const chip = button(text + " ×", "secondary-button", () => {
        const next = {...state, ...patch};
        saveFilters(next);
        navigate(next);
      });
      chip.setAttribute("aria-label", "Remove filter " + text);
      tags.push(chip);
    };
    if (state.band) add((state.side === "yes" ? "Yes " : "No ") + fields.band.options[Number(state.band) + 1].text, {band: ""});
    if (state.ends) {
      const dateLabel = state.ends === "custom" ? [state.from, state.through].filter(Boolean).join(" – ") || "Custom dates"
        : fields.ends.querySelector(`option[value="${state.ends}"]`).text;
      add(dateLabel, {ends: "", from: "", through: ""});
    }
    if (state.liquidity) add(dollars.format(Number(state.liquidity)) + "+ liquidity", {liquidity: ""});
    if (state.spread) add(state.spread + "¢ max spread", {spread: ""});
    for (const key of state.exclude) add("Hide " + categories.get(key), {exclude: state.exclude.filter((tag) => tag !== key)});
    const active = byId("catalog-active-filters");
    active.replaceChildren(...tags);
    active.hidden = tags.length === 0;
    const filterButton = byId("catalog-filters");
    filterButton.textContent = tags.length ? `Filters (${tags.length})` : "Filters";
    filterButton.setAttribute("aria-label", tags.length ? `Filters (${tags.length} active)` : "Filters");
    filterButton.classList.toggle("has-active-filters", tags.length > 0);
  }

  function setFilterForm(current) {
    for (const key of filterNames) fields[key].value = current[key] || (key === "side" ? "yes" : "");
    for (const input of exclusions) input.checked = current.exclude.includes(input.value);
    byId("catalog-custom-dates").hidden = fields.ends.value !== "custom";
    byId("catalog-filter-error").hidden = true;
  }

  function imageFor(record, defer = false) {
    if (typeof record.image !== "string" || !record.image.startsWith("https://")) return null;
    const image = node("img");
    image.alt = "";
    image.decoding = "async";
    image.loading = "lazy";
    image.addEventListener("error", () => image.remove(), {once: true});
    const source = DashboardWidgets.marketImageSource(record.image);
    if (defer) {
      image.fetchPriority = "low";
      image.dataset.imageSrc = source;
      eventThumbnails.observe(image);
    } else image.src = source;
    return image;
  }

  function showMarket(market, event, {keepTrade, relatedEvent} = {}) {
    restoreRequest?.abort();
    const selection = {event: event.slug, market: market.slug, overview: eventDialog.open};
    updateLocation(state, true, selection);
    DashboardWidgets.openMarket({
      ...market, image: market.image || event.image, event_title: event.title, event_slug: event.slug,
      catalog_query: location.search, relatedEvent,
      onRelatedMarket(next, fullEvent, tradeOpen) {
        showMarket(next, fullEvent, {keepTrade: tradeOpen, relatedEvent: fullEvent});
      },
      onClose() {
        if (pane.hidden || new URLSearchParams(location.search).get("market") !== market.slug) return;
        updateLocation(state, true, eventDialog.open ? {event: event.slug} : undefined);
      }
    }, keepTrade);
  }

  async function restoreSelection(selection) {
    restoreRequest?.abort();
    const controller = new AbortController();
    restoreRequest = controller;
    try {
      const params = catalogParameters();
      params.set("event", selection.event);
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
      const fetchEvent = async (query) => {
        const response = await fetch("/api/markets?" + query, {signal});
        if (!response.ok) return;
        const {events} = await response.json();
        return events.find(({slug}) => slug === selection.event);
      };
      let event = await fetchEvent(params);
      let market = event?.markets.find(({slug}) => slug === selection.market);
      if (selection.market && !market && params.size > 1) {
        event = await fetchEvent(new URLSearchParams({event: selection.event}));
        market = event?.markets.find(({slug}) => slug === selection.market);
      }
      if (controller.signal.aborted || pane.hidden) return;
      if (event && (!selection.market || selection.overview) && (!eventDialog.open || selectedEvent?.slug !== event.slug)) {
        openEvent(event);
      }
      if (market) showMarket(market, event);
    } catch {
      // The catalog stays usable when a previously opened market is unavailable.
    }
  }

  function priceLabel(value) {
    return Number.isFinite(value) ? percent.format(value) : "—";
  }

  function closeSuggestions() {
    clearTimeout(suggestionTimer);
    suggestionTimer = undefined;
    suggestionRequest?.abort();
    suggestionRequest = undefined;
    suggestions.hidden = true;
    suggestionList.replaceChildren();
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function showSuggestionStatus(message) {
    suggestionStatus.textContent = message;
    suggestionStatus.hidden = !message;
  }

  function suggestionRow(event, index) {
    const market = event.markets[0];
    const row = button(undefined, "market-suggestion", () => {
      closeSuggestions();
      showMarket(market, event);
    });
    row.id = "catalog-suggestion-" + index;
    row.tabIndex = -1;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", "false");
    const image = imageFor({image: market.image || event.image});
    if (image) row.append(image);
    const text = node("span", undefined, "market-suggestion-text");
    text.append(node("strong", event.title));
    if (market.label !== event.title) text.append(node("small", market.label));
    const quote = market.outcomes[0];
    const price = node("span", undefined, "market-suggestion-price");
    price.append(node("strong", priceLabel(quote.price)), node("small", quote.label));
    row.append(text, price);
    return row;
  }

  async function loadSuggestions(q) {
    suggestionTimer = undefined;
    const controller = new AbortController();
    suggestionRequest = controller;
    const params = catalogParameters({...state, q, sort: "auto", category: "trending"});
    params.set("suggest", "1");
    showSuggestionStatus("Searching markets…");
    suggestions.hidden = false;
    input.setAttribute("aria-expanded", "true");
    try {
      const response = await fetch("/api/markets?" + params, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)])
      });
      if (!response.ok) throw new Error("Suggestions unavailable");
      const {events} = await response.json();
      if (suggestionRequest !== controller) return;
      suggestionList.replaceChildren(...events.map(suggestionRow));
      showSuggestionStatus(events.length ? "" : "No matches in the preview.");
    } catch {
      if (suggestionRequest === controller) showSuggestionStatus("Preview unavailable. You can still search.");
    } finally {
      if (suggestionRequest === controller) suggestionRequest = undefined;
    }
  }

  function queueSuggestions() {
    closeSuggestions();
    const q = input.value.trim();
    if (q.length < 3 || q === state.q || /^(?:https?:\/\/|(?:www\.)?polymarket\.com\/)/i.test(q)) return;
    suggestionTimer = setTimeout(() => loadSuggestions(q), 250);
  }

  function quotePair(market, compact = false) {
    const pair = node("span", undefined, "market-quote-pair");
    for (const item of market.outcomes) {
      const quote = node("span", undefined, "market-quote");
      quote.dataset.side = DashboardWidgets.binaryOutcome(item.label);
      const price = item.price;
      const label = !compact || !Number.isFinite(price) ? priceLabel(price)
        : price > 0 && price < .001 ? "<0.1%" : price < 1 && price > .999 ? ">99.9%" : shortPercent.format(price);
      quote.append(node("span", item.label, "market-quote-label"), node("strong", label));
      if (compact) quote.title = item.label + " " + priceLabel(item.price);
      pair.append(quote);
    }
    return pair;
  }

  function marketRow(market, event) {
    const row = button(undefined, "event-market-row", () => showMarket(market, event));
    row.setAttribute("aria-haspopup", "dialog");
    row.setAttribute("aria-label", "Show trade · " + market.title);
    const identity = node("span", undefined, "event-row-identity");
    const image = imageFor(market.image ? market : event, true);
    const series = eventSeries.find((item) => item.market.slug === market.slug);
    if (image) identity.append(image);
    if (series && (!image || !market.image || market.image === event.image)) {
      const swatch = node("span", undefined, "event-series-key");
      swatch.dataset.series = series.slot;
      swatch.setAttribute("aria-hidden", "true");
      identity.append(swatch);
    }
    const details = node("span", undefined, "event-row-details");
    details.append(node("strong", market.label));
    if (market.volume_24h > 0) details.append(node("small", dollars.format(market.volume_24h) + " 24h vol.", "muted"));
    identity.append(details);
    const chevron = node("span", "›", "event-row-chevron");
    chevron.setAttribute("aria-hidden", "true");
    row.append(identity, quotePair(market), chevron);
    return row;
  }

  function matchingMarkets(event) {
    return event.matching_market_count ?? event.markets.length;
  }

  function renderEventList() {
    eventThumbnails.disconnect();
    const sought = normalize(eventSearch.value);
    const rows = eventMarkets.filter((market) => normalize(market.label + " " + market.title).includes(sought));
    const total = matchingMarkets(selectedEvent);
    byId("catalog-event-count").textContent = sought ? rows.length + " of " + total : String(total);
    const content = rows.map((row) => marketRow(row, selectedEvent));
    if (!rows.length && eventMarkets.length >= total) content.push(node("p", "No markets match this search.", "muted"));
    byId("catalog-event-list").replaceChildren(...content);
  }

  function normalize(value) {
    return value.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").trim();
  }

  function drawEventHistory() {
    if (eventCanvas.hidden) return;
    eventPlot = DashboardLineChart.drawComparison(eventCanvas, eventSeries.filter((series) => series.points.length >= 2), eventRange);
    if (eventCursorTime !== undefined && eventPlot && eventCursorTime >= eventPlot.start && eventCursorTime <= eventPlot.end)
      showEventCursor(eventCursorTime);
    else clearEventCursor();
  }

  function eventSeriesName(market) {
    const outcome = market.outcomes[0].label;
    return DashboardWidgets.binaryOutcome(outcome) ? market.label
      : market.title === selectedEvent.title ? outcome : market.label + " · " + outcome;
  }

  function clearEventCursor() {
    eventCursorTime = undefined;
    eventCursor.hidden = true;
    eventAnnouncement.textContent = "";
  }

  function showEventCursor(timestamp, announce = false) {
    const plot = eventPlot;
    const quotes = plot.valuesAt(timestamp).sort((first, second) => first.y - second.y);
    if (!quotes.length) return clearEventCursor();
    eventCursorTime = timestamp;
    const position = plot.x(timestamp);
    const roomBefore = position;
    const roomAfter = eventCanvas.clientWidth - position;
    const left = roomAfter < 185 && roomBefore > roomAfter;
    const labelX = (position + (left ? -9 : 9)) + "px";
    const maxWidth = Math.min(225, (left ? roomBefore : roomAfter) - 12) + "px";
    const shade = node("span", undefined, "event-cursor-future");
    const guide = node("span", undefined, "event-cursor-guide");
    for (const mark of [shade, guide]) {
      mark.style.left = position + "px";
      mark.style.top = plot.top + "px";
      mark.style.height = (plot.bottom - plot.top) + "px";
    }
    shade.style.width = (plot.right - position) + "px";
    const stamp = cursorDate.format(timestamp * 1000);
    const heading = node("span", stamp, "event-cursor-time");
    heading.style.left = labelX;
    heading.style.maxWidth = maxWidth;
    const children = [shade, guide, heading];
    let next = 34;
    const summaries = [];
    for (const [index, quote] of quotes.entries()) {
      const dot = node("span", undefined, "event-cursor-dot");
      dot.dataset.series = quote.slot;
      dot.style.left = position + "px";
      dot.style.top = quote.y + "px";
      const label = node("span", undefined, "event-cursor-quote");
      label.dataset.series = quote.slot;
      const name = eventSeriesName(quote.market);
      const price = priceLabel(quote.price);
      label.append(node("span", name), node("strong", price));
      label.style.left = labelX;
      label.style.maxWidth = maxWidth;
      const labelY = Math.min(Math.max(next, quote.y), plot.bottom - 3 - (quotes.length - index - 1) * 23);
      label.style.top = labelY + "px";
      next = labelY + 23;
      children.push(dot, label);
      summaries.push(name + " " + price);
    }
    eventCursor.classList.toggle("is-left", left);
    eventCursor.replaceChildren(...children);
    eventCursor.hidden = false;
    if (announce) eventAnnouncement.textContent = stamp + ". " + summaries.join(", ");
  }

  function inspectEventHistory(event) {
    if (!eventPlot) return;
    const plot = eventPlot;
    const rect = eventCanvas.getBoundingClientRect();
    const offset = event.clientX - rect.left;
    if (offset < plot.left || offset > plot.right) return clearEventCursor();
    const timestamp = plot.start + (plot.end - plot.start) * (offset - plot.left) / (plot.right - plot.left);
    showEventCursor(timestamp, event.pointerType === "touch");
  }

  function renderEventHistory() {
    const available = eventSeries.filter((series) => series.points.length >= 2);
    delete eventHistoryStatus.dataset.loading;
    eventCanvas.hidden = eventLegend.hidden = eventRangeControls.hidden = !available.length;
    eventHistoryStatus.hidden = Boolean(available.length);
    if (!available.length) {
      eventHistoryStatus.textContent = "Price history is unavailable for these markets.";
      return;
    }
    for (const control of eventRangeControls.querySelectorAll("button")) {
      control.setAttribute("aria-pressed", String(Number(control.dataset.days) === eventRange));
    }
    const focusedSeries = eventLegend.contains(document.activeElement) ? document.activeElement.dataset.series : undefined;
    eventLegend.replaceChildren(...available.map((series) => {
      const {market} = series;
      const name = eventSeriesName(market);
      const toggle = button(undefined, "event-series-toggle", () => {
        if (series.visible && available.filter((item) => item.visible).length === 1) return;
        series.visible = !series.visible;
        toggle.setAttribute("aria-pressed", String(series.visible));
        drawEventHistory();
      });
      toggle.dataset.series = series.slot;
      toggle.setAttribute("aria-pressed", String(series.visible));
      toggle.title = market.title + " · " + market.outcomes[0].label;
      toggle.append(node("span", name, "event-series-label"), node("strong", priceLabel(market.outcomes[0].price)));
      return toggle;
    }));
    if (focusedSeries !== undefined) eventLegend.querySelector(`[data-series="${focusedSeries}"]`)?.focus({preventScroll: true});
    drawEventHistory();
  }

  async function loadEventHistory(signal) {
    eventCanvas.hidden = eventLegend.hidden = eventRangeControls.hidden = true;
    eventPlot = undefined;
    clearEventCursor();
    eventHistoryStatus.textContent = "Loading price history…";
    eventHistoryStatus.dataset.loading = "";
    eventHistoryStatus.hidden = false;
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(12000)]);
    await Promise.all(eventSeries.map(async (series) => {
      try {
        const params = new URLSearchParams({token: series.market.token_id});
        const response = await fetch("/api/market-history?" + params, {signal: timeout, priority: "high"});
        if (!response.ok) return;
        const {points} = await response.json();
        series.points = points.filter(([timestamp, price]) => Number.isFinite(timestamp) && Number.isFinite(price) && price >= 0 && price <= 1);
        if (!signal.aborted && eventCanvas.hidden && series.points.length >= 2) renderEventHistory();
      } catch {
        // Other series can still be displayed if a market has no history.
      }
    }));
    if (!signal.aborted) renderEventHistory();
  }

  async function loadEventMarkets(event, signal) {
    eventRetry.hidden = true;
    eventListStatus.hidden = false;
    eventListStatus.textContent = "Loading submarkets…";
    const params = catalogParameters();
    params.set("event", event.slug);
    try {
      const response = await fetch("/api/markets?" + params, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]), priority: "high"
      });
      if (!response.ok) throw new Error("Submarkets couldn’t load.");
      const {events} = await response.json();
      if (signal.aborted) return;
      const full = events.find(({slug}) => slug === event.slug);
      if (!full) throw new Error("Matching submarkets are no longer available.");
      selectedEvent = full;
      eventMarkets = full.markets;
      eventListStatus.hidden = true;
      renderEventList();
    } catch (failure) {
      if (signal.aborted) return;
      eventListStatus.textContent = ["TypeError", "TimeoutError"].includes(failure.name)
        ? "Submarkets couldn’t load." : failure.message;
      eventRetry.hidden = false;
    }
  }

  function openEvent(event) {
    restoreRequest?.abort();
    eventRequest?.abort();
    eventRequest = new AbortController();
    selectedEvent = event;
    updateLocation(state, true, {event: event.slug});
    eventMarkets = event.markets;
    eventSeries = eventMarkets.filter((market) => /^\d{1,78}$/.test(market.token_id || "")).slice(0, seriesColors.length)
      .map((market, slot) => ({market, slot, color: seriesColors[slot], points: [], visible: true}));
    eventRange = 30;
    const image = imageFor(event);
    const art = byId("catalog-event-art");
    art.replaceChildren(...(image ? [image] : []));
    art.hidden = !image;
    byId("catalog-event-title").textContent = event.title;
    const category = byId("catalog-event-category");
    category.textContent = categories.get(event.categories[0]) || "";
    category.hidden = !category.textContent;
    const stats = [];
    if (event.volume > 0) stats.push(dollars.format(event.volume) + " total vol.");
    if (Number.isFinite(event.end_at)) stats.push("Ends " + date.format(event.end_at * 1000));
    byId("catalog-event-stats").textContent = stats.join(" · ");
    byId("catalog-event-link").href = "https://polymarket.com/event/" + encodeURIComponent(event.slug);
    eventSearch.value = "";
    eventSearch.hidden = matchingMarkets(event) < 7;
    eventListStatus.hidden = eventRetry.hidden = true;
    renderEventList();
    eventDialog.showModal();
    eventViewport.scrollTop = 0;
    const signal = eventRequest.signal;
    loadEventHistory(signal);
    if (matchingMarkets(event) > event.markets.length) loadEventMarkets(event, signal);
  }

  function eventCard(event) {
    const card = node("article", undefined, "market-event-card");
    const identity = node("header", undefined, "market-card-identity");
    const image = imageFor(event);
    if (image) identity.append(image);
    const title = node("div");
    const count = matchingMarkets(event);
    const cardAction = button(undefined, "market-card-action", () => {
      if (count > 1) openEvent(event);
      else showMarket(event.markets[0], event);
    });
    cardAction.setAttribute("aria-haspopup", "dialog");
    cardAction.setAttribute("aria-label", count > 1 ? "View " + count + " markets · " + event.title
      : "Show trade · " + event.markets[0].title);
    cardAction.title = event.title;
    title.append(node("h3", event.title), cardAction);
    identity.append(title);
    const options = node("div", undefined, "market-card-options");
    const markets = event.markets.slice(0, 2);
    if (count === 1) {
      const market = markets[0];
      if (market.title !== event.title && market.label !== event.title) {
        options.append(node("p", market.label, "market-single-label"));
      }
      options.classList.add("market-card-single");
      options.append(quotePair(market, true));
    } else {
      for (const market of markets) {
        const row = node("div", undefined, "market-preview-row");
        if (market.title === event.title) row.classList.add("market-preview-summary");
        else {
          const rowIdentity = node("span", undefined, "market-preview-identity");
          const icon = market.image !== event.image && imageFor(market);
          if (icon) rowIdentity.append(icon);
          rowIdentity.append(node("span", market.label, "market-preview-label"));
          row.append(rowIdentity);
        }
        row.append(quotePair(market, true));
        options.append(row);
      }
    }
    const footer = node("footer", undefined, "market-card-footer");
    const stats = [];
    if (event.volume_24h > 0) stats.push(dollars.format(event.volume_24h) + " 24h vol.");
    if (Number.isFinite(event.end_at)) {
      const end = new Date(event.end_at * 1000);
      stats.push("Ends " + (end.getFullYear() === new Date().getFullYear() ? shortDate : date).format(end));
    }
    if (stats.length) footer.append(node("p", stats.join(" · "), "muted"));
    const footerEnd = node("span", undefined, "market-card-count muted");
    if (count > 1) footerEnd.append(count + (count === event.market_count ? " markets" : " matches"));
    const arrow = node("span", "›", "market-card-arrow");
    arrow.setAttribute("aria-hidden", "true");
    footerEnd.append(arrow);
    footer.append(footerEnd);
    card.append(identity, options, footer);
    return card;
  }

  function renderResults() {
    const visible = [...entries.values()].slice(0, limit);
    for (const event of visible) {
      const previous = renderedCards.get(event.slug);
      if (previous?.event === event) continue;
      const card = eventCard(event);
      if (previous) previous.card.replaceWith(card);
      else grid.append(card);
      renderedCards.set(event.slug, {event, card});
    }
    const count = visible.length;
    status.textContent = count ? `${count} ${count === 1 ? "event" : "events"} shown` : "";
    byId("catalog-empty").hidden = Boolean(count || cursor);
    if (!count && cursor) status.textContent = "No matching markets found yet.";
    more.hidden = entries.size <= limit && !cursor;
    if (!more.hidden) pagination.hidden = false;
  }

  function observeMoreMarkets() {
    observeMarketScroll(!more.hidden && !pane.hidden && !request && !moreStatus.textContent && sparsePages < 3);
  }

  function appendMarkets() {
    if (request || more.hidden || pane.hidden) return;
    if (entries.size <= limit) {
      load(false);
    } else {
      limit += pageSize;
      renderResults();
      observeMoreMarkets();
    }
  }

  function merge(events) {
    for (const event of events) {
      const known = entries.get(event.slug);
      if (!known) {
        entries.set(event.slug, event);
        continue;
      }
      const markets = new Map(known.markets.map((market) => [market.slug, market]));
      for (const market of event.markets) markets.set(market.slug, market);
      entries.set(event.slug, {...known, ...event, markets: [...markets.values()]});
    }
  }

  function catalogParameters(current = state) {
    const params = parameters(current);
    params.delete("from");
    params.delete("through");
    if (current.ends === "custom") {
      if (current.from) params.set("after", midnight(current.from));
      if (current.through) params.set("before", midnight(current.through, true));
    }
    return params;
  }

  async function load(reset) {
    if (!reset && (request || !cursor)) return;
    observeMarketScroll(false);
    if (reset) {
      request?.abort();
      entries = new Map();
      renderedCards.clear();
      seenCursors.clear();
      cursor = null;
      limit = pageSize;
      sparsePages = 0;
      renderControls();
      byId("catalog-empty").hidden = pagination.hidden = true;
      more.hidden = true;
      moreLabel.textContent = "Load more";
      moreLoader.hidden = true;
      grid.replaceChildren(...Array.from({length: 6}, () => {
        const card = node("div", undefined, "market-event-card market-skeleton");
        card.setAttribute("aria-hidden", "true");
        card.append(node("span"), node("span"));
        return card;
      }));
    }
    const controller = new AbortController();
    request = controller;
    grid.setAttribute("aria-busy", "true");
    more.setAttribute("aria-disabled", "true");
    const loading = reset ? null : setTimeout(() => {
      if (request !== controller) return;
      moreLabel.textContent = "Loading";
      moreLoader.hidden = false;
    }, 120);
    moreStatus.textContent = "";
    error.hidden = true;
    if (reset) status.textContent = "Loading markets…";
    const params = catalogParameters();
    params.set("preview", "1");
    if (cursor) params.set("cursor", cursor);
    try {
      const response = await fetch("/api/markets?" + params, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)])
      });
      const result = await response.json();
      if (request !== controller) return;
      if (!response.ok) throw new Error(result.error || "Markets couldn’t load.");
      if (!Array.isArray(result.events)) throw new Error("Polymarket returned unreadable markets.");
      const previousSize = entries.size;
      merge(result.events);
      const following = result.next_cursor;
      cursor = typeof following === "string" && following && !seenCursors.has(following) ? following : null;
      if (cursor) seenCursors.add(cursor);
      sparsePages = entries.size > previousSize ? 0 : sparsePages + 1;
      if (reset) grid.replaceChildren();
      if (!reset) limit += pageSize;
      renderResults();
    } catch (failure) {
      if (request !== controller) return;
      const message = failure instanceof TypeError || failure.name === "TimeoutError"
        ? "Connection interrupted. Try again in a moment." : failure.message;
      if (reset) {
        grid.replaceChildren();
        status.textContent = "";
        error.querySelector("p").textContent = message;
        error.hidden = false;
      } else {
        moreStatus.textContent = message;
      }
    } finally {
      clearTimeout(loading);
      if (request === controller) {
        request = null;
        grid.setAttribute("aria-busy", "false");
        more.removeAttribute("aria-disabled");
        moreLoader.hidden = true;
        moreLabel.textContent = moreStatus.textContent ? "Try again" : "Load more";
        observeMoreMarkets();
      }
    }
  }

  searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const q = input.value.trim();
    if (q.length > 0 && q.length < 3) {
      input.setCustomValidity("Enter at least three characters.");
      input.reportValidity();
      return;
    }
    navigate({...state, q, sort: "auto", category: "trending"});
  });
  input.addEventListener("input", (event) => {
    input.setCustomValidity("");
    if (!input.value && state.q) navigate({...state, q: "", sort: "auto"});
    else if (!event.isComposing) queueSuggestions();
    else closeSuggestions();
  });
  input.addEventListener("compositionend", queueSuggestions);
  input.addEventListener("focus", queueSuggestions);
  searchForm.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "Escape" && (!suggestions.hidden || suggestionTimer)) {
      event.preventDefault();
      input.focus();
      closeSuggestions();
      return;
    }
    if (event.target !== input || suggestions.hidden) return;
    const selected = byId(input.getAttribute("aria-activedescendant"));
    if (event.key === "Enter" && selected) {
      event.preventDefault();
      selected.click();
    } else if (["ArrowDown", "ArrowUp"].includes(event.key) && suggestionList.childElementCount) {
      const next = event.key === "ArrowDown" ? selected?.nextElementSibling || suggestionList.firstElementChild
        : selected?.previousElementSibling || suggestionList.lastElementChild;
      event.preventDefault();
      selected?.setAttribute("aria-selected", "false");
      next.setAttribute("aria-selected", "true");
      input.setAttribute("aria-activedescendant", next.id);
      next.scrollIntoView({block: "nearest"});
    }
  });
  searchForm.addEventListener("focusout", (event) => {
    if (!searchForm.contains(event.relatedTarget)) closeSuggestions();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!searchForm.contains(event.target)) closeSuggestions();
  });
  sort.addEventListener("change", () => navigate({...state, sort: sort.value}));
  byId("catalog-filters").addEventListener("click", () => {
    setFilterForm(state);
    filtersDialog.showModal();
  });
  fields.ends.addEventListener("change", () => { byId("catalog-custom-dates").hidden = fields.ends.value !== "custom"; });
  byId("catalog-reset").addEventListener("click", () => setFilterForm({exclude: []}));
  byId("catalog-filter-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const next = {...state, exclude: exclusions.filter((checkbox) => checkbox.checked).map((checkbox) => checkbox.value)};
    for (const key of filterNames) next[key] = fields[key].value;
    if (next.ends === "custom" && (!next.from && !next.through || next.from && next.through && next.from > next.through)) {
      const message = byId("catalog-filter-error");
      message.textContent = "Choose a valid date range.";
      message.hidden = false;
      return;
    }
    if (next.exclude.includes(next.category)) next.category = "trending";
    filtersDialog.close();
    saveFilters(next);
    navigate(next);
  });
  more.addEventListener("click", appendMarkets);
  byId("catalog-retry").addEventListener("click", () => load(true));
  eventSearch.addEventListener("input", renderEventList);
  eventRetry.addEventListener("click", () => loadEventMarkets(selectedEvent, eventRequest.signal));
  eventDialog.addEventListener("close", () => {
    if (eventDialog.open) return;
    eventRequest?.abort();
    eventThumbnails.disconnect();
    const params = new URLSearchParams(location.search);
    if (!pane.hidden && params.get("event") === selectedEvent?.slug && !params.has("market")) updateLocation(state, true);
  });
  eventCanvas.addEventListener("pointermove", (event) => {
    if (event.pointerType !== "touch") inspectEventHistory(event);
  });
  eventCanvas.addEventListener("pointerdown", inspectEventHistory);
  eventCanvas.addEventListener("pointerleave", (event) => {
    if (event.pointerType !== "touch") clearEventCursor();
  });
  eventCanvas.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !eventCursor.hidden) {
      event.preventDefault();
      clearEventCursor();
    }
    if (!eventPlot || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const {start, end} = eventPlot;
    const step = (end - start) / 24;
    const time = (eventCursorTime ?? (start + end) / 2) + (event.key === "ArrowLeft" ? -step : step);
    showEventCursor(Math.max(start, Math.min(end, time)), true);
  });
  eventCanvas.addEventListener("blur", clearEventCursor);
  eventRangeControls.addEventListener("click", (event) => {
    const control = event.target.closest("button[data-days]");
    if (!control) return;
    eventRange = Number(control.dataset.days);
    for (const option of eventRangeControls.querySelectorAll("button")) {
      option.setAttribute("aria-pressed", String(option === control));
    }
    drawEventHistory();
  });
  DashboardWidgets.slidingSelection(eventRangeControls);
  new ResizeObserver(drawEventHistory).observe(eventCanvas);
  function restore() {
    closeSuggestions();
    if (location.hash.startsWith("#watchlist") || pane.hidden) return;
    restoreRequest?.abort();
    const params = new URLSearchParams(location.search);
    const selection = {
      event: params.get("event"), market: params.get("market"), overview: params.get("overview") === "1"
    };
    const slug = /^[a-z0-9][a-z0-9-]{0,250}$/;
    const detail = byId("position-dialog");
    if (detail?.open && detail.dataset.market !== selection.market) detail.close();
    if (eventDialog.open && (selectedEvent?.slug !== selection.event || selection.market && !selection.overview)) eventDialog.close();
    const next = readState();
    if (parameters(next).toString() !== catalogLocation) {
      state = next;
      updateLocation(state, true, slug.test(selection.event || "") ? selection : undefined);
      load(true);
    }
    if (slug.test(selection.event || "") && (selection.market ? slug.test(selection.market) && !detail?.open : !eventDialog.open)) {
      restoreSelection(selection);
    }
  }

  window.addEventListener("popstate", restore);
  window.addEventListener("pageshow", (event) => { if (event.persisted) restore(); });
  window.addEventListener("market-explore", () => {
    restore();
    observeMoreMarkets();
  });
  byId("catalog-personalized").hidden = !DashboardSettings.reviewEnabled;
  restore();
})();
