"""Summarize wallet activity by outcome token."""
from collections import defaultdict
from datetime import datetime
from math import isfinite

BASIS_EVENTS = {"SPLIT", "MERGE", "CONVERSION", "REDEEM", "THRESHOLD_COMPOSE", "THRESHOLD_DECOMPOSE"}


def number(value):
    return value if type(value) in (int, float) and isfinite(value) else None


def timestamp(value):
    if isinstance(value, str):
        if value.isdecimal():
            return int(value)
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None
    return number(value)


def sum_amount(rows, key):
    values = [number(row.get(key)) for row in rows]
    return None if any(value is None for value in values) else sum(values)


def average_price(rows):
    units = sum_amount(rows, "size")
    prices = [number(row.get("price")) for row in rows]
    if not units or any(price is None for price in prices):
        return None
    return sum(row["size"] * price for row, price in zip(rows, prices)) / units


def settlement_price(position, combo, redeems):
    combo_status = combo.get("status")
    if combo_status in ("RESOLVED_WIN", "REDEEMABLE"):
        return 1
    if combo_status == "RESOLVED_LOSS" or position.get("status") == "REDEEMABLE_LOST":
        return 0
    units = sum_amount(redeems, "size")
    payout = sum_amount(redeems, "usdc_size")
    if units and units > 0 and payout is not None:
        rate = round(payout / units, 8)
        if 0 <= rate <= 1:
            return rate
    if position.get("status") == "REDEEMABLE":
        rate = number(position.get("current_price"))
        if rate is not None and 0 <= rate <= 1:
            return rate
    return None


def position_status(position, combo, buys, sales, redeems):
    if position:
        return "open" if position["status"] in ("OPEN", "MERGEABLE") else "closed"
    if combo:
        return "open" if combo["status"] == "OPEN" else "closed"
    bought = sum_amount(buys, "size")
    disposed = sum_amount(sales + redeems, "size")
    if bought and disposed is not None and abs(bought - disposed) <= max(0.01, bought * 0.0001):
        return "closed"
    return "unknown"


def summarize_token(token, condition, position, combo, executions, basis_changed):
    position, combo = position or {}, combo or {}
    buys = [row for row in executions if row["type"] == "TRADE" and row.get("side") == "BUY"]
    sales = [row for row in executions if row["type"] == "TRADE" and row.get("side") == "SELL"]
    redeems = [row for row in executions if row["type"] == "REDEEM"]
    state = position_status(position, combo, buys, sales, redeems)
    spend = sum_amount(buys, "usdc_size") if buys else None
    received = sum_amount(sales + redeems, "usdc_size")
    outstanding = None if state == "unknown" else 0
    if position.get("status") in ("OPEN", "MERGEABLE", "REDEEMABLE"):
        outstanding = number(position.get("current_value"))
    elif combo.get("status") == "OPEN":
        outstanding = number(combo.get("current_value"))
    elif combo.get("status") in ("RESOLVED_WIN", "REDEEMABLE"):
        payout = number(combo.get("realized_payout_usdc"))
        redeemed = sum_amount(redeems, "usdc_size")
        outstanding = max(0, payout - redeemed) if payout is not None and redeemed is not None else None

    bought = sum_amount(buys, "size")
    basis_shares = number(position.get("total_size"))
    if basis_shares is not None and bought is not None:
        basis_changed |= basis_shares - bought > max(0.01, bought * 0.0001)
    if basis_changed:
        spend = received = None

    pnl = None
    if spend is not None and received is not None and outstanding is not None:
        pnl = received + outstanding - spend
    source = "cash_flow" if pnl is not None else None
    if pnl is None and position:
        key = "realized_pnl" if position["status"] == "CLOSED" else "total_pnl"
        pnl = number(position.get(key))
        if pnl is not None:
            source = "polymarket"

    status = state
    if state == "closed":
        if pnl is None:
            status = "unknown"
        elif abs(pnl) < 0.005:
            status = "even"
        else:
            status = "won" if pnl > 0 else "lost"

    latest = executions[-1] if executions else {}
    dated = [row["timestamp"] for row in executions if number(row.get("timestamp")) is not None]
    opened = timestamp(position.get("first_entry_at") or combo.get("first_entry_at"))
    last = timestamp(position.get("last_event_at") or combo.get("resolved_at") or combo.get("updated_at"))
    if dated:
        opened = min((opened, dated[0])) if opened is not None else dated[0]
        last = max((last, dated[-1])) if last is not None else dated[-1]
    return {
        "token_id": token,
        "condition_id": condition,
        "slug": position.get("slug") or latest.get("slug"),
        "title": position.get("title") or latest.get("title") or "Polymarket position",
        "icon": position.get("icon") or latest.get("icon"),
        "is_combo": bool(combo),
        "outcome": position.get("outcome") or latest.get("outcome") or combo.get("outcome_label"),
        "status": status,
        "opened": opened,
        "last_activity": last,
        "avg_price": number(position.get("avg_price")) if state == "open" else None,
        "current_price": number(position.get("current_price")) if state == "open" else None,
        "unrealized_pnl": number(position.get("unrealized_pnl")) if state == "open" else None,
        "entry_price": average_price(buys) if buys else number(position.get("avg_price")),
        "exit_price": average_price(sales),
        "settlement_price": settlement_price(position, combo, redeems),
        "invested": spend,
        "received": received if spend is not None else None,
        "outstanding": outstanding,
        "pnl": pnl,
        "pnl_source": source,
        "roi": pnl / spend if source == "cash_flow" and spend and pnl is not None else None,
        "claimable": bool(outstanding and outstanding >= 0.005 and state == "closed"),
        "executions": [{key: row.get(key) for key in
                        ("type", "side", "size", "price", "timestamp", "usdc_size", "transaction_hash")}
                       for row in executions],
    }


def build_trade_summary(positions, combos, activity):
    single_positions = {}
    combo_positions = {}
    executions = defaultdict(list)
    conditions = {}
    changed_basis = set()
    for position in positions:
        if token := position.get("token_id"):
            single_positions.setdefault(token, position)
            conditions[token] = position.get("condition_id")
    for combo in combos:
        if token := combo.get("combo_position_id"):
            combo_positions.setdefault(token, combo)
            conditions[token] = combo.get("combo_condition_id")
    for row in activity:
        token = row.get("token_id")
        condition = row.get("condition_id")
        if token and row["type"] in ("TRADE", "REDEEM"):
            executions[token].append(row)
            conditions.setdefault(token, condition)
        elif condition and row["type"] in BASIS_EVENTS:
            changed_basis.add(condition)
    tokens = single_positions.keys() | combo_positions.keys() | executions.keys()
    return [
        summarize_token(token, conditions.get(token), single_positions.get(token), combo_positions.get(token),
                        sorted(executions.get(token, []), key=lambda row: number(row.get("timestamp")) or 0),
                        conditions.get(token) in changed_basis)
        for token in sorted(tokens)
    ]


def outcome_payout(payouts, index):
    if (not isinstance(payouts, list) or type(index) is not int or not 0 <= index < len(payouts) or
            not all(number(payout) is not None and payout >= 0 for payout in payouts)):
        return None
    total = sum(payouts)
    return payouts[index] / total if total > 0 else None


def portfolio_settlements(positions, combos, redemptions, resolutions):
    """Return dated binary payouts for positions held or redeemed at market resolution."""
    results = {}
    redeem_times = {}

    def add(condition, token, at, payout, title, outcome, slug=None):
        if at and at > 0 and payout in (0, 1):
            results.setdefault((condition, token), {
                "timestamp": int(at), "kind": "won" if payout == 1 else "lost", "payout": payout,
                "title": title or "Polymarket position", "outcome": outcome,
                "token_id": token, "condition_id": condition, "slug": slug,
            })

    for row in [*redemptions, *positions]:
        condition, token = row.get("condition_id"), row.get("token_id")
        if not condition or not token:
            continue
        is_redeem = row.get("type") == "REDEEM"
        redeemed_at = timestamp(row.get("timestamp")) if is_redeem else None
        if (number(row.get("size" if is_redeem else "current_size")) or 0) <= 0:
            continue
        if redeemed_at:
            redeem_times[condition] = max(redeemed_at, redeem_times.get(condition, 0))
        record = resolutions.get(condition, {})
        if (record.get("status") or "").lower() not in ("resolved", "settled"):
            continue
        at = timestamp(record.get("resolved_at") or record.get("last_update_timestamp"))
        if not at or (is_redeem and (not redeemed_at or redeemed_at < at)):
            continue
        entered_at = timestamp(row.get("first_entry_at"))
        if entered_at and entered_at > at:
            continue
        payout = outcome_payout(record.get("payouts"), row.get("outcome_index"))
        if payout is None and not record.get("payouts"):
            if is_redeem:
                size, received = number(row.get("size")), number(row.get("usdc_size"))
                if size and size > 0 and received is not None:
                    payout = received / size
            elif row.get("redeemable") is True:
                payout = number(row.get("current_price"))
        add(condition, token, at, payout, row.get("title"), row.get("outcome"), row.get("slug"))

    for combo in combos:
        condition, token = combo.get("combo_condition_id"), combo.get("combo_position_id")
        at = timestamp(combo.get("resolved_at"))
        entered_at = timestamp(combo.get("first_entry_at"))
        held = (number(combo.get("current_size")) or 0) > 0
        paid = (number(combo.get("realized_payout_usdc")) or 0) > 0
        if not (token and condition and at and (held or paid or redeem_times.get(condition, 0) >= at)):
            continue
        if entered_at and entered_at > at:
            continue
        status = combo.get("status")
        if status not in ("RESOLVED_WIN", "REDEEMABLE", "RESOLVED_LOSS"):
            continue
        legs = [leg.get("market") or {} for leg in combo.get("legs") or []]
        titles = [market.get("question") or market.get("title") for market in legs]
        add(condition, token, at, int(status != "RESOLVED_LOSS"),
            " + ".join(filter(None, titles)) or "Combo", combo.get("outcome_label"))

    return sorted(results.values(), key=lambda row: row["timestamp"])
