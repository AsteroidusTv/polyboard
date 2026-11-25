import {
  addressPattern, authenticate, balanceFor, bookFor, cancelOrder, connectWallet, decimal, fixed, funderFor, marketFor, marketIntent,
  openOrders, orderIdPattern, orderIntent, orderPreview, OrderSide, placeOrder, recheckOrder, TicketError, verifyEligibility, WalletError
} from "./client.js";

const slugPattern = /^[a-z0-9][a-z0-9-]{0,250}$/;
const number = new Intl.NumberFormat("en-US", {maximumFractionDigits: 6});
const quoteNumber = new Intl.NumberFormat("en-US", {maximumFractionDigits: 4});
const cashFormat = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", maximumFractionDigits: 2
});
const cashText = (units) => units > 0n && units < 5000n ? "<$0.01" : cashFormat.format(Number(units) / 1000000);
const centFormat = new Intl.NumberFormat("en-US", {maximumFractionDigits: 2});
const amount = (units) => number.format(Number(units) / 1000000);
const discovered = new Set();
const walletEvents = new EventTarget();
const uncertainOrders = new Set();
let connected;
let active;

window.addEventListener("eip6963:announceProvider", ({detail}) => {
  if (detail?.info?.rdns === "io.metamask" && typeof detail?.provider?.request === "function") {
    discovered.add(detail.provider);
  }
});
window.dispatchEvent(new Event("eip6963:requestProvider"));

function metaMask() {
  const injected = window.ethereum;
  const providers = discovered.size ? [...discovered] :
    [...new Set((injected?.providers || [injected]).filter((provider) => provider?.isMetaMask))];
  if (providers.length !== 1) throw new TicketError(providers.length
    ? "More than one MetaMask provider was detected. Choose one in your browser extensions."
    : "Open Polyboard in a browser with MetaMask installed.");
  return providers[0];
}

const walletCookie = "polyboard_trading_wallet";

function savedFunder(address) {
  try {
    const entry = document.cookie.split("; ").find((cookie) => cookie.startsWith(walletCookie + "="));
    const [signer, funder] = entry?.slice(walletCookie.length + 1).split(":") || [];
    return signer === address && addressPattern.test(funder || "") ? funder : "";
  } catch {
    return "";
  }
}

function rememberFunder({address, wallet}) {
  const secure = location.protocol === "https:" ? "; Secure" : "";
  try {
    document.cookie = `${walletCookie}=${address}:${wallet}; Path=/; Max-Age=31536000; SameSite=Strict${secure}`;
  } catch {
    // Cookies are optional for trading.
  }
}

function disconnect() {
  if (!connected) return;
  const {provider, onChange} = connected;
  for (const event of ["accountsChanged", "chainChanged", "disconnect"]) provider.removeListener?.(event, onChange);
  connected = undefined;
  walletEvents.dispatchEvent(new Event("change"));
}

function rememberConnection(provider, address) {
  disconnect();
  const onChange = () => disconnect();
  connected = {provider, address, onChange, session: null};
  for (const event of ["accountsChanged", "chainChanged", "disconnect"]) provider.on?.(event, onChange);
  walletEvents.dispatchEvent(new Event("change"));
  return connected;
}

function element(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}

function failureText(error, fallback) {
  if (error instanceof TicketError) return error.message;
  if (error?.code === 4001 || error?.name === "CancelledSigningError") return "Request canceled in MetaMask.";
  return fallback;
}

function walletIssue(failure) {
  if (failure instanceof WalletError) return failure;
  if (failure.status === 401) return new WalletError("The trading session expired. Reconnect MetaMask.", true);
  if (failure.name === "RequestRejectedError" && failure.status === 400 &&
      /allowance is not enough|not enough balance|insufficient (?:balance|allowance)/i.test(failure.message)) {
    return new WalletError("Polymarket rejected the order because of balance or approvals.");
  }
  return null;
}

function bestPrice(levels, buy) {
  if (!levels.length) return null;
  return (buy ? Math.min : Math.max)(...levels.map((level) => Number(level.price)));
}

const cents = (price) => price == null ? "—" : centFormat.format(price * 100) + "¢";
const displayBound = (units) => cents(Number(units) / 1000000);

export function mountWalletSettings(root, profileWallet) {
  root.innerHTML = `
    <button type="button" class="secondary-button" data-connect>Connect MetaMask</button>
    <div data-account hidden>
      <p class="muted trading-signer"></p>
      <div data-wallet-setup>
        <label for="settings-trading-funder">Polymarket trading wallet</label>
        <div class="order-inline">
          <input id="settings-trading-funder" type="text" placeholder="0x…" spellcheck="false" autocomplete="off">
          <button type="button" class="secondary-button" data-enable>Enable trading</button>
        </div>
        <p class="muted">Use the public wallet address shown in your Polymarket profile.</p>
      </div>
      <p data-trading-balance class="muted"></p>
      <button type="button" class="text-button" data-disconnect>Disconnect</button>
    </div>
    <p data-wallet-status class="muted" role="status"></p>
    <p data-wallet-error class="negative" role="alert"></p>
    <p class="muted"><a href="https://polymarket.com/" target="_blank" rel="noopener noreferrer">Manage funds and approvals on Polymarket ↗</a></p>`;
  const find = (selector) => root.querySelector(selector);
  const connect = find("[data-connect]");
  const enable = find("[data-enable]");
  const funder = find("#settings-trading-funder");
  const status = find("[data-wallet-status]");
  const error = find("[data-wallet-error]");
  const balance = find("[data-trading-balance]");

  function suggest(address) {
    return savedFunder(address) || (addressPattern.test(profileWallet()) ? profileWallet() : address);
  }

  function render() {
    const wallet = connected?.session;
    connect.hidden = Boolean(connected);
    find("[data-account]").hidden = !connected;
    find("[data-wallet-setup]").hidden = Boolean(wallet);
    const signer = find(".trading-signer");
    signer.textContent = wallet ? "Trading wallet " + wallet.wallet : connected ? "MetaMask " + connected.address : "";
    if (!wallet && connected && !funder.value) funder.value = suggest(connected.address);
    if (!wallet) balance.textContent = "";
  }

  function refresh() {
    render();
    const wallet = connected?.session;
    if (!wallet) return;
    balanceFor(wallet, OrderSide.BUY).then((account) => {
      if (wallet === connected?.session) balance.textContent = amount(account.balance) + " pUSD in trading wallet";
    }).catch(() => {
      if (wallet === connected?.session) balance.textContent = "Trading balance unavailable.";
    });
  }

  walletEvents.addEventListener("change", () => {
    if (!connected) {
      funder.value = "";
      status.textContent = "Wallet disconnected.";
    }
    refresh();
  });
  connect.addEventListener("click", async () => {
    error.textContent = "";
    status.textContent = "Connecting MetaMask…";
    connect.disabled = enable.disabled = true;
    try {
      const provider = metaMask();
      const address = await connectWallet(provider);
      const connection = rememberConnection(provider, address);
      render();
      const remembered = savedFunder(address);
      const initial = funder.value;
      const suggested = remembered || await funderFor(address);
      if (connected !== connection) return;
      if (funder.value === initial) funder.value = suggested || suggest(address);
      status.textContent = "Confirm your trading wallet, then enable trading.";
      if (root.closest("dialog").open && document.activeElement === connect) funder.focus();
    } catch (failure) {
      status.textContent = "";
      error.textContent = failureText(failure, "MetaMask could not connect. Check your account and Polygon network.");
    } finally {
      connect.disabled = enable.disabled = false;
      if (connected && root.closest("dialog").open && document.activeElement === document.body) funder.focus();
    }
  });
  enable.addEventListener("click", async () => {
    const connection = connected;
    if (!connection || enable.disabled || connect.disabled) return;
    enable.disabled = funder.readOnly = true;
    error.textContent = "";
    status.textContent = "Confirm the trading sign-in in MetaMask.";
    try {
      const wallet = await authenticate(connection.provider, connection.address, funder.value);
      if (connection !== connected) return;
      connection.session = wallet;
      rememberFunder(wallet);
      status.textContent = "Trading enabled for this tab.";
      walletEvents.dispatchEvent(new Event("change"));
    } catch (failure) {
      if (connection !== connected) return;
      if (failure instanceof WalletError && failure.reconnect) disconnect();
      status.textContent = "";
      error.textContent = failureText(failure, "Polymarket sign-in failed. Verify the profile wallet and try again.");
    } finally {
      enable.disabled = funder.readOnly = false;
    }
  });
  find("[data-disconnect]").addEventListener("click", () => {
    error.textContent = "";
    disconnect();
    if (root.closest("dialog").open) connect.focus();
  });
  render();
  return refresh;
}

const payoffMarkup = `
  <div class="order-payoff">
    <div><strong data-payoff-label>To win</strong><p data-payoff-condition class="muted"></p></div>
    <output data-payoff-value aria-label="Estimated outcome">—</output>
  </div>
  <dl class="order-statistics">
    <div><dt>Avg. price</dt><dd data-avg-price>—</dd></div>
    <div><dt>Estimated shares</dt><dd data-shares>—</dd></div>
    <div data-cost-stat><dt>Cost</dt><dd data-cost>—</dd></div>
    <div data-profit-stat><dt>Profit if it wins</dt><dd data-profit>—</dd></div>
    <div data-fee-stat hidden><dt>Est. fees</dt><dd data-fee>—</dd></div>
  </dl>`;

export function open(position, {sell = false, dock, parent, onClose} = {}) {
  if (active || !slugPattern.test(position.slug || "")) return;
  const journalMarket = {slug: position.slug, title: position.title};
  const docked = Boolean(dock && parent && matchMedia("(min-width: 920px)").matches);
  const dialog = element(docked ? "section" : "dialog", undefined, "watch-dialog order-ticket");
  active = dialog;
  const isOpen = () => active === dialog && (docked ? parent.open : dialog.open);
  dialog.setAttribute("aria-labelledby", "order-ticket-heading");
  dialog.innerHTML = `
    <header class="watch-dialog-head">
      <div><h2 id="order-ticket-heading">Trade on Polymarket</h2><p class="muted order-ticket-market"${docked ? " hidden" : ""}></p></div>
      <button type="button" data-close class="text-button activity-dismiss" aria-label="Close order ticket" autofocus>×</button>
    </header>
    <div class="watch-dialog-body">
      <p data-status role="status" class="muted">Loading market…</p>
      <p data-error role="alert" class="negative"></p>
      <button type="button" data-acknowledge class="secondary-button" hidden>I checked my Polymarket orders</button>
      <form class="order-form" hidden>
        <fieldset>
          <div class="order-topline">
            <div class="order-segment" role="group" aria-label="Trade side">
              <button type="button" data-side="BUY" aria-pressed="true">Buy</button>
              <button type="button" data-side="SELL" aria-pressed="false">Sell</button>
            </div>
            <div class="order-segment" role="group" aria-label="Order type">
              <button type="button" data-type="market" aria-pressed="true">Market</button>
              <button type="button" data-type="limit" aria-pressed="false">Limit</button>
            </div>
          </div>
          <div class="order-outcomes" role="group" aria-label="Outcome"></div>
          <div class="order-fields">
            <div data-price-field hidden><label for="order-price">Limit price (¢)</label>
              <input id="order-price" type="text" inputmode="decimal" autocomplete="off" placeholder="52"></div>
            <div><label for="order-size" data-size-label>Amount (pUSD)</label>
              <input id="order-size" type="text" inputmode="decimal" required autocomplete="off" placeholder="0.00"></div>
          </div>
          <div data-presets class="order-presets" aria-label="Quick amounts" role="group"></div>
          <div class="order-copy">
            <p data-quote class="muted" role="status"></p>
          </div>
          <div data-draft-payoff class="order-estimate">${payoffMarkup}</div>
          <button type="submit" class="order-review-button">Review buy</button>
        </fieldset>
      </form>
      <section data-review class="order-review" aria-label="Review order" hidden>
        <strong data-review-line></strong>
        <div data-review-payoff class="order-estimate">${payoffMarkup}</div>
        <p data-review-details class="muted"></p>
        <div class="order-inline">
          <button type="button" data-edit class="secondary-button">Edit</button>
          <button type="button" data-submit>Sign &amp; submit</button>
        </div>
      </section>
      <div data-receipt class="order-review" aria-live="polite" hidden>
        <strong data-receipt-line></strong>
        <button type="button" data-note class="secondary-button">Add trade note</button>
      </div>
      <section data-orders class="order-open" aria-label="Open orders" hidden>
        <div class="order-inline order-open-heading">
          <h3>Open orders from this signer</h3>
          <button type="button" data-refresh class="text-button">Refresh orders</button>
        </div>
        <p data-orders-status class="muted" role="status"></p>
        <ul></ul>
      </section>
    </div>`;
  const $ = (selector) => dialog.querySelector(selector);
  const close = $("[data-close]");
  const form = $(".order-form");
  const fields = $("fieldset");
  const outcomes = $(".order-outcomes");
  const priceField = $("[data-price-field]");
  const sizeLabel = $("[data-size-label]");
  const presets = $("[data-presets]");
  const draftPayoff = $("[data-draft-payoff]");
  const reviewButton = form.querySelector("[type=submit]");
  const price = $("#order-price");
  const size = $("#order-size");
  const review = $("[data-review]");
  const submit = $("[data-submit]");
  const error = $("[data-error]");
  const status = $("[data-status]");
  const quote = $("[data-quote]");
  const orders = $("[data-orders]");
  const ordersList = orders.querySelector("ul");
  const ordersStatus = $("[data-orders-status]");
  const refresh = $("[data-refresh]");
  const receipt = $("[data-receipt]");
  const acknowledge = $("[data-acknowledge]");
  $(".order-ticket-market").textContent = position.title || position.slug;

  let market;
  let book;
  let cashOrShares;
  let side = sell ? OrderSide.SELL : OrderSide.BUY;
  let type = "market";
  let outcomeIndex = 0;
  let session = connected?.session;
  let intent;
  let submitting = false;
  let quoteRequest = 0;
  let orderRequest = 0;

  const orderKey = (wallet) => wallet && market && wallet.wallet + ":" + market.conditionId;
  const uncertain = () => uncertainOrders.has(orderKey(session));
  const unknownOrderMessage = "Order status is unknown. Check your orders and activity on Polymarket before submitting again.";

  const isBuy = () => side === OrderSide.BUY;
  const budgetMode = () => type === "market" && isBuy();

  function openWalletSettings(message) {
    DashboardSettings.open("trading", message);
  }

  function renderWallet() {
    orders.hidden = !session || !market;
    form.hidden = !market || Boolean(intent);
    acknowledge.hidden = !uncertain();
    fields.disabled = Boolean(intent) || submitting || uncertain();
    form.noValidate = !session;
    updateEstimate();
    if (uncertain()) error.textContent = unknownOrderMessage;
  }

  acknowledge.addEventListener("click", () => {
    uncertainOrders.delete(orderKey(session));
    error.textContent = "";
    renderWallet();
    size.focus();
  });

  function resetReview() {
    intent = undefined;
    review.hidden = true;
    renderWallet();
  }

  function draftOrder() {
    const selected = market.outcomes[outcomeIndex];
    if (type === "market") return marketIntent(market, book, selected, side, size.value.trim());
    return orderIntent(market, book, selected, side, decimal(fixed(price.value.trim(), 2) / 100n), size.value.trim());
  }

  function renderPayoff(region, draft) {
    const buy = isBuy();
    const marketOrder = type === "market";
    const preview = draft && orderPreview(draft);
    const set = (selector, value) => { region.querySelector(selector).textContent = value; };
    const label = market?.outcomes[outcomeIndex]?.label;
    set("[data-payoff-label]", buy ? "To win" : "You receive");
    set("[data-payoff-condition]", buy ?
      (label ? "If " + label + " wins" : "If your outcome wins") + (marketOrder ? " · estimated fill" : " · full fill at limit") :
      (marketOrder ? "Estimated proceeds" : "Full fill at limit") + (preview?.fee == null ? " · before fees" : ""));
    set("[data-payoff-value]", preview ? cashText(preview.payoff) : "—");
    set("[data-avg-price]", preview ? displayBound(preview.average) : "—");
    set("[data-shares]", preview ? quoteNumber.format(Number(preview.shares) / 1000000) : "—");
    region.querySelector("[data-shares]").previousElementSibling.textContent = marketOrder ? "Est. shares" : "Shares";
    region.querySelector("[data-cost-stat]").hidden = region.querySelector("[data-profit-stat]").hidden = !buy;
    region.querySelector("[data-fee-stat]").hidden = preview?.fee == null || preview.fee === 0n;
    set("[data-cost]", preview ? cashText(preview.cash) : "—");
    set("[data-profit]", preview ? cashText(preview.profitIfWin ?? 0n) : "—");
    set("[data-fee]", preview?.fee != null ? cashText(preview.fee) : "—");
    region.querySelector("[data-cost]").previousElementSibling.textContent = preview && preview.fee == null ? "Cost before fees" : "Est. cost";
    region.querySelector("[data-profit]").previousElementSibling.textContent = preview && preview.fee == null ?
      "Profit if it wins, before fees" : "Est. profit if it wins";
    if (draft?.partiallyQuoted) region.querySelector("[data-payoff-condition]").append(" · partial fill");
  }

  function updateEstimate() {
    reviewButton.textContent = isBuy() ? "Review buy" : "Review sell";
    const hasInput = Boolean(book && size.value.trim() && (type === "market" || price.value.trim()));
    reviewButton.disabled = Boolean(session) && !hasInput;
    let draft;
    if (hasInput) {
      try { draft = draftOrder(); }
      catch { /* Show actionable validation when the user requests a review. */ }
    }
    renderPayoff(draftPayoff, draft);
  }

  function configureDraft() {
    for (const button of form.querySelectorAll("[data-side]")) button.setAttribute("aria-pressed", button.dataset.side === side);
    for (const button of form.querySelectorAll("[data-type]")) button.setAttribute("aria-pressed", button.dataset.type === type);
    for (const [index, button] of [...outcomes.children].entries()) {
      button.setAttribute("aria-pressed", index === outcomeIndex);
      button.querySelector("strong").textContent = "—";
    }
    price.required = type === "limit";
    priceField.hidden = !price.required;
    sizeLabel.textContent = budgetMode() ? "Amount (pUSD)" : "Shares";
    presets.replaceChildren();
    if (budgetMode() || !isBuy()) {
      const labels = budgetMode() ? ["+$1", "+$5", "+$10", "+$25"] : ["25%", "50%", "Max"];
      for (const [index, label] of labels.entries()) {
        const button = element("button", label, "secondary-button");
        button.type = "button";
        button.disabled = !isBuy() && cashOrShares == null;
        button.addEventListener("click", () => {
          if (budgetMode()) {
            let current = 0n;
            try { if (size.value.trim()) current = fixed(size.value.trim(), 2); }
            catch { size.focus(); return; }
            size.value = decimal(current + fixed(label.slice(2), 2));
          } else {
            size.value = decimal(cashOrShares * [25n, 50n, 100n][index] / 1000000n * 10000n);
          }
          updateEstimate();
        });
        presets.append(button);
      }
    }
    updateEstimate();
  }

  async function loadQuote() {
    if (!market) return;
    const request = ++quoteRequest;
    const wallet = session;
    const chosen = outcomeIndex;
    const action = side;
    const buy = isBuy();
    const selected = market.outcomes[chosen];
    book = null;
    cashOrShares = null;
    quote.textContent = "Loading order book…";
    configureDraft();
    if (wallet && !buy) balanceFor(wallet, action, selected).then((account) => {
      if (request !== quoteRequest) return;
      cashOrShares = account.balance;
      for (const button of presets.children) button.disabled = cashOrShares < 10000n;
    }).catch(() => { /* Sell presets stay disabled when balance is unavailable. */ });
    await Promise.all(market.outcomes.map(async (item, index) => {
      try {
        const current = await bookFor(market, item);
        if (request !== quoteRequest) return;
        const best = bestPrice(buy ? current.asks : current.bids, buy);
        outcomes.children[index].querySelector("strong").textContent = cents(best);
        if (index !== chosen) return;
        book = current;
        quote.textContent = "Bid " + cents(bestPrice(book.bids, false)) + " · Ask " + cents(bestPrice(book.asks, true)) +
          (type === "limit" ? " · Min. " + book.minOrderSize + " shares" : "");
        if (type === "limit" && !price.value && best != null) price.value = number.format(best * 100);
        updateEstimate();
      } catch (failure) {
        if (request === quoteRequest && index === chosen) {
          quote.textContent = failureText(failure, "Order book unavailable. Select the outcome to retry.");
        }
      }
    }));
  }

  async function loadOrders() {
    const wallet = session;
    if (!wallet || !market) return;
    const request = ++orderRequest;
    ordersStatus.textContent = "Loading open orders…";
    ordersList.replaceChildren();
    refresh.disabled = true;
    try {
      const rows = await openOrders(wallet, market);
      if (request !== orderRequest || wallet !== session) return;
      ordersStatus.textContent = rows.length ? "" : "No open orders.";
      for (const order of rows) {
        const row = element("li");
        const summary = element("div", [order.side, order.outcome, order.originalSize + " shares @ " + order.price].join(" · "));
        summary.append(element("small", order.sizeMatched + " matched", "muted"));
        const cancel = element("button", "Cancel", "text-button");
        cancel.type = "button";
        cancel.disabled = !orderIdPattern.test(order.id);
        cancel.addEventListener("click", async () => {
          if (cancel.textContent === "Cancel") {
            for (const button of ordersList.querySelectorAll("button")) button.textContent = "Cancel";
            cancel.textContent = "Confirm cancel";
            cancel.focus();
            return;
          }
          cancel.disabled = true;
          error.textContent = "";
          try {
            if (wallet !== session) throw new TicketError("Reconnect your trading wallet.");
            await cancelOrder(wallet, order.id);
            await loadOrders();
          } catch (failure) {
            const issue = walletIssue(failure);
            if (issue) {
              if (issue.reconnect && wallet === connected?.session) disconnect();
              openWalletSettings(issue.message);
            } else {
              error.textContent = failureText(failure, "Cancellation could not be confirmed. Refresh orders or check Polymarket.");
            }
            cancel.disabled = false;
            cancel.textContent = "Cancel";
          }
        });
        row.append(summary, cancel);
        ordersList.append(row);
      }
    } catch (failure) {
      if (request === orderRequest) ordersStatus.textContent = failureText(failure, "Open orders couldn’t load. Try refreshing.");
    } finally {
      if (request === orderRequest) refresh.disabled = false;
    }
  }

  function walletChanged() {
    session = connected?.session;
    ordersList.replaceChildren();
    ordersStatus.textContent = "";
    error.textContent = "";
    resetReview();
    loadQuote();
    if (!submitting) status.textContent = "";
    loadOrders();
  }

  walletEvents.addEventListener("change", walletChanged);
  function cleanup() {
    walletEvents.removeEventListener("change", walletChanged);
    active = undefined;
    dialog.remove();
    if (docked) dock.hidden = true;
    onClose?.();
  }
  function closeTicket() {
    if (submitting) return false;
    if (docked) cleanup();
    else dialog.close();
    return true;
  }
  close.addEventListener("click", closeTicket);
  if (!docked) {
    dialog.addEventListener("cancel", (event) => { if (submitting) event.preventDefault(); });
    dialog.addEventListener("close", cleanup, {once: true});
  }
  refresh.addEventListener("click", () => loadOrders());
  function changeDraft() {
    price.value = "";
    error.textContent = "";
    resetReview();
    loadQuote();
  }

  for (const button of form.querySelectorAll("[data-side]")) button.addEventListener("click", () => {
    if (side !== button.dataset.side) size.value = "";
    side = button.dataset.side;
    changeDraft();
  });
  for (const button of form.querySelectorAll("[data-type]")) button.addEventListener("click", () => {
    if (type !== button.dataset.type && isBuy()) size.value = "";
    type = button.dataset.type;
    changeDraft();
  });
  form.addEventListener("input", updateEstimate);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (uncertain() || submitting) return;
    if (!session) {
      openWalletSettings("Connect MetaMask and enable trading to continue.");
      return;
    }
    if (!book) return;
    error.textContent = "";
    try {
      const selected = market.outcomes[outcomeIndex];
      intent = draftOrder();
      const label = isBuy() ? "Buy " : "Sell ";
      $("[data-review-line]").textContent = intent.type === "market"
        ? label + (isBuy() ? selected.label + " · " + intent.input + " pUSD budget" : intent.input + " " + selected.label + " shares")
        : label + intent.size + " " + selected.label + " shares at " + displayBound(fixed(intent.price, 4));
      renderPayoff($("[data-review-payoff]"), intent);
      $("[data-review-details]").textContent = intent.type === "market" ?
        (isBuy() ? "Max. " : "Min. ") + displayBound(intent.bound) +
          " per share · unfilled amount cancels. " + (isBuy() ? "Fee reserve is estimated." : "") :
        "Good till canceled. Unfilled shares can stay open. Fees may apply to fills.";
      review.hidden = false;
      renderWallet();
      submit.focus();
    } catch (failure) {
      error.textContent = failureText(failure, "This order could not be reviewed.");
    }
  });
  $("[data-edit]").addEventListener("click", () => {
    resetReview();
    loadQuote();
    size.focus();
  });
  submit.addEventListener("click", async () => {
    if (!session || !intent || uncertain() || submitting) return;
    const approved = intent;
    const wallet = session;
    const selected = market.outcomes[outcomeIndex];
    submitting = true;
    close.disabled = submit.disabled = $("[data-edit]").disabled = true;
    receipt.hidden = true;
    let dispatched = false;
    error.textContent = "";
    status.textContent = "Checking order…";
    try {
      await verifyEligibility();
      const latest = await marketFor(position.slug);
      const current = latest.outcomes.find(({assetId}) => assetId === selected.assetId);
      if (latest.conditionId !== market.conditionId || current?.label !== selected.label) {
        throw new TicketError("Market details changed. Reopen the ticket before submitting.");
      }
      recheckOrder(latest, await bookFor(latest, current), current, approved);
      const funds = await balanceFor(wallet, approved.side, current);
      const needed = approved.side === OrderSide.BUY ? (approved.budget ?? approved.notional) : approved.quantity;
      if (funds.balance < needed) throw new WalletError(approved.side === OrderSide.BUY
        ? "Insufficient pUSD. Add funds on Polymarket or reduce the order." : "You don’t have enough shares. Check the wallet or reduce the order.");
      const allowance = Object.entries(funds.allowances).find(([address]) => address.toLowerCase() === approved.exchange)?.[1];
      if (allowance !== undefined && allowance < needed) {
        throw new WalletError("Trading allowance is insufficient. Update your approvals on Polymarket before submitting.");
      }
      if (wallet !== session) throw new WalletError("The trading wallet changed. Reconnect before submitting.", true);
      status.textContent = "Review and sign the order in MetaMask.";
      const response = await placeOrder(wallet, approved, () => {
        if (wallet !== session) throw new WalletError("The trading wallet changed. Reconnect before submitting.", true);
        if (!isOpen()) throw new TicketError("The trading context changed. Review the order again.");
        dispatched = true;
        status.textContent = "Waiting for Polymarket to confirm the order…";
      });
      if (!response.ok) {
        dispatched = false;
        const code = String(response.code || "");
        if (/balance|allowance/i.test(code)) throw new WalletError("Polymarket rejected the order because of balance or approvals.");
        const reason = code.replace(/_/g, " ").toLowerCase();
        throw new TicketError("Polymarket rejected the order" + (reason ? " (" + reason + ")." : "."));
      }
      const label = {live: "Open", matched: "Matched · settlement pending", delayed: "Accepted · matching delayed",
        unmatched: "No match reported"};
      $("[data-receipt-line]").textContent = "Order accepted · " + (label[response.status] || response.status);
      $("[data-receipt-line]").title = response.orderId;
      $("[data-note]").onclick = () => DashboardWatchlist.openJournal(journalMarket, true, response.orderId);
      receipt.hidden = false;
      resetReview();
      status.textContent = "";
      loadOrders();
      loadQuote();
    } catch (failure) {
      status.textContent = "";
      const issue = walletIssue(failure);
      if (issue) {
        if (issue.reconnect && wallet === connected?.session) disconnect();
        openWalletSettings(issue.message);
      } else if (dispatched) {
        uncertainOrders.add(orderKey(wallet));
        resetReview();
        error.textContent = unknownOrderMessage;
        loadOrders();
      } else {
        error.textContent = failureText(failure, "The order could not be prepared. Check MetaMask and try again.");
      }
    } finally {
      submitting = false;
      close.disabled = submit.disabled = $("[data-edit]").disabled = false;
      renderWallet();
    }
  });

  renderWallet();
  if (docked) {
    dock.append(dialog);
    dock.hidden = false;
    close.focus({preventScroll: true});
  } else {
    document.querySelector("main").append(dialog);
    dialog.showModal();
  }
  marketFor(position.slug).then((result) => {
    if (!isOpen()) return;
    if (position.condition_id && position.condition_id.toLowerCase() !== result.conditionId.toLowerCase()) {
      throw new TicketError("The current market does not match this position.");
    }
    market = result;
    $(".order-ticket-market").textContent = market.question || position.title;
    for (const [index, item] of market.outcomes.entries()) {
      const button = element("button", undefined, "order-outcome");
      button.type = "button";
      button.dataset.direction = index === 0 ? "first" : "second";
      button.append(element("span", item.label), element("strong", "—"));
      button.addEventListener("click", () => {
        outcomeIndex = index;
        changeDraft();
      });
      outcomes.append(button);
    }
    const index = market.outcomes.findIndex((item) => item.tokenId === position.token_id || item.assetId === position.token_id ||
      (item.label || "").toLowerCase() === (position.outcome || "").toLowerCase());
    if (index >= 0) outcomeIndex = index;
    side = sell && index >= 0 ? OrderSide.SELL : OrderSide.BUY;
    status.textContent = "";
    renderWallet();
    loadQuote();
    loadOrders();
  }).catch((failure) => {
    status.textContent = "";
    error.textContent = failureText(failure, "Market data couldn’t load. Reopen the ticket to retry.");
  });
  if (docked) return {close: closeTicket, get busy() { return submitting; }};
}
