"use strict";

const DashboardLineChart = (() => {
  const colors = {
    grid: "#2b3446", label: "#a1abbe", line: "#aabaff",
    buy: "#6ae4ac", sell: "#ffbd83", won: "#6ae4ac", lost: "#ff919d",
    deposit: "#80ccff", settlement: "#cad5ff", background: "#111720"
  };
  const shortDate = new Intl.DateTimeFormat("en-US", {month: "short", day: "numeric"});
  const chartTime = new Intl.DateTimeFormat("en-US", {hour: "numeric", minute: "2-digit"});
  const monthYear = new Intl.DateTimeFormat("en-US", {month: "short", year: "2-digit"});
  const fullDate = new Intl.DateTimeFormat("en-US", {dateStyle: "medium"});
  const dateTime = new Intl.DateTimeFormat("en-US", {dateStyle: "medium", timeStyle: "short"});
  const executionTime = new Intl.DateTimeFormat("en-US", {dateStyle: "medium", timeStyle: "medium"});
  const timeOnly = new Intl.DateTimeFormat("en-US", {timeStyle: "medium"});
  const day = 86400;

  function valueOnLine(points, time) {
    let low = 0;
    let high = points.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (points[middle][0] < time) low = middle + 1;
      else high = middle;
    }
    const after = points[low];
    if (after?.[0] === time) return after[1];
    const before = points[low - 1];
    if (!before || !after) return undefined;
    const fraction = (time - before[0]) / (after[0] - before[0]);
    return before[1] + fraction * (after[1] - before[1]);
  }

  function axisBounds(points, markerValues, price, fullPriceScale) {
    if (price && fullPriceScale) return {min: 0, max: 1, step: .25};
    let min = price ? Infinity : 0;
    let max = price ? -Infinity : 0;
    for (const point of points) {
      min = Math.min(min, point[1]);
      max = Math.max(max, point[1]);
    }
    for (const value of markerValues) {
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    if (price) {
      const padding = Math.max((max - min) * .06, .001);
      min = Math.max(0, min - padding);
      max = Math.min(1, max + padding);
    } else if (min === max) {
      return {min: -1, max: 1, step: .5};
    }
    const size = (max - min) / (price ? 5 : 4);
    const magnitude = 10 ** Math.floor(Math.log10(size));
    const step = magnitude * [1, 2, 2.5, 5, 10].find((multiplier) => multiplier >= size / magnitude);
    const lower = Math.floor(min / step + 1e-8) * step;
    const upper = Math.ceil(max / step - 1e-8) * step;
    return {min: price ? Math.max(0, lower) : lower, max: price ? Math.min(1, upper) : upper, step};
  }

  return class {
    static drawComparison(canvas, series, days, contribution) {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const ctx = canvas.getContext("2d");
      if (!width || !height || !ctx || (!series.length && !contribution)) return;
      const first = contribution?.start ?? Math.min(...series.map(({points}) => points[0][0]));
      const last = contribution?.end ?? Math.max(...series.map(({points}) => points.at(-1)[0]));
      if (last <= first) return;
      const start = days ? Math.max(first, last - days * day) : first;
      const traces = contribution ? series : series.map((item) => {
        const points = item.points.filter(([timestamp]) => timestamp >= start);
        const edge = valueOnLine(item.points, start);
        if (edge !== undefined && points[0]?.[0] > start) points.unshift([start, edge]);
        return {...item, points};
      });
      const scale = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      ctx.scale(scale, scale);
      ctx.font = "11px system-ui, sans-serif";
      const format = contribution
        ? new Intl.NumberFormat("en-US", {style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2})
        : new Intl.NumberFormat("en-US", {style: "percent", maximumFractionDigits: 2});
      const axis = axisBounds([[start, 0], ...traces.flatMap(({points}) => points.filter(([, value]) => value !== null))],
        [], !contribution, false);
      const ticks = [];
      for (let value = axis.min; value <= axis.max + axis.step / 100; value += axis.step) {
        ticks.push([value, format.format(value)]);
      }
      const left = 6;
      const right = width - Math.max(...ticks.map(([, label]) => ctx.measureText(label).width)) - 17;
      const top = 10;
      const bottom = height - 23;
      if (right <= left) return;
      const x = (time) => left + (time - start) / (last - start) * (right - left);
      const y = (value) => bottom - (value - axis.min) / (axis.max - axis.min) * (bottom - top);
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = colors.label;
      ctx.strokeStyle = colors.grid;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 5]);
      for (const [value, label] of ticks) {
        const level = y(value);
        ctx.beginPath();
        ctx.moveTo(left, level);
        ctx.lineTo(right + 3, level);
        ctx.stroke();
        ctx.fillText(label, right + 10, level);
      }
      ctx.setLineDash([]);
      const dateFormat = last - start <= day ? chartTime : shortDate;
      const divisions = width < 440 ? 2 : 4;
      for (let index = 0; index <= divisions; index++) {
        const time = start + (last - start) * index / divisions;
        ctx.textAlign = index === 0 ? "left" : index === divisions ? "right" : "center";
        ctx.fillText(dateFormat.format(time * 1000), x(time), bottom + 14);
      }
      if (contribution) {
        const zero = y(0);
        const cursor = x(contribution.at);
        ctx.strokeStyle = colors.label;
        ctx.beginPath();
        ctx.moveTo(left, zero);
        ctx.lineTo(right, zero);
        ctx.moveTo(cursor, top);
        ctx.lineTo(cursor, bottom);
        ctx.stroke();
      }
      for (const trace of traces) {
        if (!trace.visible || !trace.points.length) continue;
        ctx.beginPath();
        let connected = false;
        for (const [time, value] of trace.points) {
          if (value === null) {
            connected = false;
            continue;
          }
          ctx[connected ? "lineTo" : "moveTo"](x(time), y(value));
          connected = true;
        }
        ctx.lineWidth = contribution ? (trace.highlight ? 2.2 : 1) : 1.8;
        ctx.lineJoin = "round";
        ctx.strokeStyle = trace.color;
        ctx.stroke();
        const [time, value] = contribution
          ? trace.points[contribution.index] : trace.points.at(-1);
        if (value === null || (contribution && !trace.highlight)) continue;
        ctx.beginPath();
        ctx.arc(x(time), y(value), 2.8, 0, Math.PI * 2);
        ctx.fillStyle = trace.color;
        ctx.fill();
      }
      return {start, end: last, left, right, top, bottom, x,
        valuesAt(time) {
          return traces.flatMap((trace) => {
            if (!trace.visible) return [];
            const price = valueOnLine(trace.points, time);
            return price === undefined ? [] : [{market: trace.market, slot: trace.slot, price, y: y(price)}];
          });
        }};
    }

    constructor(container, options) {
      this.container = container;
      this.options = options;
      this.canvas = container.querySelector("canvas");
      this.context = this.canvas.getContext("2d");
      this.tooltip = container.querySelector(".chart-tooltip");
      this.tradeList = this.tooltip.querySelector(".chart-tooltip-trades");
      this.openButton = this.tooltip.querySelector(".chart-tooltip-open");
      this.announcement = container.querySelector(".chart-announcement");
      this.observations = [];
      this.selected = null;
      this.pinned = null;
      this.canvas.addEventListener("pointermove", (event) => this.pointAt(event));
      this.canvas.addEventListener("pointerdown", (event) => this.pointAt(event));
      this.canvas.addEventListener("click", (event) => {
        if (!this.plot) return;
        const rect = this.canvas.getBoundingClientRect();
        const group = this.markerGroupAt(event.clientX - rect.left, event.clientY - rect.top);
        if (!group) {
          if (!this.options.price && this.pinned) this.pin(null);
          return;
        }
        const trade = group.members[0];
        if (trade.tradeIndex === undefined) return;
        if (this.options.onTrade) {
          this.options.onTrade(trade.tradeIndex);
        } else {
          const dismiss = group.members.length > 1 && group.members.includes(this.pinned);
          this.pin(dismiss ? null : trade);
        }
      });
      this.container.addEventListener("pointerleave", (event) => {
        if (!options.price && event.pointerType === "mouse") {
          if (this.tooltip.contains(document.activeElement)) this.canvas.focus({preventScroll: true});
          this.pin(null);
          return;
        }
        if (!this.tooltip.contains(document.activeElement)) this.select(this.pinned);
      });
      this.container.addEventListener("focusout", (event) => {
        if (!this.container.contains(event.relatedTarget)) this.select(this.pinned);
      });
      this.canvas.addEventListener("keydown", (event) => this.navigate(event));
      this.openButton.addEventListener("click", () => this.openPosition(this.selected));
      this.tooltip.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        this.canvas.focus({preventScroll: true});
        this.pin(null);
      });
      if (!options.price) {
        document.addEventListener("pointerdown", (event) => {
          if (this.pinned && !container.contains(event.target) && !event.target.closest("dialog[open]")) this.pin(null);
        });
      }
      new ResizeObserver(() => this.draw()).observe(this.canvas);
    }

    setData(points, markers, after, days, fullPriceScale = false, hiddenKinds = new Set(), alertTarget) {
      this.selected = null;
      this.pinned = null;
      this.tooltip.hidden = true;
      this.listMembers = null;
      this.tradeList.replaceChildren();
      let first = points[0]?.[0] ?? Infinity;
      let last = points.at(-1)?.[0] ?? -Infinity;
      for (const marker of markers) {
        first = Math.min(first, marker.time);
        last = Math.max(last, marker.time);
      }
      const floor = days ? Math.max(first, last - days * day) : first;
      const firstVisibleIndex = points.findIndex(([time]) => time >= floor);
      this.points = firstVisibleIndex < 0 ? [] : points.slice(firstVisibleIndex);
      const interpolateStart = firstVisibleIndex > 0 && points[firstVisibleIndex][0] > floor;
      if (interpolateStart) {
        this.points.unshift([floor, valueOnLine(points, floor)]);
      }
      this.markers = markers.filter(({time, kind}) => time >= floor && !hiddenKinds.has(kind));
      this.markerLineValues = new Map();
      for (const marker of this.markers) {
        if (marker.tradeIndex === undefined) continue;
        let value = valueOnLine(points, marker.time);
        if (value === undefined && !this.options.price && points.length) {
          value = marker.time < points[0][0] ? points[0][1] : points.at(-1)[1];
        }
        if (value !== undefined) this.markerLineValues.set(marker, value);
      }
      const observations = this.points.map(([time, value]) => ({time, value,
        detail: interpolateStart && time === floor ? "Interpolated" : undefined}));
      this.observations = [...observations, ...this.markers].sort((a, b) => a.time - b.time);
      this.start = floor === last ? floor - day / 2 : floor;
      this.end = floor === last ? last + day / 2 : last;
      this.singleTime = floor === last;
      this.after = after;
      this.alertTarget = alertTarget;
      this.fullPriceScale = fullPriceScale;
      this.draw();
    }

    draw() {
      const {canvas, context: ctx, points, markers, options} = this;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (!width || !height || !this.observations.length || !ctx) return;
      const scale = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.font = "11px system-ui, sans-serif";
      const markerValues = markers.map((marker) => this.plottedValue(marker));
      if (Number.isFinite(this.alertTarget)) markerValues.push(this.alertTarget);
      const axis = axisBounds(points, markerValues, options.price, this.fullPriceScale);
      const labels = [];
      for (let value = axis.min; value <= axis.max + axis.step / 100; value += axis.step) {
        labels.push([value, options.tick(value)]);
      }
      const left = Math.max(...labels.map(([, label]) => ctx.measureText(label).width)) + 11;
      const right = width - 12;
      const top = 13;
      const bottom = height - 26;
      if (left >= right) return;
      const x = (time) => left + (time - this.start) / (this.end - this.start) * (right - left);
      const y = (value) => bottom - (value - axis.min) / (axis.max - axis.min) * (bottom - top);
      this.plot = {x, y, top, bottom, left, right};

      if (this.after >= this.start && this.after < this.end) {
        const divider = x(this.after);
        ctx.fillStyle = "rgba(255, 189, 131, .055)";
        ctx.fillRect(divider, top, right - divider, bottom - top);
        ctx.strokeStyle = "rgba(255, 189, 131, .5)";
        ctx.setLineDash([4, 4]);
        this.line(divider, top, divider, bottom);
        ctx.setLineDash([]);
      }

      ctx.textBaseline = "middle";
      ctx.textAlign = "right";
      for (const [value, label] of labels) {
        ctx.fillStyle = colors.label;
        ctx.fillText(label, left - 9, y(value));
        ctx.strokeStyle = !options.price && Math.abs(value) < axis.step / 100 ? "#49536a" : colors.grid;
        this.line(left, y(value), right, y(value));
      }
      if (Number.isFinite(this.alertTarget)) {
        ctx.strokeStyle = "#ffbd83";
        ctx.setLineDash([5, 5]);
        this.line(left, y(this.alertTarget), right, y(this.alertTarget));
        ctx.setLineDash([]);
      }
      ctx.fillStyle = colors.label;
      const dateFormat = this.end - this.start > 365 * day ? monthYear : shortDate;
      const divisions = width < 400 ? 2 : 4;
      for (let index = 0; !this.singleTime && index <= divisions; index++) {
        ctx.textAlign = index === 0 ? "left" : index === divisions ? "right" : "center";
        const time = this.start + (this.end - this.start) * index / divisions;
        ctx.fillText(dateFormat.format(time * 1000), x(time), bottom + 14);
      }
      if (this.singleTime) {
        ctx.textAlign = "center";
        const time = (this.start + this.end) / 2;
        ctx.fillText(dateFormat.format(time * 1000), x(time), bottom + 14);
      }

      if (points.length > 1) {
        ctx.beginPath();
        for (const [time, value] of points) ctx.lineTo(x(time), y(value));
        ctx.strokeStyle = colors.line;
        ctx.lineWidth = 2;
        ctx.lineJoin = "round";
        ctx.stroke();
        ctx.lineTo(x(points.at(-1)[0]), bottom);
        ctx.lineTo(x(points[0][0]), bottom);
        ctx.closePath();
        const area = ctx.createLinearGradient(0, top, 0, bottom);
        area.addColorStop(0, "rgba(160, 180, 255, .18)");
        area.addColorStop(1, "rgba(160, 180, 255, .012)");
        ctx.fillStyle = area;
        ctx.fill();
        ctx.lineWidth = 1;
      } else if (points.length) {
        const [[time, value]] = points;
        this.dot(x(time), y(value), colors.line, 3);
      }

      this.markerGroups = [];
      for (const marker of markers) {
        const position = {x: x(marker.time), y: y(this.plottedValue(marker))};
        const group = this.markerGroups.at(-1);
        if (!options.price && group && Math.hypot(position.x - group.x, position.y - group.y) < 13) {
          group.members.push(marker);
        } else {
          this.markerGroups.push({...position, members: [marker]});
        }
      }
      const cluster = this.markerGroups.find(({members}) => members.length > 1 && members.includes(this.selected));
      for (const group of this.markerGroups) {
        if (group.members.includes(this.selected)) continue;
        if (group.members.length > 1) this.drawCluster(group);
        else this.drawMarker(group.members[0], group.members[0] === this.pinned);
      }

      if (this.selected) {
        const mx = cluster?.x ?? x(this.selected.time);
        const my = cluster?.y ?? y(this.plottedValue(this.selected));
        ctx.strokeStyle = "#7c8ab0";
        ctx.setLineDash([3, 4]);
        this.line(mx, top, mx, bottom);
        ctx.setLineDash([]);
        if (cluster) this.drawCluster(cluster, true);
        else if (this.selected.kind) this.drawMarker(this.selected, true);
        else this.dot(mx, my, colors.line, 5);
        this.renderTooltip(this.selected, cluster);
        this.positionTooltip(mx, my, Boolean(cluster || this.selected.position));
      }
    }

    line(ax, ay, bx, by) {
      const ctx = this.context;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }

    fillMarker(color) {
      const ctx = this.context;
      ctx.strokeStyle = colors.background;
      ctx.lineWidth = 1.5;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    dot(x, y, color, radius) {
      this.context.beginPath();
      this.context.arc(x, y, radius, 0, Math.PI * 2);
      this.fillMarker(color);
    }

    plottedValue(point) {
      return this.markerLineValues.get(point) ?? point.value;
    }

    drawMarker(marker, active) {
      const ctx = this.context;
      const x = this.plot.x(marker.time);
      const y = this.plot.y(this.plottedValue(marker));
      const color = colors[marker.kind];
      const size = marker.tradeIndex === undefined ? 4 : 5.5;
      if (active) {
        ctx.beginPath();
        ctx.arc(x, y, size + 3, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.stroke();
      }
      if (marker.kind === "sell") {
        ctx.beginPath();
        ctx.moveTo(x, y - size - 1);
        ctx.lineTo(x + size + 1, y);
        ctx.lineTo(x, y + size + 1);
        ctx.lineTo(x - size - 1, y);
        ctx.closePath();
        this.fillMarker(color);
      } else if (marker.kind === "won" || marker.kind === "lost") {
        ctx.beginPath();
        ctx.roundRect(x - size, y - size, 2 * size, 2 * size, 2);
        this.fillMarker(color);
      } else {
        this.dot(x, y, color, size);
        if (marker.kind === "deposit") {
          ctx.strokeStyle = colors.background;
          this.line(x - 2.5, y, x + 2.5, y);
          this.line(x, y - 2.5, x, y + 2.5);
        }
      }
    }

    drawCluster({x, y, members}, active = false) {
      const ctx = this.context;
      const kind = members[0].kind;
      const color = members.every((marker) => marker.kind === kind) ? colors[kind] : colors.line;
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, 8.5, 0, Math.PI * 2);
      ctx.fillStyle = colors.background;
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = active ? 2 : 1;
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = "600 9px system-ui";
      ctx.fillText(members.length > 99 ? "99+" : String(members.length), x, y);
      ctx.restore();
    }

    pin(marker) {
      this.pinned = marker;
      this.select(marker, true);
    }

    openPosition(marker) {
      if (!marker?.position || !this.options.onOpenPosition) return;
      this.pin(marker);
      this.options.onOpenPosition(marker);
    }

    select(point, announce = false) {
      if (point === this.selected && !announce) return;
      this.selected = point;
      this.tooltip.hidden = !point;
      this.draw();
      if (point && announce) this.announcement.textContent = this.tooltipText;
    }

    renderTooltip(point, cluster) {
      const timelineItem = point.priceLabel !== undefined;
      const price = point.priceLabel ?? this.options.value(point.value);
      const title = (point.label || this.options.label) + " · " + price;
      const format = timelineItem ? executionTime : this.options.price ? dateTime : fullDate;
      const date = format.format(point.time * 1000);
      const detail = [date, point.detail];
      if (this.options.price && point.tradeIndex !== undefined) {
        const lineValue = this.markerLineValues.get(point);
        if (lineValue !== undefined) {
          const linePrice = this.options.value(lineValue);
          if (linePrice !== price) detail.push("Chart " + linePrice);
        } else if (this.points.length) {
          detail.push("Outside market history");
        }
      }
      const description = detail.filter(Boolean).join(" · ");
      const onlyTrades = cluster?.members.every(({kind}) => kind === "buy" || kind === "sell");
      const counter = cluster ? `${cluster.members.length} ${onlyTrades ? "trades" : "events"}` : "";
      this.tooltip.classList.toggle("is-cluster", Boolean(cluster));
      const actionable = Boolean(!cluster && point.position && this.options.onOpenPosition);
      this.tooltip.classList.toggle("is-actionable", actionable);
      this.openButton.hidden = !actionable;
      this.tooltip.firstElementChild.textContent = counter || title;
      const market = this.tooltip.querySelector(".chart-tooltip-market");
      market.textContent = point.market || "";
      market.hidden = Boolean(cluster) || !point.market;
      const timestamp = this.tooltip.querySelector(".chart-tooltip-time");
      const commonDate = cluster ? fullDate.format(cluster.members[0].time * 1000) : date;
      const sameDay = !cluster || commonDate === fullDate.format(cluster.members.at(-1).time * 1000);
      timestamp.textContent = commonDate;
      timestamp.hidden = !timelineItem || !sameDay;
      const tooltipDetail = this.tooltip.querySelector(".chart-tooltip-detail");
      tooltipDetail.textContent = timelineItem ? point.detail || "" : description;
      tooltipDetail.hidden = Boolean(cluster) || !tooltipDetail.textContent;
      this.tradeList.hidden = !cluster;
      if (cluster) this.renderTradeList(cluster.members, sameDay ? timeOnly : dateTime);
      this.tooltipText = [counter, title, point.market, description].filter(Boolean).join(". ");
    }

    renderTradeList(members, format) {
      if (this.listMembers?.length === members.length &&
          members.every((member, index) => member === this.listMembers[index])) return;
      this.listMembers = members;
      const rows = document.createDocumentFragment();
      for (const trade of members) {
        const row = document.createElement("li");
        row.className = "legend-" + trade.kind;
        const actionable = trade.position && this.options.onOpenPosition;
        const content = document.createElement(actionable ? "button" : "div");
        content.className = "chart-trade-row";
        if (actionable) {
          content.type = "button";
          content.setAttribute("aria-haspopup", "dialog");
          content.addEventListener("click", () => this.openPosition(trade));
        }
        const action = document.createElement("strong");
        action.textContent = trade.label;
        if (actionable) {
          const arrow = document.createElement("span");
          arrow.className = "chart-trade-chevron";
          arrow.setAttribute("aria-hidden", "true");
          arrow.textContent = "›";
          action.append(arrow);
        }
        const price = document.createElement("span");
        price.className = "chart-trade-price";
        price.textContent = trade.priceLabel;
        const market = document.createElement("span");
        market.className = "chart-trade-market";
        market.textContent = trade.market || "";
        const time = document.createElement("time");
        const stamp = new Date(trade.time * 1000);
        time.dateTime = stamp.toISOString();
        time.textContent = format.format(stamp);
        content.append(action, price, market, time);
        row.append(content);
        rows.append(row);
      }
      this.tradeList.replaceChildren(rows);
      this.tradeList.scrollTop = 0;
    }

    positionTooltip(x, y, interactive) {
      const tip = this.tooltip;
      const maxLeft = this.canvas.clientWidth - tip.offsetWidth;
      const height = this.canvas.clientHeight;
      const gap = 12;
      const spaceRight = x + gap <= maxLeft;
      const spaceLeft = x >= tip.offsetWidth + gap;
      const beside = spaceLeft || spaceRight;
      const above = y > height / 2;
      if (interactive && !this.tradeList.hidden) {
        const room = beside ? height : (above ? y : height - y) - gap;
        const header = tip.offsetHeight - this.tradeList.offsetHeight;
        this.tradeList.style.setProperty("--trade-list-limit", Math.max(30, room - header) + "px");
      } else {
        this.tradeList.style.removeProperty("--trade-list-limit");
      }
      let left = spaceRight ? x + gap : x - gap - tip.offsetWidth;
      let top = y - tip.offsetHeight - 10;
      if (interactive) {
        if (beside) {
          top = y - tip.offsetHeight / 2;
        } else {
          left = x - tip.offsetWidth / 2;
          top = above ? y - tip.offsetHeight - gap : y + gap;
        }
      }
      tip.style.left = Math.max(0, Math.min(left, maxLeft)) + "px";
      tip.style.top = Math.max(0, Math.min(top, height - tip.offsetHeight)) + "px";
    }

    pointAt(event) {
      if (!this.plot || !this.observations.length) return;
      const rect = this.canvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const {x, left, right} = this.plot;
      if (px < left - 8 || px > right + 8) return this.select(this.pinned);
      const group = this.markerGroupAt(px, py);
      if (group) return this.select(group.members.includes(this.pinned) ? this.pinned : group.members[0]);
      if (!this.points.length) return this.select(this.pinned);
      let best;
      let distance = Infinity;
      for (const point of this.observations) {
        const delta = Math.abs(x(point.time) - px);
        if (delta < distance) {
          best = point;
          distance = delta;
        }
      }
      this.select(best || this.pinned);
    }

    markerGroupAt(px, py) {
      let nearest;
      let distance = 16;
      for (const group of this.markerGroups || []) {
        const delta = Math.hypot(group.x - px, group.y - py);
        if (delta < distance) {
          nearest = group;
          distance = delta;
        }
      }
      return nearest;
    }

    navigate(event) {
      if (!this.observations.length) return;
      if (event.key === "Escape" && this.selected && !this.options.price) {
        event.preventDefault();
        this.pin(null);
        return;
      }
      if ((event.key === "Enter" || event.key === " ") && this.selected?.tradeIndex !== undefined) {
        event.preventDefault();
        if (this.options.onTrade) this.options.onTrade(this.selected.tradeIndex);
        else this.pin(this.selected);
        return;
      }
      const keys = {Home: 0, End: this.observations.length - 1};
      const current = this.observations.indexOf(this.selected);
      if (event.key === "ArrowLeft") keys.ArrowLeft = current < 0 ? this.observations.length - 1 : current - 1;
      if (event.key === "ArrowRight") keys.ArrowRight = current + 1;
      if (!(event.key in keys)) return;
      event.preventDefault();
      const index = Math.min(this.observations.length - 1, Math.max(0, keys[event.key]));
      this.select(this.observations[index], true);
    }
  };
})();
