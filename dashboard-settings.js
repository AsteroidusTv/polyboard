"use strict";

const DashboardSettings = (() => {
  const walletPattern = /^0x[0-9a-f]{40}$/i;
  const walletKey = "polymarket.wallet";
  const rangeKey = "polymarket.portfolioRange";
  const ranges = [7, 30, 90, 0];
  const reviewEnabled = document.body.hasAttribute("data-review-enabled") ||
    Boolean(document.querySelector("#review-dialog[data-direct-review]"));
  const sessionURL = "/api/reviews?session=1";
  // Status requests authenticate before looking up a wallet and never launch a review.
  const sessionStatusURL = "/api/reviews?wallet=0x0000000000000000000000000000000000000000";
  let wallet = document.body.dataset.defaultWallet || "";
  let chartRange = 0;
  try {
    const saved = localStorage.getItem(walletKey);
    const range = Number(localStorage.getItem(rangeKey));
    if (walletPattern.test(saved || "")) wallet = saved.toLowerCase();
    if (ranges.includes(range)) chartRange = range;
  } catch {
    // Settings still apply for this page when storage is unavailable.
  }

  function remember(key, value) {
    try { localStorage.setItem(key, value); } catch { /* Browser storage is optional. */ }
  }

  const dialog = document.createElement("dialog");
  dialog.id = "settings-dialog";
  dialog.setAttribute("aria-labelledby", "settings-title");
  dialog.innerHTML = `
    <div class="settings-heading">
      <h2 id="settings-title">Settings</h2>
      <form method="dialog"><button type="submit" class="text-button activity-dismiss" aria-label="Close settings" autofocus>×</button></form>
    </div>
    <div class="settings-body">
      <section class="settings-section" aria-labelledby="settings-wallet-title">
        <h3 id="settings-wallet-title">Portfolio wallet</h3>
        <form id="settings-wallet-form" class="settings-form" novalidate>
          <label for="wallet">Public wallet address</label>
          <input id="wallet" name="wallet" type="text" placeholder="0x…" spellcheck="false" autocapitalize="off" autocomplete="off" aria-describedby="settings-wallet-error">
          <p id="settings-wallet-error" role="alert" class="negative" hidden></p>
          <button type="submit">Apply wallet</button>
        </form>
      </section>
      <section class="settings-section" id="settings-trading" aria-labelledby="settings-trading-title">
        <h3 id="settings-trading-title" tabindex="-1">Trading wallet</h3>
        <p id="settings-trading-notice" class="settings-message negative" role="alert" tabindex="-1" hidden></p>
        <div id="settings-trading-controls" class="settings-trading-controls">
          <p class="muted settings-message" role="status">Loading trading wallet…</p>
        </div>
      </section>
      <section class="settings-section" id="settings-codex" aria-labelledby="settings-codex-title">
        <div class="settings-section-heading">
          <h3 id="settings-codex-title">Codex reviews</h3>
          <span id="settings-review-badge" class="settings-badge" hidden>Connected</span>
        </div>
        <p id="settings-review-status" class="settings-message muted" role="status"></p>
        <form id="settings-review-form" class="settings-form" hidden>
          <label for="review-key">Private review access key</label>
          <input id="review-key" type="password" autocomplete="off" spellcheck="false" maxlength="43">
          <button type="submit" class="secondary-button" id="settings-connect">Connect Codex</button>
        </form>
        <button type="button" class="secondary-button" id="settings-disconnect" hidden>Sign out of reviews</button>
      </section>
      <section class="settings-section" aria-labelledby="settings-chart-title">
        <h3 id="settings-chart-title">Portfolio chart</h3>
        <div class="settings-preference">
          <span id="settings-range-label">Default range</span>
          <div class="chart-ranges" id="settings-range" role="group" aria-labelledby="settings-range-label">
            <button type="button" data-range="7" aria-pressed="false">1W</button>
            <button type="button" data-range="30" aria-pressed="false">1M</button>
            <button type="button" data-range="90" aria-pressed="false">3M</button>
            <button type="button" data-range="0" aria-pressed="true">All</button>
          </div>
        </div>
      </section>
    </div>`;
  document.querySelector("main").append(dialog);
  const find = (id) => dialog.querySelector("#" + id);
  const walletInput = find("wallet");
  const walletError = find("settings-wallet-error");
  const reviewForm = find("settings-review-form");
  const keyInput = find("review-key");
  const reviewStatus = find("settings-review-status");
  const reviewBadge = find("settings-review-badge");
  const connect = find("settings-connect");
  const disconnect = find("settings-disconnect");
  const rangeControl = find("settings-range");
  let callbacks = {};
  let signedIn = false;
  let checking;
  let changingSession = false;
  let tradingSettings;

  async function reviewRequest(url, options = {}) {
    const timeout = AbortSignal.timeout(15000);
    const response = await fetch(url, {
      ...options,
      credentials: "same-origin",
      cache: "no-store",
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    });
    const data = await response.json();
    if (!response.ok) {
      const failure = new Error(data.error || "The review service is unavailable.");
      failure.status = response.status;
      throw failure;
    }
    return data;
  }

  function reviewSession(active) {
    signedIn = active;
    reviewForm.hidden = active || !reviewEnabled;
    reviewBadge.hidden = disconnect.hidden = !active;
    reviewStatus.classList.remove("negative");
    reviewStatus.textContent = active ? "Reviews are enabled for this browser."
      : reviewEnabled ? "Use your private dashboard access key to enable Codex reviews."
        : "Codex reviews are available on the hosted dashboard.";
    callbacks.onReviewSession?.(active);
  }

  function reviewError(message) {
    reviewStatus.textContent = message;
    reviewStatus.classList.add("negative");
  }

  function checkSession() {
    if (!reviewEnabled || checking || changingSession) return;
    checking = reviewRequest(sessionStatusURL).then(() => reviewSession(true), (failure) => {
      if (failure.status === 401) reviewSession(false);
      else reviewError("Couldn’t check Codex access. Try again in a moment.");
    }).finally(() => { checking = null; });
  }

  function loadTradingSettings() {
    const controls = find("settings-trading-controls");
    tradingSettings ||= import("/order-ticket.js")
      .then((ticket) => ticket.mountWalletSettings(controls, () => wallet))
      .catch(() => {
        controls.textContent = "Trading settings couldn’t load. Reopen Settings to try again.";
        tradingSettings = undefined;
      });
    tradingSettings.then((refresh) => { if (dialog.open) refresh?.(); });
  }

  function open(section = "wallet", message = "") {
    if (!dialog.open) {
      walletInput.value = wallet;
      walletInput.removeAttribute("aria-invalid");
      keyInput.removeAttribute("aria-invalid");
      walletError.hidden = true;
      dialog.showModal();
      find("settings-wallet-title").closest(".settings-body").scrollTop = 0;
      checkSession();
    }
    const notice = find("settings-trading-notice");
    notice.textContent = message;
    notice.hidden = !message;
    if (section === "codex") find("settings-codex").scrollIntoView({block: "nearest"});
    if (section === "trading") {
      find("settings-trading").scrollIntoView({block: "start"});
      const focus = message ? notice : find("settings-trading-title");
      focus.focus({preventScroll: true});
    }
    loadTradingSettings();
  }

  for (const trigger of document.querySelectorAll("[data-open-settings]")) {
    trigger.addEventListener("click", () => open());
  }
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
  });
  dialog.addEventListener("close", () => { keyInput.value = ""; });
  find("settings-wallet-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const address = walletInput.value.trim().toLowerCase();
    if (!walletPattern.test(address)) {
      walletInput.setAttribute("aria-invalid", "true");
      walletError.textContent = "Enter a public wallet address starting with 0x and followed by 40 hexadecimal characters.";
      walletError.hidden = false;
      walletInput.focus();
      return;
    }
    wallet = address;
    remember(walletKey, wallet);
    dialog.close();
    callbacks.onWallet?.();
  });
  walletInput.addEventListener("input", () => {
    walletInput.removeAttribute("aria-invalid");
    walletError.hidden = true;
  });

  reviewForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (changingSession || !reviewEnabled) return;
    const key = keyInput.value.trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(key)) {
      keyInput.setAttribute("aria-invalid", "true");
      reviewError("Enter your 43-character review access key.");
      keyInput.focus();
      return;
    }
    keyInput.value = "";
    changingSession = connect.disabled = disconnect.disabled = true;
    await checking;
    reviewStatus.classList.remove("negative");
    reviewStatus.textContent = "Connecting Codex…";
    try {
      await reviewRequest(sessionURL, {method: "POST", headers: {Authorization: "Bearer " + key}});
      await reviewRequest(sessionStatusURL);
      reviewSession(true);
    } catch (failure) {
      reviewSession(false);
      if (failure.status === 401) keyInput.setAttribute("aria-invalid", "true");
      reviewError(failure.status === 401 ? "Couldn’t connect. Check your access key and allow site cookies."
        : "Couldn’t connect to the review service. Try again in a moment.");
    } finally {
      changingSession = connect.disabled = disconnect.disabled = false;
    }
  });
  keyInput.addEventListener("input", () => keyInput.removeAttribute("aria-invalid"));
  disconnect.addEventListener("click", async () => {
    if (changingSession) return;
    changingSession = connect.disabled = disconnect.disabled = true;
    await checking;
    try {
      await reviewRequest(sessionURL, {method: "DELETE"});
      reviewSession(false);
      keyInput.focus();
    } catch {
      reviewError("Couldn’t sign out of Codex reviews. Try again in a moment.");
    } finally {
      changingSession = connect.disabled = disconnect.disabled = false;
    }
  });

  function syncRange() {
    for (const button of rangeControl.children) button.setAttribute("aria-pressed", Number(button.dataset.range) === chartRange);
  }
  rangeControl.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-range]");
    if (!button) return;
    chartRange = Number(button.dataset.range);
    remember(rangeKey, chartRange);
    syncRange();
    callbacks.onRange?.(chartRange);
  });
  syncRange();
  DashboardWidgets.slidingSelection(rangeControl);
  reviewSession(false);

  return {
    get wallet() { return wallet; },
    get chartRange() { return chartRange; },
    get signedIn() { return signedIn; },
    reviewEnabled, reviewRequest, reviewSession, open,
    configure(options) { callbacks = options; }
  };
})();
