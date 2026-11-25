import {
  addressPattern, authenticate, balanceFor, bookFor, cancelOrder, connectWallet, funderFor, marketFor,
  openOrders, orderIdPattern, orderIntent, OrderSide, placeOrder, TicketError, verifyEligibility
} from "./client.js";

const slugPattern = /^[a-z0-9][a-z0-9-]{0,250}$/;
const number = new Intl.NumberFormat("en-US", {maximumFractionDigits: 6});
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

function priceText(levels, side) {
  if (!levels.length) return "—";
  const prices = levels.map((level) => Number(level.price));
  return number.format(side === "bid" ? Math.max(...prices) : Math.min(...prices));
}

export function open(position, {sell = false, savedWallet = ""} = {}) {
  if (active || !slugPattern.test(position.slug || "")) return;
  const journalMarket = {slug: position.slug, title: position.title};
  const dialog = element("dialog", undefined, "watch-dialog order-ticket");
  active = dialog;
  dialog.setAttribute("aria-labelledby", "order-ticket-heading");
  dialog.innerHTML = `
    <header class="watch-dialog-head">
      <div><h2 id="order-ticket-heading">Trade on Polymarket</h2><p class="muted order-ticket-market"></p></div>
      <button type="button" data-close class="text-button activity-dismiss" aria-label="Close order ticket" autofocus>×</button>
    </header>
    <div class="watch-dialog-body">
      <div class="order-wallet">
        <button type="button" data-connect class="secondary-button">Connect MetaMask</button>
        <div data-account hidden>
          <p class="muted order-address"></p>
          <label for="order-funder">Polymarket trading wallet</label>
          <div class="order-inline">
            <input id="order-funder" type="text" placeholder="0x…" spellcheck="false" autocomplete="off">
            <button type="button" data-enable class="secondary-button">Enable trading</button>
          </div>
          <p data-wallet-help class="muted">Use the public wallet address shown in your Polymarket profile.</p>
          <button type="button" data-disconnect class="text-button">Disconnect</button>
        </div>
        <p class="muted" data-funding-help>Fund the wallet and manage any required approvals on <a href="https://polymarket.com/" target="_blank" rel="noopener noreferrer">Polymarket</a>.</p>
      </div>
      <p data-status role="status" class="muted">Loading market…</p>
      <p data-error role="alert" class="negative"></p>
      <button type="button" data-acknowledge class="secondary-button" hidden>I checked my Polymarket orders</button>
      <form class="order-form" hidden>
        <fieldset>
          <div class="order-fields">
            <div><label for="order-side">Action</label><select id="order-side">
              <option value="BUY">Buy</option><option value="SELL">Sell</option>
            </select></div>
            <div><label for="order-outcome">Outcome</label><select id="order-outcome"></select></div>
            <div><label for="order-price">Limit price (pUSD)</label><input id="order-price" type="text" inputmode="decimal" required autocomplete="off" placeholder="0.52"></div>
            <div><label for="order-size">Shares</label><input id="order-size" type="text" inputmode="decimal" required autocomplete="off" placeholder="10"></div>
          </div>
          <p data-quote class="muted"></p>
          <p data-balance class="muted"></p>
          <button type="submit" class="secondary-button">Review limit order</button>
        </fieldset>
      </form>
      <section data-review class="order-review" aria-label="Review order" hidden>
        <strong data-review-line></strong>
        <p data-review-total></p>
        <p class="muted">Good till canceled. Any unfilled shares can stay open. Fees may apply to fills.</p>
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
  const connect = $("[data-connect]");
  const enable = $("[data-enable]");
  const funder = $("#order-funder");
  const form = $(".order-form");
  const fields = $("fieldset");
  const side = $("#order-side");
  const outcome = $("#order-outcome");
  const price = $("#order-price");
  const size = $("#order-size");
  const review = $("[data-review]");
  const submit = $("[data-submit]");
  const error = $("[data-error]");
  const status = $("[data-status]");
  const quote = $("[data-quote]");
  const balance = $("[data-balance]");
  const orders = $("[data-orders]");
  const ordersList = orders.querySelector("ul");
  const ordersStatus = $("[data-orders-status]");
  const refresh = $("[data-refresh]");
  const receipt = $("[data-receipt]");
  const acknowledge = $("[data-acknowledge]");
  $(".order-ticket-market").textContent = position.title || position.slug;

  let market;
  let book;
  let session = connected?.session;
  let intent;
  let submitting = false;
  let quoteRequest = 0;
  let orderRequest = 0;

  const orderKey = (wallet) => wallet && market && wallet.wallet + ":" + market.conditionId;
  const uncertain = () => uncertainOrders.has(orderKey(session));
  const unknownOrderMessage = "Order status is unknown. Check your orders and activity on Polymarket before submitting again.";

  function renderWallet() {
    connect.hidden = Boolean(connected);
    $("[data-account]").hidden = !connected;
    $(".order-address").textContent = connected ? "MetaMask " + connected.address : "";
    enable.hidden = funder.readOnly = Boolean(session);
    $("[data-wallet-help]").hidden = Boolean(session);
    orders.hidden = !session || !market;
    form.hidden = !market;
    acknowledge.hidden = !uncertain();
    fields.disabled = !session || Boolean(intent) || submitting || uncertain();
    if (uncertain()) error.textContent = unknownOrderMessage;
  }

  acknowledge.addEventListener("click", () => {
    uncertainOrders.delete(orderKey(session));
    error.textContent = "";
    renderWallet();
    price.focus();
  });

  function resetReview() {
    intent = undefined;
    review.hidden = true;
    renderWallet();
  }

  async function loadQuote() {
    if (!market) return;
    const selected = market.outcomes[Number(outcome.value)];
    const request = ++quoteRequest;
    const wallet = session;
    const action = side.value;
    book = null;
    quote.textContent = "Loading order book…";
    balance.textContent = "";
    form.querySelector("[type=submit]").disabled = true;
    if (wallet) balanceFor(wallet, action, selected).then((account) => {
      if (request === quoteRequest) balance.textContent = action === OrderSide.BUY
        ? amount(account.balance) + " pUSD in trading wallet" : amount(account.balance) + " shares in trading wallet";
    }).catch(() => {
      if (request === quoteRequest) balance.textContent = "Trading balance unavailable.";
    });
    try {
      const current = await bookFor(market, selected);
      if (request !== quoteRequest) return;
      book = current;
      quote.textContent = "Bid " + priceText(book.bids, "bid") + " · Ask " + priceText(book.asks, "ask") +
        " · Min. " + book.minOrderSize + " shares";
      form.querySelector("[type=submit]").disabled = false;
    } catch (failure) {
      if (request === quoteRequest) quote.textContent = failureText(failure, "Order book unavailable. Reselect the outcome to retry.");
    }
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
            error.textContent = failureText(failure, "Cancellation could not be confirmed. Refresh orders or check Polymarket.");
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
    session = undefined;
    funder.value = "";
    ordersList.replaceChildren();
    ordersStatus.textContent = "";
    error.textContent = "";
    resetReview();
    loadQuote();
    if (!submitting) status.textContent = "Wallet disconnected.";
  }

  walletEvents.addEventListener("change", walletChanged);
  close.addEventListener("click", () => { if (!submitting) dialog.close(); });
  dialog.addEventListener("cancel", (event) => { if (submitting) event.preventDefault(); });
  dialog.addEventListener("close", () => {
    walletEvents.removeEventListener("change", walletChanged);
    active = undefined;
    dialog.remove();
  }, {once: true});
  connect.addEventListener("click", async () => {
    error.textContent = "";
    connect.disabled = true;
    try {
      const provider = metaMask();
      const address = await connectWallet(provider);
      if (!dialog.open) return;
      const connection = rememberConnection(provider, address);
      const suggested = await funderFor(address);
      if (connected !== connection) return;
      funder.value = suggested || (addressPattern.test(savedWallet) ? savedWallet : address);
      status.textContent = "Confirm your trading wallet, then enable trading.";
      renderWallet();
      funder.focus();
    } catch (failure) {
      error.textContent = failureText(failure, "MetaMask could not connect. Check your account and Polygon network.");
    } finally {
      connect.disabled = false;
    }
  });
  enable.addEventListener("click", async () => {
    const connection = connected;
    if (!connection) return;
    enable.disabled = true;
    funder.readOnly = true;
    error.textContent = "";
    status.textContent = "Confirm the trading sign-in in MetaMask.";
    try {
      const wallet = await authenticate(connection.provider, connection.address, funder.value);
      if (connection !== connected || !dialog.open) return;
      session = connection.session = wallet;
      funder.value = wallet.wallet;
      status.textContent = "Trading enabled for this tab.";
      renderWallet();
      loadQuote();
      loadOrders();
    } catch (failure) {
      error.textContent = failureText(failure, "Polymarket sign-in failed. Verify the profile wallet and try again.");
      status.textContent = "";
    } finally {
      enable.disabled = false;
      funder.readOnly = Boolean(session);
    }
  });
  $("[data-disconnect]").addEventListener("click", disconnect);
  refresh.addEventListener("click", () => loadOrders());
  for (const control of [outcome, side]) control.addEventListener("change", () => {
    resetReview();
    loadQuote();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!session || !book || uncertain() || submitting) return;
    error.textContent = "";
    try {
      const selected = market.outcomes[Number(outcome.value)];
      intent = orderIntent(market, book, selected, side.value, price.value.trim(), size.value.trim());
      $("[data-review-line]").textContent = (side.value === OrderSide.BUY ? "Buy " : "Sell ") +
        intent.size + " " + selected.label + " shares at " + intent.price + " pUSD each";
      $("[data-review-total]").textContent = amount(intent.notional) + " pUSD at the limit, before fees";
      review.hidden = false;
      renderWallet();
      submit.focus();
    } catch (failure) {
      error.textContent = failureText(failure, "This order could not be reviewed.");
    }
  });
  $("[data-edit]").addEventListener("click", () => {
    resetReview();
    price.focus();
  });
  submit.addEventListener("click", async () => {
    if (!session || !intent || uncertain() || submitting) return;
    const approved = intent;
    const wallet = session;
    const selected = market.outcomes[Number(outcome.value)];
    submitting = true;
    close.disabled = submit.disabled = $("[data-edit]").disabled = $("[data-disconnect]").disabled = true;
    receipt.hidden = true;
    let dispatched = false;
    error.textContent = "";
    status.textContent = "Checking the market and your trading balance…";
    try {
      await verifyEligibility();
      const latest = await marketFor(position.slug);
      const current = latest.outcomes.find(({assetId}) => assetId === selected.assetId);
      if (latest.conditionId !== market.conditionId || current?.label !== selected.label) {
        throw new TicketError("Market details changed. Reopen the ticket before submitting.");
      }
      const checked = orderIntent(latest, await bookFor(latest, current), current, approved.side, approved.price, approved.size);
      if (checked.exchange !== approved.exchange) throw new TicketError("The trading contract changed. Reopen this ticket.");
      const funds = await balanceFor(wallet, approved.side, current);
      const needed = approved.side === OrderSide.BUY ? approved.notional : approved.quantity;
      if (funds.balance < needed) throw new TicketError(approved.side === OrderSide.BUY
        ? "Insufficient pUSD in the trading wallet." : "Insufficient shares in the trading wallet.");
      const allowance = Object.entries(funds.allowances).find(([address]) => address.toLowerCase() === checked.exchange)?.[1];
      if (allowance !== undefined && allowance < needed) {
        throw new TicketError("Trading allowance is insufficient. Set it up on Polymarket before submitting.");
      }
      if (wallet !== session) throw new TicketError("The trading wallet changed. Reconnect before submitting.");
      status.textContent = "Review and sign the order in MetaMask.";
      const response = await placeOrder(wallet, approved, () => {
        if (wallet !== session) throw new TicketError("The trading wallet changed. Reconnect before submitting.");
        dispatched = true;
        status.textContent = "Waiting for Polymarket to confirm the order…";
      });
      if (!response.ok) {
        dispatched = false;
        const reason = String(response.code || "").replace(/_/g, " ").toLowerCase();
        throw new TicketError("Polymarket rejected the order" + (reason ? " (" + reason + ")." : "."));
      }
      const label = {live: "Open", matched: "Matched · settlement pending", delayed: "Accepted · matching delayed"};
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
      if (dispatched) {
        uncertainOrders.add(orderKey(wallet));
        resetReview();
        error.textContent = unknownOrderMessage;
        loadOrders();
      } else {
        error.textContent = failureText(failure, "The order could not be prepared. Check MetaMask and try again.");
      }
    } finally {
      submitting = false;
      close.disabled = submit.disabled = $("[data-edit]").disabled = $("[data-disconnect]").disabled = false;
      renderWallet();
    }
  });

  if (connected) funder.value = session?.wallet || (addressPattern.test(savedWallet) ? savedWallet : connected.address);
  renderWallet();
  document.querySelector("main").append(dialog);
  dialog.showModal();
  marketFor(position.slug).then((result) => {
    if (!dialog.open) return;
    if (position.condition_id && position.condition_id.toLowerCase() !== result.conditionId.toLowerCase()) {
      throw new TicketError("The current market does not match this position.");
    }
    market = result;
    $(".order-ticket-market").textContent = market.question || position.title;
    for (const [index, item] of market.outcomes.entries()) {
      const option = element("option", item.label);
      option.value = index;
      outcome.append(option);
    }
    const index = market.outcomes.findIndex((item) => item.tokenId === position.token_id || item.assetId === position.token_id ||
      (item.label || "").toLowerCase() === (position.outcome || "").toLowerCase());
    if (index >= 0) outcome.value = index;
    side.value = sell && index >= 0 ? OrderSide.SELL : OrderSide.BUY;
    status.textContent = "";
    renderWallet();
    loadQuote();
    loadOrders();
  }).catch((failure) => {
    status.textContent = "";
    error.textContent = failureText(failure, "Market data couldn’t load. Reopen the ticket to retry.");
  });
}
