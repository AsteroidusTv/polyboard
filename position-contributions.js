"use strict";

const PositionContributions = (() => {
  const day = 86400;
  const price = (value) => Number.isFinite(value) && value >= 0 && value <= 1;
  const timestamp = (value) => Number.isFinite(value) && value > 0;

  function history(position, points, settlement, times) {
    if (position.pnl_source !== "cash_flow") return null;
    const events = [];
    for (const fill of position.executions) {
      const {type, side, size, usdc_size: amount, timestamp: at} = fill;
      if (!timestamp(at) || !Number.isFinite(size) || size <= 0 || !Number.isFinite(amount) || amount < 0) return null;
      if (type === "TRADE" && ["BUY", "SELL"].includes(side)) {
        const direction = side === "BUY" ? 1 : -1;
        events.push({at, shares: direction * size, cash: -direction * amount, mark: fill.price});
      } else if (type === "REDEEM") {
        events.push({at, shares: -size, cash: amount});
      } else {
        return null;
      }
    }
    const marks = points.filter(([at, value]) => timestamp(at) && price(value))
      .map(([at, mark]) => ({at, mark}));
    if (price(position.current_price)) marks.push({at: times.at(-1), mark: position.current_price});
    if (timestamp(settlement?.timestamp) && price(settlement.payout)) {
      events.push({at: settlement.timestamp, payout: settlement.payout});
    }
    const timeline = [...marks, ...events].sort((a, b) => a.at - b.at);
    let shares = 0;
    let cash = 0;
    let mark;
    let markedAt;
    let payout;
    let index = 0;
    let started = false;
    const values = [];
    for (const at of times) {
      while (timeline[index]?.at <= at) {
        const event = timeline[index++];
        if (event.shares !== undefined) {
          shares += event.shares;
          cash += event.cash;
          started = true;
          if (shares < -0.0001) return null;
          if (Math.abs(shares) < 0.0001) shares = 0;
        }
        if (price(event.mark)) {
          mark = event.mark;
          markedAt = event.at;
        }
        if (event.payout !== undefined) payout = event.payout;
      }
      const valuation = payout ?? (at - markedAt <= 2 * day ? mark : undefined);
      values.push({started, value: !shares ? cash : valuation === undefined ? null : cash + shares * valuation});
    }
    const latest = values.at(-1).value;
    if (latest !== null && Math.abs(latest - position.pnl) > Math.max(0.05, Math.abs(position.pnl) * 0.001)) return null;
    return values;
  }

  function windowPoints(values, times, start) {
    const baseline = values[start].value;
    if (baseline === null) return null;
    return values.slice(start).map(({started, value}, index) =>
      [times[start + index], started && value !== null ? value - baseline : null]);
  }

  return {history, windowPoints};
})();
