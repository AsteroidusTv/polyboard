"use strict";

const DashboardRisk = (() => {
  const byId = (id) => document.getElementById(id);
  const toggle = byId("risk-toggle");
  const dialog = byId("risk-dialog");
  const status = byId("risk-status");
  const loadingDots = byId("risk-progress");
  const run = byId("risk-run");
  const connect = byId("risk-connect");
  const result = byId("risk-report");
  const phases = {
    market: "Loading market rules…",
    books: "Checking live prices and depth…",
    precedents: "Checking comparable markets…",
    starting: "Starting Codex…",
    analyzing: "Weighing the risk and price…",
    researching: "Checking recent sources…",
    writing: "Writing the recommendation…",
    usage: "Finishing the risk check…"
  };
  let selection;
  let request;

  function render({report, snapshot}) {
    byId("risk-action").textContent = report.action;
    const level = byId("risk-level");
    level.textContent = report.risk === "Unclear" ? "Risk unclear" : report.risk + " risk";
    level.dataset.level = report.risk.toLowerCase();
    byId("risk-rationale").textContent = report.rationale;
    byId("risk-main").textContent = report.main_risk;
    byId("risk-recheck").textContent = report.recheck;
    const stamp = new Date(snapshot.as_of);
    const date = new Intl.DateTimeFormat("en-US", {dateStyle: "medium", timeStyle: "short"});
    byId("risk-time").textContent = "Checked " + date.format(stamp);

    const links = [];
    const seen = new Set();
    for (const source of [{title: "Market & rules", url: snapshot.market_url}, ...report.sources]) {
      let url;
      try { url = new URL(source.url); } catch { continue; }
      if (url.protocol !== "https:" || url.username || url.password || seen.has(url.href)) continue;
      const link = document.createElement("a");
      link.className = "precedent-link";
      link.textContent = source.title + " ↗";
      link.href = url.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      seen.add(url.href);
      links.push(link);
    }
    byId("risk-sources").replaceChildren(...links);
    result.hidden = false;
  }

  async function monitor(start) {
    if (!selection || !dialog.open) return;
    request?.abort();
    const current = new AbortController();
    request = current;
    const params = {mode: "risk", market: selection.target.slug, scope: selection.scope, wallet: DashboardSettings.wallet};
    const endpoint = "/api/reviews?" + new URLSearchParams(params);
    const {signal} = current;
    run.hidden = connect.hidden = true;
    result.hidden = true;
    status.classList.remove("negative");
    status.textContent = start ? phases.market : "Checking Codex access…";
    loadingDots.hidden = !start;
    try {
      let data = start ? await DashboardSettings.reviewRequest("/api/reviews", {
        method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(params), signal
      }) : await DashboardSettings.reviewRequest(endpoint, {signal});
      if (signal.aborted) return;
      DashboardSettings.reviewSession(true);
      while (data.state === "running") {
        status.textContent = phases[data.phase] || "Analyzing this market…";
        loadingDots.hidden = false;
        await new Promise((resolve) => setTimeout(resolve, 2300));
        if (signal.aborted) return;
        data = await DashboardSettings.reviewRequest(endpoint, {signal});
      }
      if (signal.aborted) return;
      if (data.state === "failed") throw new Error(data.error || "Risk check failed.");
      if (data.state === "complete") render(data);
      status.textContent = data.state === "complete" ? "" : "Codex weighs the price, market rules and recent evidence.";
      run.textContent = data.state === "complete" ? "Refresh analysis" : "Run risk check";
      run.hidden = false;
    } catch (failure) {
      if (signal.aborted) return;
      if (failure.status === 401) {
        DashboardSettings.reviewSession(false);
        status.textContent = "Connect Codex in Settings to run a risk check.";
        connect.hidden = false;
      } else {
        status.textContent = failure instanceof SyntaxError ? "The review service couldn’t respond." : failure.message;
        status.classList.add("negative");
        run.textContent = "Try again";
        run.hidden = false;
      }
    } finally {
      if (!signal.aborted) loadingDots.hidden = true;
    }
  }

  toggle.addEventListener("click", () => {
    if (!selection) return;
    byId("risk-market").textContent = selection.target.label;
    dialog.showModal();
    monitor(false);
  });
  run.addEventListener("click", () => monitor(true));
  connect.addEventListener("click", () => {
    dialog.close();
    DashboardSettings.open("codex");
  });
  dialog.addEventListener("close", () => {
    if (!dialog.open) request?.abort();
  });

  return {
    setMarket(target, scope) {
      if (dialog.open && (target.slug !== selection.target.slug || scope !== selection.scope)) dialog.close();
      selection = {target, scope};
      toggle.hidden = !DashboardSettings.reviewEnabled || target.closed;
    }
  };
})();
