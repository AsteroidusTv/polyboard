"use strict";

const DashboardWatchlist = (() => {
  const byId = (id) => document.getElementById(id);
  const detailButtons = new Map();
  const bells = [...document.querySelectorAll("[data-watch-bell]")];
  const panes = byId("watchlist-pane");
  const views = document.querySelectorAll("[data-market-view]");
  const cents = new Intl.NumberFormat("en-US", {maximumFractionDigits: 3});
  const time = new Intl.DateTimeFormat("en-US", {dateStyle: "medium", timeStyle: "short"});
  const showPrice = (amount) => cents.format(Number(amount) * 100) + "¢";
  const icon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 8-3 8h18s-3-1-3-8M10 20a2 2 0 0 0 4 0"/></svg>`;
  let state = {watches: [], notices: [], push_key: null, push_enabled: false};
  let loaded = false;
  let loadError = "";
  let isUpdating = false;
  let pending = Promise.resolve();
  let readRequest = null;
  let notificationDialog;
  let alertDialog;
  let lastNotice;

  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function button(text, action, className = "secondary-button") {
    const node = el("button", text, className);
    node.type = "button";
    node.addEventListener("click", action);
    return node;
  }

  function dialog(id, label) {
    const node = el("dialog", undefined, "watch-dialog");
    node.id = id;
    node.setAttribute("aria-labelledby", id + "-title");
    node.innerHTML = `<header class="watch-dialog-head">
      <div><h2 id="${id}-title">${label}</h2><p class="muted watch-dialog-subtitle" hidden></p></div>
      <form method="dialog"><button class="text-button activity-dismiss" aria-label="Close ${label.toLowerCase()}" autofocus>×</button></form>
    </header><div class="watch-dialog-body"></div>`;
    document.querySelector("main").append(node);
    return node;
  }

  function showState(next) {
    state = next;
    loaded = true;
    loadError = "";
    render();
    openLinkedNotice();
    return next;
  }

  async function request(data, signal, query = "") {
    const options = data ? {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(data)} : {};
    const response = await fetch("/api/watchlist" + query, {...options, signal});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "The Watchlist couldn’t load.");
    return result;
  }

  function refresh() {
    if (readRequest || isUpdating) return;
    const controller = new AbortController();
    readRequest = controller;
    request(undefined, controller.signal).then(showState).catch((error) => {
      if (controller.signal.aborted) return;
      loadError = error.message;
      render();
    }).finally(() => {
      if (readRequest === controller) readRequest = null;
    });
  }

  function change(data, apply = showState) {
    const task = pending.then(async () => {
      isUpdating = true;
      readRequest?.abort();
      readRequest = null;
      try {
        return apply(await request(data));
      } finally {
        isUpdating = false;
      }
    });
    pending = task.catch(() => {});
    return task;
  }

  async function perform(control, action, error) {
    control.disabled = true;
    error.textContent = "";
    try {
      await action();
    } catch (failure) {
      error.textContent = failure.message;
    } finally {
      control.disabled = false;
    }
  }

  function followButton(control, addAlert, market) {
    const current = state.watches.find((item) => item.slug === market?.slug);
    control.hidden = addAlert.hidden = true;
    if (!market?.slug || (!current && ["closed", "paused"].includes(market.state)) || market.is_combo) return;
    control.textContent = current ? "Following" : "Follow";
    control.setAttribute("aria-pressed", String(Boolean(current)));
    control.setAttribute("aria-label", current ? "Unfollow market" : "Follow market");
    control.hidden = false;
    addAlert.hidden = current?.state !== "open" || market.state === "closed";
  }

  function mountActions(control, addAlert, error, market) {
    if (!detailButtons.has(control)) {
      control.addEventListener("click", () => {
        const selected = detailButtons.get(control).market;
        const followed = state.watches.some(({slug}) => slug === selected.slug);
        if (followed) {
          confirmUnfollow(selected);
        } else prepareFollow(selected);
      });
      addAlert.addEventListener("click", () => {
        const selected = detailButtons.get(control).market;
        const item = state.watches.find(({slug}) => slug === selected.slug);
        if (item) openAlert(item, selected.token_id);
      });
    }
    detailButtons.set(control, {addAlert, market});
    error.textContent = "";
    followButton(control, addAlert, market);
  }

  let unfollowDialog;
  function confirmUnfollow(market) {
    unfollowDialog ||= dialog("watch-unfollow", "Unfollow market?");
    const body = unfollowDialog.querySelector(".watch-dialog-body");
    const error = el("p", undefined, "negative");
    error.setAttribute("role", "alert");
    const cancel = button("Cancel", () => unfollowDialog.close());
    const confirm = button("Unfollow", () => perform(confirm, async () => {
      await change({action: "unfollow", slug: market.slug});
      unfollowDialog.close();
    }, error), "watch-danger");
    const actions = el("div", undefined, "watch-inline");
    actions.append(cancel, confirm);
    body.replaceChildren(el("p", "This removes the market and its alerts from your Watchlist.", "muted"), actions, error);
    unfollowDialog.showModal();
  }

  function openMarket(market, {token, target} = {}) {
    const outcomes = market.outcomes.map((side) => ({
      ...side, price: market.quotes[side.token_id] ? Number(market.quotes[side.token_id].current) : null
    }));
    const primary = outcomes.findIndex((side) => side.token_id === token);
    if (primary > 0) outcomes.reverse();
    const hash = "#watchlist/market/" + market.slug;
    const destination = (panes ? location.search : "") + hash;
    if (panes && view() === "watchlist") history.replaceState(history.state, "", "/markets" + destination);
    DashboardWidgets.openMarket({...market, outcomes, token_id: outcomes[0].token_id,
      compare: outcomes.some((side) => /^yes$/i.test(side.label)), alert_target: target && Number(target),
      catalog_query: destination,
      onClose() {
        if (panes && location.hash === hash) history.replaceState(history.state, "", "/markets" + location.search + "#watchlist");
      }});
  }

  function sparkline(quote) {
    const points = quote?.points || [];
    if (points.length < 2) return null;
    const latest = [quote.time, Number(quote.current)];
    const values = points.at(-1)[0] === latest[0] ? points : [...points, latest];
    const min = Math.min(...values.map((point) => point[1]));
    const max = Math.max(...values.map((point) => point[1]));
    const width = 102;
    const height = 27;
    const duration = latest[0] - values[0][0] || 1;
    const canvas = el("canvas", undefined, "watch-sparkline");
    canvas.width = width * 2;
    canvas.height = height * 2;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "Price trend since following, up to 24 hours");
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.scale(2, 2);
    ctx.beginPath();
    values.forEach(([at, price], index) => {
      const x = 2 + (at - values[0][0]) / duration * (width - 4);
      const y = max === min ? height / 2 : height - 3 - (price - min) / (max - min) * (height - 6);
      ctx[index ? "lineTo" : "moveTo"](x, y);
    });
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "#aabbff";
    ctx.stroke();
    return canvas;
  }

  function alertLabel(alert, side) {
    const direction = alert.direction === "above" ? "↑" : "↓";
    const move = alert.change ? direction + alert.change + "% from " + showPrice(alert.baseline) + " · " : direction + " ";
    return side.label + " " + move + showPrice(alert.target);
  }

  function card(market) {
    const node = el("article", undefined, "watch-card");
    const head = el("div", undefined, "watch-card-head");
    if (market.image?.startsWith("https://")) {
      const image = el("img");
      image.src = DashboardWidgets.marketImageSource(market.image);
      image.alt = "";
      image.loading = "lazy";
      image.addEventListener("error", () => image.remove(), {once: true});
      head.append(image);
    }
    const identity = el("div");
    const title = el("h3");
    title.append(button(market.title, () => openMarket(market), "text-button watch-title"));
    identity.append(title);
    if (market.event_title && market.event_title !== market.title) identity.append(el("p", market.event_title, "muted"));
    head.append(identity);
    const quotes = el("div", undefined, "watch-quotes");
    for (const side of market.outcomes) {
      const quote = market.quotes[side.token_id];
      const column = el("div", undefined, "watch-quote");
      const label = quote?.fresh === false && market.state === "open" ? side.label + " · stale" : side.label;
      column.append(el("span", label, "muted"), el("strong", quote ? showPrice(quote.current) : "—"));
      const chart = sparkline(quote);
      if (chart) column.append(chart);
      quotes.append(column);
    }
    const status = Math.max(...Object.values(market.quotes).map((quote) => quote.time));
    const fresh = Object.values(market.quotes).some((quote) => quote.fresh);
    const display = market.alerts.length ? "Alerts" : "No alerts yet";
    const alerts = el("div", undefined, "watch-rules");
    const checked = Number.isFinite(status) ? "Last quote " + time.format(status * 1000) : "Waiting for a price";
    const marketState = market.state === "closed" ? "Closed" : market.state === "paused" ? "Trading paused"
      : Number.isFinite(status) && !fresh ? "Price stale" : "";
    const stats = el("p", [marketState, checked].filter(Boolean).join(" · "), "muted watch-updated");
    const heading = el("div", undefined, "watch-inline watch-rules-head");
    const add = button("Add alert", () => openAlert(market));
    add.hidden = market.state !== "open";
    heading.append(el("strong", display), add);
    alerts.append(heading);
    const error = el("p", undefined, "negative");
    error.setAttribute("role", "alert");
    for (const rule of market.alerts) {
      const side = market.outcomes.find((item) => item.token_id === rule.token);
      if (!side) continue;
      const line = el("div", undefined, "watch-rule watch-inline");
      const group = el("div");
      const quote = market.quotes[rule.token];
      const label = rule.fired ? "Triggered" : market.state === "closed" ? "Market closed"
        : market.state === "paused" ? "Trading paused" : quote?.fresh ? "Watching" : "Waiting for a fresh price";
      group.append(el("strong", alertLabel(rule, side)), el("small", label, rule.fired ? "positive" : "muted"));
      const options = el("div", undefined, "watch-rule-actions");
      if (rule.fired && market.state === "open") {
        const rearm = button("Rearm", () => perform(rearm, () => change({action: "rearm", id: rule.id}), error), "text-button");
        options.append(rearm);
      }
      const remove = button("×", () => perform(remove, () => change({action: "remove-alert", id: rule.id}), error), "text-button watch-remove");
      remove.setAttribute("aria-label", "Remove alert " + alertLabel(rule, side));
      options.append(remove);
      line.append(group, options);
      alerts.append(line);
    }
    const footer = el("div", undefined, "watch-inline watch-card-footer");
    const actions = el("div", undefined, "watch-rule-actions");
    actions.append(button("Trade journal", () => openJournal(market), "text-button"),
      button("Unfollow", () => confirmUnfollow(market), "text-button"));
    footer.append(stats, actions);
    node.append(head, quotes, alerts, error, footer);
    return node;
  }

  function renderWatchlist() {
    if (!panes || panes.hidden) return;
    const cards = byId("watchlist-cards");
    const status = byId("watchlist-status");
    byId("watchlist-count").textContent = loaded && state.watches.length ?
      state.watches.length + (state.watches.length === 1 ? " market" : " markets") : "";
    status.replaceChildren();
    if (loadError) {
      status.append(el("p", loadError, "negative"), button("Try again", refresh));
    } else if (!loaded) {
      status.append(el("p", "Loading Watchlist…", "watch-loading"));
    } else if (!state.watches.length) {
      const empty = el("div", undefined, "watch-empty");
      empty.append(el("h3", "No followed markets"), el("p", "Open a market and select Follow to start watching its price.", "muted"),
        button("Explore markets", () => setView("explore")));
      status.append(empty);
    }
    // Keep keyboard focus stable during background updates.
    if (cards.contains(document.activeElement) && !isUpdating) return;
    cards.replaceChildren(...state.watches.map(card));
  }

  function journalKey({slug, token_id: token}) {
    if (/^[a-z0-9][a-z0-9-]{0,250}$/.test(slug || "")) return slug;
    return /^\d{1,78}$/.test(token || "") ? "token:" + token : "";
  }

  function openJournal(market, fromPosition = false) {
    const slug = journalKey(market);
    if (!slug) return;
    const journal = dialog("trade-journal", "Trade journal");
    const subtitle = journal.querySelector(".watch-dialog-subtitle");
    subtitle.textContent = market.title || "Polymarket position";
    subtitle.hidden = false;
    const body = journal.querySelector(".watch-dialog-body");
    const list = el("ol", undefined, "journal-entries");
    const status = el("p", "Loading notes…", "muted");
    status.setAttribute("role", "status");
    const form = el("form", undefined, "watch-alert-form");
    form.innerHTML = `<div><label for="journal-kind">Entry type</label>
        <select id="journal-kind">
          <option value="trade">Trade reason</option>
          <option value="follow">Follow reason</option>
          <option value="update">Update</option>
        </select></div>
      <div><label for="journal-note">Note</label>
        <textarea id="journal-note" rows="3" maxlength="1000" required></textarea></div>
      <p class="negative" role="alert"></p>
      <div class="watch-form-actions"><button type="submit">Save note</button></div>`;
    body.append(status, list, form);
    const type = form.querySelector("#journal-kind");
    const note = form.querySelector("#journal-note");
    const save = form.querySelector("[type=submit]");
    const error = form.querySelector("[role=alert]");
    const labels = {trade: "Trade reason", follow: "Follow reason", update: "Update"};
    const placeholders = {
      trade: "Why did you take this position? What would make you change your mind?",
      follow: "Why are you watching this market? What are you waiting to see?",
      update: "What changed? Does your original reasoning still hold?"
    };
    const setPlaceholder = () => { note.placeholder = placeholders[type.value]; };
    type.value = fromPosition ? "trade" : "update";
    type.addEventListener("change", setPlaceholder);
    setPlaceholder();
    const requestController = new AbortController();
    let revision = 0;
    let draft;
    function render({entries}) {
      status.textContent = entries.length ? "" : "No notes yet.";
      list.replaceChildren(...entries.map((entry) => {
        const row = el("li");
        const heading = el("div", undefined, "journal-entry-heading");
        const date = new Date(entry.created * 1000);
        const stamp = el("time", time.format(date), "muted");
        stamp.dateTime = date.toISOString();
        heading.append(el("strong", labels[entry.kind]), stamp);
        row.append(heading, el("p", entry.body));
        return row;
      }));
    }
    journal.addEventListener("close", () => {
      requestController.abort();
      journal.remove();
    }, {once: true});
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = note.value.trim();
      if (!text) {
        error.textContent = "Write a note before saving.";
        note.focus();
        return;
      }
      if (draft?.body !== text || draft.kind !== type.value) {
        draft = {action: "journal", slug, kind: type.value, body: text, note_id: crypto.randomUUID()};
      }
      const current = ++revision;
      perform(save, async () => {
        const saved = draft;
        const data = await change(saved, (result) => result);
        if (!journal.open || revision !== current) return;
        render(data);
        if (note.value.trim() === saved.body && type.value === saved.kind) {
          note.value = "";
          type.value = "update";
          setPlaceholder();
        }
        draft = undefined;
      }, error);
    });
    journal.showModal();
    request(undefined, AbortSignal.any([requestController.signal, AbortSignal.timeout(15000)]),
      "?" + new URLSearchParams({journal: slug})).then((data) => {
      if (!journal.open || revision) return;
      if (fromPosition && data.entries.some(({kind}) => kind === "trade") && !note.value) {
        type.value = "update";
        setPlaceholder();
      }
      render(data);
    }).catch(() => {
      if (journal.open && !revision) status.textContent = "Notes couldn’t load. Reopen the journal to try again.";
    });
  }

  function alertBody(market) {
    alertDialog ||= dialog("watch-alert", "Add price alert");
    const subtitle = alertDialog.querySelector(".watch-dialog-subtitle");
    subtitle.textContent = market.title;
    subtitle.hidden = false;
    return alertDialog.querySelector(".watch-dialog-body");
  }

  async function prepareFollow(market) {
    const body = alertBody(market);
    const status = el("p", "Loading alert settings…", "muted");
    status.setAttribute("role", "status");
    body.replaceChildren(status);
    if (!alertDialog.open) alertDialog.showModal();
    try {
      const preview = await request(undefined, AbortSignal.timeout(15000), "?" + new URLSearchParams({market: market.slug}));
      if (alertDialog.open && body.contains(status)) openAlert(preview, market.token_id, true);
    } catch (failure) {
      if (!alertDialog.open || !body.contains(status)) return;
      status.className = "negative";
      status.setAttribute("role", "alert");
      status.textContent = failure.name === "TimeoutError" ? "Alert settings couldn’t load. Try again." : failure.message;
      const retry = button("Try again", () => prepareFollow(market));
      const actions = el("div", undefined, "watch-inline watch-form-actions");
      actions.append(retry);
      body.append(actions);
    }
  }

  function openAlert(market, token, fromFollow = false) {
    const body = alertBody(market);
    body.innerHTML = `<form class="watch-alert-form">
      ${fromFollow ? `<div><label for="watch-note">Why follow this market? <span class="muted">(optional)</span></label>
        <textarea id="watch-note" rows="2" maxlength="1000" placeholder="Save your reasoning in the Trade journal"></textarea></div>` : ""}
      <p class="muted">Alerts trigger when a sampled midpoint crosses the threshold. Prices are checked about once a minute.</p>
      <div class="watch-alert-fields">
        <div><label for="watch-outcome">Outcome</label><select id="watch-outcome"></select></div>
        <div><label for="watch-condition">Condition</label><select id="watch-condition">
          <option value="price">Price threshold</option><option value="change">Change since following</option>
        </select></div>
        <div><label for="watch-direction">Direction</label><select id="watch-direction">
          <option value="above">Rises to</option><option value="below">Falls to</option>
        </select></div>
        <div><label for="watch-value" id="watch-value-label">Target price (¢)</label>
          <input id="watch-value" type="number" inputmode="decimal" min="0.001" step="0.001" required placeholder="60"></div>
      </div>
      <p class="watch-preview muted"></p><p class="negative" role="alert"></p>
      <div class="watch-inline watch-form-actions"><button type="button" class="secondary-button">${fromFollow ? "Follow without alert" : "Cancel"}</button><button type="submit">Create alert</button></div>
    </form>`;
    const form = body.querySelector("form");
    const outcome = byId("watch-outcome");
    const condition = byId("watch-condition");
    const direction = byId("watch-direction");
    const value = byId("watch-value");
    const valueLabel = byId("watch-value-label");
    const submit = form.querySelector("[type=submit]");
    const secondary = form.querySelector("[type=button]");
    const error = form.querySelector("[role=alert]");
    let saving = false;
    let draftNote;
    for (const side of market.outcomes) {
      const option = el("option", side.label);
      option.value = side.token_id;
      outcome.append(option);
    }
    if (market.outcomes.some((side) => side.token_id === token)) outcome.value = token;
    function preview(formChange) {
      const relative = condition.value === "change";
      const quote = market.quotes[outcome.value];
      if (formChange === "watch-condition") value.value = "";
      const numeric = Number(value.value);
      const target = relative ? Number(quote?.baseline) * (1 + (direction.value === "above" ? numeric : -numeric) / 100) : numeric / 100;
      valueLabel.textContent = relative ? "Change (%)" : "Target price (¢)";
      direction.options[0].text = relative ? "Gain" : "Rises to";
      direction.options[1].text = relative ? "Drop" : "Falls to";
      value.placeholder = relative ? "10" : "60";
      const baselineLabel = fromFollow ? "Current midpoint " : "Followed at ";
      const sentence = relative ? (quote?.baseline ? baselineLabel + showPrice(quote.baseline) + "." :
        "Waiting for a reference price.") : (quote ? "Current midpoint " + showPrice(quote.current) + "." : "Current midpoint unavailable.");
      const valid = Boolean(value.value) && target > 0 && target < 1;
      const hasCrossed = quote && valid && (direction.value === "above" ? Number(quote.current) >= target : Number(quote.current) <= target);
      form.querySelector(".watch-preview").textContent = sentence +
        (value.value && valid && relative ? (fromFollow ? " Estimated alert at " : " Alert at ") + showPrice(target) + "." : "") +
        (hasCrossed ? " It must cross this level again to trigger." : "");
      submit.disabled = saving || !valid;
    }
    async function save(alert) {
      if (saving) return;
      saving = submit.disabled = secondary.disabled = true;
      error.textContent = "";
      try {
        const text = fromFollow ? form.querySelector("#watch-note").value.trim() : "";
        if (text && draftNote?.body !== text) draftNote = {body: text, note_id: crypto.randomUUID()};
        await change(fromFollow ? {action: "follow", slug: market.slug, alert, note: text ? draftNote : undefined}
          : {action: "add-alert", slug: market.slug, ...alert});
        if (form.isConnected && alertDialog.open) alertDialog.close();
      } catch (failure) {
        error.textContent = failure.message;
      } finally {
        saving = secondary.disabled = false;
        preview();
      }
    }
    form.addEventListener("input", (event) => preview(event.target.id));
    secondary.addEventListener("click", () => {
      if (fromFollow) save();
      else alertDialog.close();
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      save({token: outcome.value, direction: direction.value, kind: condition.value, value: String(Number(value.value))});
    });
    preview();
    if (!alertDialog.open) alertDialog.showModal();
    (fromFollow ? value : outcome).focus({preventScroll: true});
  }

  function canPush() {
    return state.push_key && isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  }

  async function setPush() {
    if (!canPush()) throw new Error("Browser notifications aren’t available here.");
    if (!state.push_enabled && await Notification.requestPermission() !== "granted") {
      throw new Error("Allow notifications for this site in your browser settings.");
    }
    await navigator.serviceWorker.register("/watchlist-sw.js");
    const active = await navigator.serviceWorker.ready;
    let subscription = await active.pushManager.getSubscription();
    if (state.push_enabled) {
      await change({action: "disable-push"});
      await subscription?.unsubscribe();
      return;
    }
    if (!subscription) {
      const encoded = state.push_key.replace(/-/g, "+").replace(/_/g, "/");
      const key = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      subscription = await active.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: key});
    }
    await change({action: "enable-push", subscription: subscription.toJSON()});
  }

  const openNotice = (notice) => {
    const market = state.watches.find(({slug}) => slug === notice.slug);
    if (!market) return;
    if (!notice.seen) change({action: "read", id: notice.id}).catch(() => {});
    if (notificationDialog?.open) notificationDialog.close();
    openMarket(market, notice);
  };

  function renderNotifications() {
    if (!notificationDialog?.open) return;
    const body = notificationDialog.querySelector(".watch-dialog-body");
    const savedFocus = document.activeElement?.dataset.notice;
    const unread = state.notices.some((notice) => !notice.seen);
    const error = el("p", loadError, "negative");
    error.setAttribute("role", "alert");
    const options = el("div", undefined, "watch-inline watch-dialog-controls");
    const link = el("a", "Watchlist", "button-link secondary-button");
    link.href = "/markets#watchlist";
    link.addEventListener("click", () => notificationDialog.close());
    options.append(link);
    if (canPush() && (state.watches.length || state.push_enabled)) {
      const push = button(state.push_enabled ? "Disable browser alerts" : "Enable browser alerts",
        () => perform(push, setPush, error));
      options.append(push);
    }
    if (unread) {
      const markRead = button("Mark all read", () => perform(markRead, () => change({action: "read"}), error), "text-button");
      options.append(markRead);
    }
    const list = el("div", undefined, "watch-notices");
    if (!loaded) list.append(el("p", loadError ? "" : "Loading notifications…", "muted"));
    else if (!state.notices.length) list.append(el("p", "Price alerts will appear here when triggered.", "muted"));
    for (const notice of state.notices) {
      const row = button(undefined, () => openNotice(notice), "watch-notice");
      row.dataset.notice = notice.id;
      row.classList.toggle("is-unread", !notice.seen);
      const copy = el("span");
      copy.append(el("strong", notice.outcome + " hit " + showPrice(notice.price)),
        el("span", notice.title, "muted"));
      row.append(copy, el("time", time.format(notice.created * 1000), "muted"));
      list.append(row);
    }
    body.replaceChildren(options, error, list);
    if (savedFocus) list.querySelector(`[data-notice="${savedFocus}"]`)?.focus({preventScroll: true});
  }

  function render() {
    const unread = state.notices.filter((notice) => !notice.seen).length;
    for (const bell of bells) {
      const count = bell.querySelector(".watch-unread");
      count.textContent = unread > 99 ? "99+" : String(unread);
      count.hidden = !unread;
      bell.setAttribute("aria-label", unread ? "Notifications (" + unread + " unread)" : "Notifications");
    }
    for (const [control, item] of detailButtons) followButton(control, item.addAlert, item.market);
    renderWatchlist();
    renderNotifications();
  }

  function view() {
    return /^#watchlist(?:\/alerts\/\d+|\/market\/[a-z0-9-]+)?$/.test(location.hash) ? "watchlist" : "explore";
  }

  function setView(next) {
    const hash = next === "watchlist" ? "#watchlist" : "";
    if (location.hash !== hash) history.pushState(history.state, "", "/markets" + location.search + hash);
    route();
  }

  function route() {
    if (!panes) return;
    const selected = view();
    const catalog = byId("catalog-pane");
    const wasHidden = catalog.hidden;
    catalog.hidden = selected !== "explore";
    panes.hidden = selected !== "watchlist";
    for (const link of views) {
      if (link.dataset.marketView === selected) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    if (catalog.hidden) renderWatchlist();
    else if (wasHidden) window.dispatchEvent(new Event("market-explore"));
    openLinkedNotice();
  }

  function openLinkedNotice() {
    if (!loaded || !panes) return;
    const slug = location.hash.match(/^#watchlist\/market\/([a-z0-9-]+)$/)?.[1];
    if (slug) {
      const market = state.watches.find((item) => item.slug === slug);
      const open = document.querySelector("#position-dialog[open]");
      if (market && open?.dataset.market !== slug) openMarket(market);
      if (!market) history.replaceState(history.state, "", "/markets" + location.search + "#watchlist");
      return;
    }
    const id = location.hash.match(/^#watchlist\/alerts\/(\d+)$/)?.[1];
    if (!id || id === lastNotice) return;
    lastNotice = id;
    const notice = state.notices.find((item) => String(item.id) === id);
    if (notice) openNotice(notice);
    else byId("watchlist-status").textContent = "This notification is no longer available in this browser.";
    history.replaceState(history.state, "", "/markets" + location.search + "#watchlist");
  }

  for (const bell of bells) {
    bell.innerHTML = icon + '<span class="watch-unread" hidden></span>';
    bell.setAttribute("aria-controls", "watch-notifications");
    bell.addEventListener("click", () => {
      notificationDialog ||= dialog("watch-notifications", "Notifications");
      notificationDialog.showModal();
      renderNotifications();
      refresh();
    });
  }
  for (const link of views) link.addEventListener("click", (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    setView(link.dataset.marketView);
  });
  window.addEventListener("popstate", route);
  window.addEventListener("hashchange", route);
  window.addEventListener("pageshow", (event) => { if (event.persisted) { route(); refresh(); } });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  route();
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 30000);

  return {mountActions, journalKey, openJournal};
})();
