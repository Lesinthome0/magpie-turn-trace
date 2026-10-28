const $ = (id) => document.getElementById(id);
const VIEW_KEY = "magpie-turn-trace:view";
const REFRESH_KEY = "magpie-turn-trace:refresh";
const PERIOD_KEY = "magpie-turn-trace:period";
const TURN_GAP_SECONDS = 120;
const SVG_NS = "http://www.w3.org/2000/svg";
const SERIES_COLORS = ["var(--c1)", "var(--c3)", "var(--c4)", "var(--c5)", "var(--c6)", "var(--c2)", "var(--c7)"];
const COMPOSITION_ORDER = ["system", "tools", "skills", "memory", "files", "results", "chat"];
const COMPOSITION_META = {
  system: { label: "系统提示词", color: "var(--c6)" },
  tools: { label: "工具定义", color: "var(--c2)" },
  skills: { label: "技能注入", color: "var(--c4)" },
  memory: { label: "注入内容", color: "var(--c5)" },
  files: { label: "文件", color: "var(--c3)" },
  results: { label: "工具结果", color: "#ea580c" },
  chat: { label: "会话内容", color: "var(--c1)" },
};

const RANKING_META = {
  total: { label: "合计", color: "var(--accent)" },
  uncachedInput: { label: "输入", color: "var(--c2)" },
  output: { label: "输出", color: "var(--c3)" },
  cacheRead: { label: "缓存", color: "var(--c1)" },
};
const RANKING_KEYS = Object.keys(RANKING_META);

const state = {
  offset: 0,
  limit: 2000,
  rows: [],
  total: null,
  summary: null,
  loading: false,
  composition: null,
  refreshSeconds: 5,
  refreshTimer: 0,
  period: "today",
  customFrom: "",
  customTo: "",
  contextBySession: new Map(),
  expandedSessions: new Set(),
  expandedTurns: new Set(),
  view: "list",
  rankingScope: "session",
  rankingMetric: "total",
  rankingExpanded: false,
  focusCategory: null,
  lastSessions: [],
  lastTurns: [],
  lastTotals: null,
};

const candidates = {
  time: ["t", "time", "timestamp", "created_at", "createdAt", "at"],
  agent: ["agent", "agent_name", "agentName"],
  provider: ["provider", "provider_name", "providerName"],
  model: ["model", "model_id", "modelId"],
  input: ["in", "input", "input_tokens", "inputTokens", "prompt_tokens", "promptTokens"],
  output: ["out", "output", "output_tokens", "outputTokens", "completion_tokens", "completionTokens"],
  cacheRead: ["cache_read", "cacheRead", "cache_read_tokens", "cached_tokens"],
  cacheWrite: ["cache_write", "cacheWrite", "cache_write_tokens"],
  reasoning: ["reasoning", "reasoning_tokens", "reasoningTokens"],
  cost: ["cost", "cost_usd", "costUSD", "usd"],
  ms: ["ms", "duration_ms", "durationMs", "elapsed_ms"],
  ttft: ["ttft_ms", "ttftMs", "first_text_ms", "firstTextMs"],
  status: ["status", "status_code", "statusCode"],
  error: ["err", "error", "error_type", "errorType"],
  session: ["session", "session_id", "sessionId", "native_session", "nativeSession"],
  rid: ["rid", "request_id", "requestId", "id", "response_id", "responseId"],
  purpose: ["purpose"],
  retried: ["retried"],
  handedOn: ["handed_on", "handedOn"],
  tries: ["tries"],
  effort: ["effort"],
  tierAsked: ["tier_asked", "tierAsked"],
  tierSent: ["tier_sent", "tierSent"],
  tierServed: ["tier_served", "tierServed"],
  account: ["account", "account_name", "accountName", "providerAccount"],
  callerKey: ["callerKey", "caller_key", "providerKeyName", "provider_key_name"],
  parentAgent: ["parent_agent", "parentAgent"],
  subagent: ["subagent"],
  sessionRole: ["session_role", "sessionRole"],
};

function val(row, field) {
  for (const key of candidates[field] || [field]) {
    if (row?.[key] !== undefined && row[key] !== null && row[key] !== "") return row[key];
  }
  return null;
}

function num(row, field) {
  const value = Number(val(row, field));
  return Number.isFinite(value) ? value : 0;
}

function firstNumeric(object, names) {
  for (const name of names) {
    if (object?.[name] !== undefined && object[name] !== null && Number.isFinite(Number(object[name]))) {
      return Number(object[name]);
    }
  }
  return null;
}

function fmtExact(value) {
  return Number(value || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function fmtCompact(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  const absolute = Math.abs(number);
  if (absolute >= 1e9) return `${(number / 1e9).toFixed(2)}B`;
  if (absolute >= 1e6) return `${(number / 1e6).toFixed(2)}M`;
  if (absolute >= 1e3) return `${(number / 1e3).toFixed(2)}K`;
  return fmtExact(number);
}

function fmtPercent(value, digits = 1) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(digits)}%` : "—";
}

function fmtCost(value) {
  if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) return "未记录";
  const number = Number(value);
  if (number === 0) return "$0.00000";
  if (number < 0.01) return `$${number.toFixed(5)}`;
  return `$${number.toFixed(2)}`;
}

function fmtMs(value) {
  if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) || Number(value) <= 0) {
    return "—";
  }
  const ms = Number(value);
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

function fmtTime(ms) {
  if (!ms) return "时间未知";
  return new Date(ms).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function shortId(value, head = 8, tail = 6) {
  const text = String(value || "");
  if (!text) return "—";
  return text.length > head + tail + 3 ? `${text.slice(0, head)}...${text.slice(-tail)}` : text;
}

function shortPath(value, length = 58) {
  const text = String(value || "");
  if (!text) return "—";
  if (text.length <= length) return text;
  return `...${text.slice(-(length - 3))}`;
}

function parsedTime(row) {
  const raw = val(row, "time");
  if (raw === null || raw === undefined) return 0;
  const time = typeof raw === "number" ? (raw < 1e12 ? raw * 1000 : raw) : Date.parse(String(raw));
  return Number.isFinite(time) ? time : 0;
}

function asRows(data) {
  if (Array.isArray(data)) return data;
  for (const key of ["requests", "rows", "items", "results", "records"]) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.data?.requests)) return data.data.requests;
  if (Array.isArray(data?.data?.rows)) return data.data.rows;
  return [];
}

function getTotal(data) {
  for (const object of [data, data?.meta, data?.pagination, data?.data]) {
    for (const key of ["total", "totalCount", "total_count", "count"]) {
      if (Number.isFinite(Number(object?.[key]))) return Number(object[key]);
    }
  }
  return null;
}

function isFailure(row) {
  const status = Number(val(row, "status"));
  return !!val(row, "error") || (Number.isFinite(status) && status >= 400);
}

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function svgNode(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function metricsForRow(row) {
  const uncachedInput = num(row, "input");
  const cacheRead = num(row, "cacheRead");
  const cacheWrite = num(row, "cacheWrite");
  const output = num(row, "output");
  const reasoning = num(row, "reasoning");
  const inputTotal = uncachedInput + cacheRead + cacheWrite;
  const total = inputTotal + output;
  return {
    uncachedInput,
    cacheRead,
    cacheWrite,
    inputTotal,
    output,
    reasoning,
    total,
    cacheHit: inputTotal > 0 ? (cacheRead / inputTotal) * 100 : null,
  };
}

function aggregateMetrics(rows) {
  const total = {
    uncachedInput: 0,
    cacheRead: 0,
    cacheWrite: 0,
    inputTotal: 0,
    output: 0,
    reasoning: 0,
    total: 0,
    cacheHit: null,
    calls: rows.length,
    errors: 0,
    cost: 0,
    unpriced: 0,
  };
  for (const row of rows) {
    const item = row._metrics || metricsForRow(row);
    total.uncachedInput += item.uncachedInput;
    total.cacheRead += item.cacheRead;
    total.cacheWrite += item.cacheWrite;
    total.inputTotal += item.inputTotal;
    total.output += item.output;
    total.reasoning += item.reasoning;
    total.total += item.total;
    total.cost += num(row, "cost");
    if (isFailure(row)) total.errors += 1;
    if (val(row, "cost") === null) total.unpriced += 1;
  }
  total.cacheHit = total.inputTotal > 0 ? (total.cacheRead / total.inputTotal) * 100 : null;
  return total;
}

function summaryTotals(summary, rows) {
  const source = summary?.summary || summary?.totals || summary?.data || summary || {};
  const fallback = aggregateMetrics(rows);
  const uncachedInput = firstNumeric(source, ["input", "input_tokens", "inputTokens"]) ?? fallback.uncachedInput;
  const cacheRead = firstNumeric(source, ["cache_read", "cacheRead", "cached_tokens"]) ?? fallback.cacheRead;
  const cacheWrite = firstNumeric(source, ["cache_write", "cacheWrite"]) ?? fallback.cacheWrite;
  const output = firstNumeric(source, ["output", "output_tokens", "outputTokens"]) ?? fallback.output;
  const reasoning = firstNumeric(source, ["reasoning", "reasoning_tokens", "reasoningTokens"]) ?? fallback.reasoning;
  const calls = firstNumeric(source, ["calls", "requests", "total_calls", "totalCalls"]) ?? fallback.calls;
  const errors = firstNumeric(source, ["errors", "failed", "total_errors", "totalErrors"]) ?? fallback.errors;
  const cost = firstNumeric(source, ["cost", "total_cost", "totalCost", "usd"]) ?? fallback.cost;
  const unpriced = firstNumeric(source, ["unpriced"]) ?? fallback.unpriced;
  const inputTotal = uncachedInput + cacheRead + cacheWrite;
  return {
    uncachedInput,
    cacheRead,
    cacheWrite,
    inputTotal,
    output,
    reasoning,
    total: inputTotal + output,
    cacheHit: inputTotal > 0 ? (cacheRead / inputTotal) * 100 : null,
    calls,
    errors,
    cost,
    unpriced,
  };
}

function normalizeRow(row) {
  return {
    ...row,
    _time: parsedTime(row),
    _metrics: metricsForRow(row),
    _context: null,
    _turnId: "",
    _precise: false,
    _activity: null,
  };
}

async function api(url) {
  const response = await fetch(url, { cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || body.message || `HTTP ${response.status}`);
  if (body?.error && !Array.isArray(body?.requests) && !Array.isArray(body?.rows) && !Array.isArray(body?.data)) {
    throw new Error(`${body.error}${body.hint ? `\n${body.hint}` : ""}`);
  }
  return body;
}

function showError(message) {
  $("error").hidden = !message;
  $("error").textContent = message || "";
}

function reqQuery(offset = 0) {
  const params = new URLSearchParams({
    period: state.period,
    offset: String(offset),
    limit: String(state.limit),
  });
  return params.toString();
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function periodBounds() {
  if (state.period === "all") return null;
  const today = new Date();
  if (state.period === "custom") {
    if (!state.customFrom || !state.customTo) return null;
    return { from: state.customFrom, to: state.customTo };
  }
  const days = state.period === "7d" ? 7 : state.period === "30d" ? 30 : 1;
  const fromDate = new Date(today);
  fromDate.setDate(fromDate.getDate() - (days - 1));
  return { from: localDateKey(fromDate), to: localDateKey(today) };
}

function rangeQuery(offset = 0) {
  const bounds = periodBounds();
  if (!bounds) return "";
  return new URLSearchParams({
    from: bounds.from,
    to: bounds.to,
    offset: String(offset),
    limit: String(state.limit),
  }).toString();
}

function inRequestedRange(row) {
  if (state.period !== "custom") return true;
  if (!row._time) return false;
  if (state.customFrom) {
    const start = new Date(`${state.customFrom}T00:00:00`);
    if (row._time < start.getTime()) return false;
  }
  if (state.customTo) {
    const end = new Date(`${state.customTo}T23:59:59.999`);
    if (row._time > end.getTime()) return false;
  }
  return true;
}

function validSessionId(value) {
  return /^[A-Za-z0-9_.:-]{8,180}$/.test(String(value || ""));
}

function closestContext(row) {
  const meta = state.contextBySession.get(String(val(row, "session") || ""));
  const events = Array.isArray(meta?.events) ? meta.events : [];
  if (!row._time || !events.length) return { context: null, turnId: "", precise: false };
  let best = null;
  let bestDelta = Infinity;
  let exactTotal = null;
  let exactDelta = Infinity;
  const rowTotal = Number(row._metrics?.total) || 0;
  for (const event of events) {
    const eventTime = Number(event.time);
    if (!Number.isFinite(eventTime)) continue;
    const delta = Math.abs(eventTime - row._time);
    if (rowTotal > 0 && Math.abs(Number(event.totalTokens) - rowTotal) <= 1 && delta < exactDelta) {
      exactTotal = event;
      exactDelta = delta;
    }
    if (delta < bestDelta) {
      best = event;
      bestDelta = delta;
    }
  }
  if (exactTotal) {
    best = exactTotal;
    bestDelta = exactDelta;
  }
  if (!best) return { context: null, turnId: "", precise: false };
  return {
    context: bestDelta <= 5 * 60 * 1000 ? best : null,
    turnId: bestDelta <= 60 * 1000 && best.turnId ? best.turnId : "",
    precise: bestDelta <= 60 * 1000 && !!best.turnId,
  };
}

async function loadContexts(rows) {
  const sessions = [...new Set(rows.map((row) => String(val(row, "session") || "")).filter(validSessionId))];
  const results = await Promise.all(
    sessions.map(async (session) => {
      try {
        return [session, await api(`/api/context?session=${encodeURIComponent(session)}`)];
      } catch {
        return [session, { events: [], activityByTurn: {} }];
      }
    }),
  );
  state.contextBySession = new Map(results);
  for (const row of rows) {
    const meta = state.contextBySession.get(String(val(row, "session") || "")) || {};
    const match = closestContext(row);
    row._context = match.context;
    row._turnId = match.turnId;
    row._precise = match.precise;
    row._activity = row._turnId ? meta.activityByTurn?.[row._turnId] || null : null;
  }
}

function latestContext(rows, includeGlobal = false) {
  let latest = null;
  for (const row of rows) {
    if (row._context && (!latest || row._context.time > latest.time)) latest = row._context;
  }
  if (latest) return latest;
  if (includeGlobal) {
    for (const meta of state.contextBySession.values()) {
      for (const event of meta.events || []) {
        if (!latest || event.time > latest.time) latest = event;
      }
    }
  }
  return latest;
}

function contextPercent(context) {
  if (!context || !Number(context.contextWindow)) return null;
  return Math.min(100, Math.max(0, (Number(context.totalTokens) / Number(context.contextWindow)) * 100));
}

function contextDisplay(context, approximate = false) {
  const percent = contextPercent(context);
  if (percent === null) return "—";
  return `${approximate ? "~" : ""}${fmtPercent(percent)}`;
}

function contextLabel(context, compact = true) {
  if (!context || !Number(context.contextWindow)) return "—";
  const used = Number(context.totalTokens) || 0;
  const window = Number(context.contextWindow) || 0;
  return `${compact ? fmtCompact(used) : fmtExact(used)} / ${compact ? fmtCompact(window) : fmtExact(window)}`;
}

function periodLabel() {
  if (state.period === "custom") return `${state.customFrom || "…"} → ${state.customTo || "…"}`;
  return ({ today: "今天", "7d": "最近 7 天", "30d": "最近 30 天", all: "全部时间" })[state.period] || "今天";
}

function mergeActivity(target, source) {
  if (!source) return target;
  target.tools ||= {};
  target.files ||= {};
  for (const [name, count] of Object.entries(source.tools || {})) {
    target.tools[name] = (target.tools[name] || 0) + (Number(count) || 0);
  }
  for (const [filePath, info] of Object.entries(source.files || {})) {
    const item = target.files[filePath] || { count: 0, operations: [] };
    item.count += Number(info?.count) || 0;
    for (const operation of info?.operations || []) {
      if (!item.operations.includes(operation)) item.operations.push(operation);
    }
    target.files[filePath] = item;
  }
  return target;
}

function aggregateActivity(turns) {
  const activity = { tools: {}, files: {} };
  for (const turn of turns) mergeActivity(activity, turn.activity);
  return activity;
}

function renderSummary(summary, rows, sessions = [], turns = []) {
  const scopedRows = rows.filter(inRequestedRange);
  const totals = summaryTotals(summary, scopedRows);
  state.lastTotals = totals;
  const context = latestContext(scopedRows, true);
  const contextValue = contextPercent(context);

  const headlineTotal = totals.total;
  $("metric-tokens").textContent = fmtCompact(headlineTotal);
  $("metric-tokens-exact").textContent = `${fmtExact(headlineTotal)} tokens`;
  $("metric-tokens-note").textContent = `输入 ${fmtCompact(totals.uncachedInput)} · 输出 ${fmtCompact(totals.output)} · 缓存 ${fmtCompact(totals.cacheRead)}`;
  $("metric-calls").textContent = fmtExact(totals.calls);
  $("metric-period").textContent = periodLabel();
  $("metric-errors").textContent = `${fmtExact(sessions.length)} 会话 · ${fmtExact(turns.length)} 轮次 · ${fmtExact(totals.errors)} 错误`;
  $("metric-cache").textContent = fmtPercent(totals.cacheHit);
  $("metric-cache-detail").textContent = `读取 ${fmtCompact(totals.cacheRead)} / 输入 ${fmtCompact(totals.inputTotal)}`;
  $("metric-context").textContent = fmtPercent(contextValue);
  $("metric-context-detail").textContent = context ? `${contextLabel(context)} · 最近请求` : "等待 Codex 会话记录";
  $("metric-cost").textContent = fmtCost(totals.cost);
  $("metric-cost-note").textContent = totals.unpriced > 0 ? `${fmtExact(totals.unpriced)} 条未定价` : "按 Magpie 记录汇总";

  $("cache-fill").style.width = `${Math.min(100, Math.max(0, totals.cacheHit || 0))}%`;
  $("context-fill").style.width = `${Math.min(100, Math.max(0, contextValue || 0))}%`;
  renderComposition(totals);
}

function compositionSegments(totals) {
  if (state.composition?.totals) {
    return COMPOSITION_ORDER
      .map((key) => ({
        key,
        label: COMPOSITION_META[key]?.label || key,
        value: Number(state.composition.totals[key]) || 0,
        color: COMPOSITION_META[key]?.color || "var(--c7)",
      }))
      .filter((segment) => segment.value > 0);
  }
  return [];
}

function categoryValue(metrics, category) {
  if (category === "total" || !category) return metrics.total;
  return Number(metrics[category]) || 0;
}

function categoryLabel(category) {
  return category === "total" ? "Token 合计" : RANKING_META[category]?.label || "Token";
}

function donutPath(startAngle, endAngle, innerRadius, outerRadius) {
  const point = (radius, angle) => {
    const radians = (angle - 90) * Math.PI / 180;
    return [21 + radius * Math.cos(radians), 21 + radius * Math.sin(radians)];
  };
  const [outerStartX, outerStartY] = point(outerRadius, startAngle);
  const [outerEndX, outerEndY] = point(outerRadius, endAngle);
  const [innerEndX, innerEndY] = point(innerRadius, endAngle);
  const [innerStartX, innerStartY] = point(innerRadius, startAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return [
    `M ${outerStartX} ${outerStartY}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${outerEndX} ${outerEndY}`,
    `L ${innerEndX} ${innerEndY}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerStartX} ${innerStartY}`,
    "Z",
  ].join(" ");
}

function renderComposition(totals) {
  const segments = compositionSegments(totals);
  // The request totals and prompt.parts totals have different accounting scopes.
  // Normalize the visual shares to the actual composition total, never above 100%.
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  const donut = $("composition-donut");
  donut.textContent = "";
  $("composition-total").textContent = fmtCompact(total);
  $("composition-total").title = `${fmtExact(total)} tokens`;
  $("composition-source").textContent = state.composition?.requests ? `${fmtExact(state.composition.requests)} 次 prompt` : "Magpie prompt";

  const svg = svgNode("svg", { viewBox: "0 0 42 42", class: `donut-svg${state.focusCategory ? " has-focus" : ""}`, "aria-hidden": "true" });
  svg.append(svgNode("circle", {
    cx: 21,
    cy: 21,
    r: 15,
    class: "donut-center-fill",
  }));
  let accumulated = 0;
  for (const segment of segments) {
    const pct = total > 0 ? (segment.value / total) * 100 : 0;
    segment.percent = pct;
    const startAngle = accumulated * 3.6;
    accumulated += pct;
    const endAngle = accumulated * 3.6;
    const path = svgNode("path", {
      d: donutPath(startAngle, endAngle, 13.4, 19),
      class: `donut-segment${state.focusCategory === segment.key ? " is-focused" : ""}${state.focusCategory && state.focusCategory !== segment.key ? " is-dimmed" : ""}`,
      fill: segment.color,
    });
    path.dataset.category = segment.key;
    path.addEventListener("mouseenter", (event) => {
      showCategoryTip(event, segment, total);
      setHoverCategory(segment.key);
    });
    path.addEventListener("mousemove", moveChartTooltip);
    path.addEventListener("mouseleave", () => {
      hideChartTooltip();
      setHoverCategory(null);
    });
    svg.append(path);
  }
  donut.append(svg);
  const center = make("div", "donut-center");
  center.append(make("b", "", fmtCompact(total)));
  center.append(make("span", "", "tokens"));
  donut.append(center);

  const legend = $("composition-legend");
  legend.textContent = "";
  for (const segment of segments) {
    const item = make("button", `legend-item${state.focusCategory === segment.key ? " is-focused" : ""}`);
    item.type = "button";
    item.dataset.category = segment.key;
    item.append(make("span", "legend-dot", ""));
    item.lastElementChild.style.background = segment.color;
    item.append(make("span", "legend-label", segment.label));
    item.append(make("b", "legend-value", fmtCompact(segment.value)));
    item.append(make("span", "legend-exact", fmtExact(segment.value)));
    item.append(make("span", "legend-percent", fmtPercent(segment.percent)));
    item.addEventListener("mouseenter", (event) => {
      showCategoryTip(event, segment, total);
      setHoverCategory(segment.key);
    });
    item.addEventListener("mousemove", moveChartTooltip);
    item.addEventListener("mouseleave", () => {
      hideChartTooltip();
      setHoverCategory(null);
    });
    legend.append(item);
  }

  const bar = $("composition-bar");
  bar.textContent = "";
  if (!segments.length) {
    bar.append(make("span", "composition-empty", "暂无数据"));
  } else {
    for (const segment of segments) {
      const part = make("button", `composition-segment${state.focusCategory === segment.key ? " is-focused" : ""}`);
      part.type = "button";
      part.style.width = `${(segment.value / Math.max(1, total)) * 100}%`;
      part.style.background = segment.color;
      part.dataset.category = segment.key;
      part.addEventListener("mouseenter", (event) => {
        showCategoryTip(event, segment, total);
        setHoverCategory(segment.key);
      });
      part.addEventListener("mousemove", moveChartTooltip);
      part.addEventListener("mouseleave", () => {
        hideChartTooltip();
        setHoverCategory(null);
      });
      bar.append(part);
    }
  }

  const details = $("composition-details");
  details.textContent = "";
  const compositionRows = segments.map((segment) => ({
    ...segment,
  }));
  for (const segment of compositionRows) {
    const row = make("button", `composition-detail${state.focusCategory === segment.key ? " is-focused" : ""}${state.focusCategory && state.focusCategory !== segment.key ? " is-dimmed" : ""}`);
    row.type = "button";
    row.dataset.category = segment.key;
    row.append(make("span", "composition-detail-label", segment.label));
    row.append(make("b", "composition-detail-value", fmtCompact(segment.value)));
    row.append(make("span", "composition-detail-exact", fmtExact(segment.value)));
    const track = make("span", "composition-detail-bar");
    const fill = make("i");
    fill.style.width = `${(segment.value / Math.max(1, total)) * 100}%`;
    fill.style.background = segment.color;
    track.append(fill);
    row.append(track);
    row.append(make("span", "composition-detail-percent", fmtPercent(segment.percent)));
    row.addEventListener("mouseenter", (event) => {
      showCategoryTip(event, segment, total);
      setHoverCategory(segment.key);
    });
    row.addEventListener("mousemove", moveChartTooltip);
    row.addEventListener("mouseleave", () => {
      hideChartTooltip();
      setHoverCategory(null);
    });
    details.append(row);
  }
}

function showCategoryTip(event, segment, total) {
  showChartTooltip(event, `${segment.label}\n${fmtCompact(segment.value)} · ${fmtExact(segment.value)} tokens\n${total ? fmtPercent((segment.value / total) * 100) : "—"}`);
}

function setHoverCategory(category) {
  if (state.focusCategory === category) return;
  state.focusCategory = category;
  const donut = $("composition-donut");
  donut.querySelectorAll(".donut-segment").forEach((segment) => {
    const key = segment.dataset.category;
    segment.classList.toggle("is-focused", key === category);
    segment.classList.toggle("is-dimmed", !!category && key !== category);
  });
  $("composition-details").querySelectorAll(".composition-detail").forEach((row) => {
    const key = row.dataset.category;
    row.classList.toggle("is-focused", key === category);
    row.classList.toggle("is-dimmed", !!category && key !== category);
  });
  $("composition-legend").querySelectorAll(".legend-item").forEach((row) => {
    const key = row.dataset.category;
    row.classList.toggle("is-focused", key === category);
  });
  $("composition-bar").querySelectorAll(".composition-segment").forEach((row) => {
    row.classList.toggle("is-focused", row.dataset.category === category);
  });
}

function showChartTooltip(event, text) {
  const tooltip = $("chart-tooltip");
  tooltip.textContent = text;
  tooltip.hidden = false;
  const x = Math.min(window.innerWidth - 290, Math.max(8, event.clientX + 14));
  const y = Math.min(window.innerHeight - 90, Math.max(8, event.clientY + 14));
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
}

function moveChartTooltip(event) {
  if (!$("chart-tooltip").hidden) showChartTooltip(event, $("chart-tooltip").textContent || "");
}

function hideChartTooltip() {
  $("chart-tooltip").hidden = true;
}

function buildTurns(rows) {
  const gapMs = TURN_GAP_SECONDS * 1000;
  const sorted = [...rows].sort((left, right) => left._time - right._time);
  const groups = [];
  const byTurn = new Map();
  for (const row of sorted) {
    const session = String(val(row, "session") || "");
    const turnId = row._turnId || "";
    let group = null;
    if (turnId) group = byTurn.get(`${session}|${turnId}`) || null;
    if (!group) {
      const last = groups[groups.length - 1];
      const sameSession = last && (last.session === session || (!last.session && !session));
      const withinGap = last && last.end && row._time && row._time - last.end <= gapMs && row._time >= last.end;
      if (last && sameSession && withinGap) group = last;
    }
    if (!group) {
      group = {
        key: turnId ? `turn:${session}:${turnId}` : `time:${session}:${row._time}`,
        start: row._time,
        end: row._time,
        rows: [],
        session,
        turnId,
        precise: !!turnId,
      };
      groups.push(group);
    }
    group.rows.push(row);
    group.start = Math.min(group.start || row._time, row._time);
    group.end = Math.max(group.end || row._time, row._time);
    if (!group.session && session) group.session = session;
    if (turnId) {
      group.turnId = turnId;
      group.precise = true;
      group.key = `turn:${session}:${turnId}`;
      byTurn.set(`${session}|${turnId}`, group);
    }
  }
  return groups
    .map((group) => {
      const meta = state.contextBySession.get(group.session) || {};
      const preciseRows = group.rows.filter((row) => row._precise).length;
    const metrics = aggregateMetrics(group.rows);
    metrics.parts = state.composition?.sessions?.[group.session] || {};
      const context = latestContext(group.rows, false);
      const models = [...new Set(group.rows.map((row) => [val(row, "provider"), val(row, "model")].filter(Boolean).join("/")).filter(Boolean))];
      return {
        ...group,
        ...meta,
        metrics,
        context,
        models,
        activity: group.turnId ? meta.activityByTurn?.[group.turnId] || null : null,
        preciseRows,
        estimatedRows: group.rows.length - preciseRows,
        mode: preciseRows === group.rows.length ? "precise" : preciseRows > 0 ? "mixed" : "estimated",
      };
    })
    .sort((left, right) => right.end - left.end);
}

function buildSessions(turns) {
  const bySession = new Map();
  for (const turn of turns) {
    const session = String(turn.session || "unknown");
    const meta = state.contextBySession.get(session) || {};
    let item = bySession.get(session);
    if (!item) {
      item = {
        key: `session:${session}`,
        session,
        title: meta.title || (session === "unknown" ? "未归属会话" : `会话 ${shortId(session)}`),
        cwd: meta.cwd || "",
        agent: val(turn.rows[0], "agent") || "",
        role: val(turn.rows[0], "sessionRole") || "",
        rows: [],
        turns: [],
        activity: { tools: {}, files: {} },
      };
      bySession.set(session, item);
    }
    item.rows.push(...turn.rows);
    item.turns.push(turn);
    mergeActivity(item.activity, turn.activity);
    if (!item.agent) item.agent = val(turn.rows[0], "agent") || "";
    if (!item.role) item.role = val(turn.rows[0], "sessionRole") || "";
    item.start = Math.min(item.start || turn.start, turn.start);
    item.end = Math.max(item.end || turn.end, turn.end);
  }
  return [...bySession.values()]
    .map((item) => {
      item.turns.sort((left, right) => right.end - left.end);
      item.metrics = aggregateMetrics(item.rows);
      item.metrics.parts = state.composition?.sessions?.[item.session] || {};
      item.context = latestContext(item.rows, false);
      item.models = [...new Set(item.turns.flatMap((turn) => turn.models))];
      item.preciseTurns = item.turns.filter((turn) => turn.mode === "precise").length;
      item.mixedTurns = item.turns.filter((turn) => turn.mode === "mixed").length;
      item.estimatedTurns = item.turns.filter((turn) => turn.mode === "estimated").length;
      return item;
    })
    .sort((left, right) => right.end - left.end);
}

function activitySummary(activity) {
  const tools = Object.entries(activity?.tools || {}).sort((a, b) => b[1] - a[1]);
  const files = Object.entries(activity?.files || {}).sort((a, b) => b[1].count - a[1].count);
  const skills = new Map();
  for (const [filePath, info] of files) {
    const match = filePath.match(/(?:^|[\\/])skills[\\/](?:\.system[\\/])?([^\\/]+)[\\/]SKILL\.md$/i);
    if (match) skills.set(match[1], (skills.get(match[1]) || 0) + info.count);
  }
  return { tools, files, skills: [...skills.entries()].sort((a, b) => b[1] - a[1]) };
}

function renderActivity(activity) {
  const { tools, files, skills } = activitySummary(activity);
  if (!tools.length && !files.length && !skills.length) return null;
  const wrap = make("div", "activity-grid");
  if (tools.length) {
    const panel = make("section", "activity-panel");
    panel.append(make("h4", "", "工具调用"));
    const list = make("div", "activity-list");
    for (const [name, count] of tools.slice(0, 10)) {
      const row = make("div", "activity-row");
      row.append(make("span", "activity-name", name));
      row.append(make("b", "", `×${fmtExact(count)}`));
      list.append(row);
    }
    panel.append(list);
    wrap.append(panel);
  }
  if (skills.length) {
    const panel = make("section", "activity-panel");
    panel.append(make("h4", "", "技能注入"));
    const list = make("div", "activity-list");
    for (const [name, count] of skills.slice(0, 10)) {
      const row = make("div", "activity-row");
      row.append(make("span", "activity-name", name));
      row.append(make("b", "", `×${fmtExact(count)}`));
      list.append(row);
    }
    panel.append(list);
    wrap.append(panel);
  }
  if (files.length) {
    const panel = make("section", "activity-panel");
    panel.append(make("h4", "", "文件活动"));
    const list = make("div", "activity-list");
    for (const [filePath, info] of files.slice(0, 12)) {
      const row = make("div", "activity-row file-row");
      const name = make("span", "activity-name", shortPath(filePath));
      name.title = filePath;
      row.append(name);
      row.append(make("span", "activity-ops", (info.operations || []).join(" · ")));
      row.append(make("b", "", `×${fmtExact(info.count)}`));
      list.append(row);
    }
    panel.append(list);
    wrap.append(panel);
  }
  return wrap;
}

function appendStat(parent, label, value, exact = "") {
  const cell = make("div", "call-stat");
  cell.append(make("b", "", value));
  cell.append(make("span", "", label));
  if (exact) cell.append(make("small", "", exact));
  parent.append(cell);
}

function appendKpi(parent, label, value, exact = "") {
  const cell = make("div", "kpi");
  cell.append(make("span", "kpi-label", label));
  cell.append(make("b", "kpi-value", value));
  if (exact) cell.append(make("small", "kpi-exact", exact));
  parent.append(cell);
}

function renderCall(row) {
  const item = make("details", "call");
  const summary = make("summary", "call-summary");
  const main = make("div", "call-main");
  const model = [val(row, "provider"), val(row, "model")].filter(Boolean).join("/") || "模型未知";
  main.append(make("b", "call-model", model));
  main.append(make("small", "call-meta", `${fmtTime(row._time)} · ${val(row, "agent") || "agent 未知"}`));
  summary.append(main);
  const metrics = row._metrics;
  appendStat(summary, "Token", fmtCompact(metrics.total), fmtExact(metrics.total));
  appendStat(summary, "输入", fmtCompact(metrics.uncachedInput), fmtExact(metrics.uncachedInput));
  appendStat(summary, "输出", fmtCompact(metrics.output), fmtExact(metrics.output));
  appendStat(summary, "缓存", fmtCompact(metrics.cacheRead), fmtExact(metrics.cacheRead));
  appendStat(summary, "费用", fmtCost(val(row, "cost")));
  appendStat(summary, "缓存命中", fmtPercent(metrics.cacheHit));
  appendStat(summary, "上下文", contextDisplay(row._context, !row._precise));
  appendStat(summary, "耗时", fmtMs(val(row, "ms")));
  appendStat(summary, "状态", statusLabel(row));
  item.append(summary);

  const body = make("div", "call-body");
  const kpis = make("div", "call-kpi-grid");
  appendKpi(kpis, "输入总量", fmtCompact(metrics.inputTotal), fmtExact(metrics.inputTotal));
  appendKpi(kpis, "未缓存输入", fmtCompact(metrics.uncachedInput), fmtExact(metrics.uncachedInput));
  appendKpi(kpis, "缓存读取", fmtCompact(metrics.cacheRead), fmtExact(metrics.cacheRead));
  appendKpi(kpis, "缓存写入", fmtCompact(metrics.cacheWrite), fmtExact(metrics.cacheWrite));
  appendKpi(kpis, "输出", fmtCompact(metrics.output), fmtExact(metrics.output));
  appendKpi(kpis, "推理（含于输出）", fmtCompact(metrics.reasoning), fmtExact(metrics.reasoning));
  appendKpi(kpis, "缓存命中率", fmtPercent(metrics.cacheHit));
  appendKpi(kpis, "上下文", contextDisplay(row._context, !row._precise), contextLabel(row._context));
  body.append(kpis);

  const fields = [
    ["请求时间", fmtTime(row._time)],
    ["请求 ID", val(row, "rid")],
    ["Session", val(row, "session")],
    ["Turn ID", row._turnId || "未匹配 Codex 记录"],
    ["归轮方式", row._precise ? "Codex turn ID" : "时间间隔估算"],
    ["Agent", val(row, "agent")],
    ["Provider", val(row, "provider")],
    ["模型", val(row, "model")],
    ["输入总量（含缓存）", `${fmtCompact(metrics.inputTotal)} / ${fmtExact(metrics.inputTotal)}`],
    ["未缓存输入", `${fmtCompact(metrics.uncachedInput)} / ${fmtExact(metrics.uncachedInput)}`],
    ["缓存读取", `${fmtCompact(metrics.cacheRead)} / ${fmtExact(metrics.cacheRead)}`],
    ["缓存写入", `${fmtCompact(metrics.cacheWrite)} / ${fmtExact(metrics.cacheWrite)}`],
    ["输出", `${fmtCompact(metrics.output)} / ${fmtExact(metrics.output)}`],
    ["推理 Token", `${fmtCompact(metrics.reasoning)} / ${fmtExact(metrics.reasoning)}（已含于输出）`],
    ["Token 合计", `${fmtCompact(metrics.total)} / ${fmtExact(metrics.total)}`],
    ["缓存命中率", fmtPercent(metrics.cacheHit)],
    ["上下文", row._context ? `${contextLabel(row._context)} (${contextDisplay(row._context, !row._precise)})` : "未读取到"],
    ["费用", fmtCost(val(row, "cost"))],
    ["总耗时", fmtMs(val(row, "ms"))],
    ["首 Token / 首文本", fmtMs(val(row, "ttft"))],
    ["状态码", val(row, "status")],
    ["错误", val(row, "error")],
    ["Purpose", val(row, "purpose")],
    ["账号", val(row, "account")],
    ["调用方 Key", val(row, "callerKey")],
    ["重试", val(row, "retried")],
    ["尝试次数", val(row, "tries")],
    ["转交请求", val(row, "handedOn")],
    ["Effort", val(row, "effort")],
    ["Tier requested", val(row, "tierAsked")],
    ["Tier sent", val(row, "tierSent")],
    ["Tier served", val(row, "tierServed")],
    ["父 Agent", val(row, "parentAgent")],
    ["Subagent", val(row, "subagent")],
    ["会话角色", val(row, "sessionRole")],
  ];
  const grid = make("dl", "detail-grid");
  for (const [label, value] of fields) {
    if (value === null || value === undefined || value === "") continue;
    const cell = make("div");
    cell.append(make("dt", "", label));
    cell.append(make("dd", "", value));
    grid.append(cell);
  }
  body.append(grid);
  body.append(make("p", "call-note", "Magpie 用量 API 不包含提示词 / 回复正文；此处只显示请求用量元数据。"));
  item.append(body);
  return item;
}

function statusLabel(row) {
  if (isFailure(row)) return "失败";
  const status = val(row, "status");
  return status === null ? "完成" : `HTTP ${status}`;
}

function modeLabel(mode) {
  return mode === "precise" ? "精确轮次" : mode === "mixed" ? "混合归轮" : "时间估算";
}

function renderTurn(turn, index, total) {
  const open = state.expandedTurns.has(turn.key);
  const card = make("article", "turn");
  card.dataset.turnKey = turn.key;
  const head = make("button", "turn-head");
  head.type = "button";
  head.dataset.turnToggle = turn.key;
  head.setAttribute("aria-expanded", String(open));

  const timeCell = make("div", "turn-time-cell");
  timeCell.append(make("span", "turn-number", `轮次 ${String(total - index).padStart(2, "0")}`));
  timeCell.append(make("span", "turn-time", fmtTime(turn.start)));
  timeCell.append(make("small", "turn-sub", turn.end !== turn.start ? `至 ${fmtTime(turn.end)}` : "单次请求"));
  head.append(timeCell);

  const identity = make("div", "turn-identity");
  identity.append(make("b", "", turn.models.join(", ") || "模型未知"));
  identity.append(make("small", "turn-sub", `${modeLabel(turn.mode)} · ${shortId(turn.session)}`));
  head.append(identity);

  const tokenCell = make("div", "turn-metric");
  tokenCell.append(make("b", "", fmtCompact(turn.metrics.total)));
  tokenCell.append(make("small", "", `${fmtExact(turn.metrics.total)} tokens`));
  head.append(tokenCell);

  const inputCell = make("div", "turn-metric");
  inputCell.append(make("b", "", fmtCompact(turn.metrics.uncachedInput)));
  inputCell.append(make("small", "", `${fmtExact(turn.metrics.uncachedInput)} 输入`));
  head.append(inputCell);

  const outputCell = make("div", "turn-metric");
  outputCell.append(make("b", "", fmtCompact(turn.metrics.output)));
  outputCell.append(make("small", "", `${fmtExact(turn.metrics.output)} 输出`));
  head.append(outputCell);

  const cacheReadCell = make("div", "turn-metric");
  cacheReadCell.append(make("b", "", fmtCompact(turn.metrics.cacheRead)));
  cacheReadCell.append(make("small", "", `${fmtExact(turn.metrics.cacheRead)} 缓存`));
  head.append(cacheReadCell);

  const costCell = make("div", "turn-metric turn-cost");
  costCell.append(make("b", "", fmtCost(turn.metrics.cost)));
  costCell.append(make("small", "", "费用"));
  head.append(costCell);

  const callCell = make("div", "turn-metric");
  callCell.append(make("b", "", fmtExact(turn.rows.length)));
  callCell.append(make("small", "", "模型请求"));
  head.append(callCell);

  const cacheCell = make("div", "turn-metric");
  cacheCell.append(make("b", "", fmtPercent(turn.metrics.cacheHit)));
  cacheCell.append(make("small", "", "缓存命中"));
  head.append(cacheCell);

  const contextCell = make("div", "turn-metric");
  contextCell.append(make("b", "", contextDisplay(turn.context, turn.mode !== "precise")));
  contextCell.append(make("small", "", "上下文"));
  head.append(contextCell);
  head.append(make("span", "turn-chevron", open ? "−" : "+"));
  card.append(head);

  const details = make("div", "turn-details");
  details.hidden = !open;
  const meta = make("div", "turn-meta");
  meta.append(make("span", `trace-badge ${turn.mode}`, modeLabel(turn.mode)));
  meta.append(make("span", "meta-text", `会话 ${turn.session || "未记录"}`));
  if (turn.turnId) meta.append(make("span", "meta-text", `Turn ${shortId(turn.turnId)}`));
  meta.append(make("span", "meta-text", `费用 ${fmtCost(turn.metrics.cost)}`));
  details.append(meta);

  const composition = make("div", "turn-composition");
  fillCompositionBar(composition, turn.metrics);
  details.append(composition);

  const activity = renderActivity(turn.activity);
  if (activity) details.append(activity);
  const requestList = make("div", "request-list");
  for (const row of [...turn.rows].reverse()) requestList.append(renderCall(row));
  details.append(requestList);
  card.append(details);
  return card;
}

function fillCompositionBar(container, totals) {
  container.textContent = "";
  const segments = compositionSegments(totals);
  const total = Math.max(1, totals.total || 0);
  if (!segments.length) {
    container.append(make("span", "composition-empty", "暂无数据"));
    return;
  }
  for (const segment of segments) {
    const bar = make("span", "composition-segment");
    bar.style.width = `${(segment.value / total) * 100}%`;
    bar.style.background = segment.color;
    bar.title = `${segment.label}: ${fmtCompact(segment.value)} (${fmtExact(segment.value)})`;
    container.append(bar);
  }
}

function createSessionCard(session) {
    const open = state.expandedSessions.has(session.key);
    const card = make("article", "session-card");
    card.dataset.sessionKey = session.key;
    const head = make("button", "session-head");
    head.type = "button";
    head.dataset.sessionToggle = session.key;
    head.setAttribute("aria-expanded", String(open));

    const titleBlock = make("div", "session-title-block");
    const kicker = make("span", "session-kicker", session.role === "subagent" ? "子 AGENT" : "会话");
    titleBlock.append(kicker);
    titleBlock.append(make("b", "session-title", session.title));
    const metaText = [session.agent, session.models.join(" / "), session.cwd].filter(Boolean).join(" · ");
    titleBlock.append(make("small", "session-meta", metaText || shortId(session.session)));
    head.append(titleBlock);

    const sessionMetrics = [
      ["token", fmtCompact(session.metrics.total), `${fmtExact(session.metrics.total)} tokens`],
    ["input", fmtCompact(session.metrics.uncachedInput), `${fmtExact(session.metrics.uncachedInput)} 输入`],
    ["output", fmtCompact(session.metrics.output), `${fmtExact(session.metrics.output)} 输出`],
    ["cache-read", fmtCompact(session.metrics.cacheRead), `${fmtExact(session.metrics.cacheRead)} 缓存`],
      ["cost", fmtCost(session.metrics.cost), "费用"],
      ["turns", fmtExact(session.turns.length), "轮次"],
      ["calls", fmtExact(session.rows.length), "请求"],
      ["cache", fmtPercent(session.metrics.cacheHit), "缓存命中"],
      ["context", contextDisplay(session.context, session.preciseTurns < session.turns.length), "上下文"],
    ];
    for (const [key, value, sub] of sessionMetrics) {
      const cell = make("div", `session-metric session-${key}`);
      cell.append(make("b", "", value));
      cell.append(make("small", "", sub));
      head.append(cell);
    }
    head.append(make("span", "turn-chevron", open ? "−" : "+"));
    card.append(head);

    const details = make("div", "session-details");
    details.hidden = !open;
    const sessionBar = make("div", "session-overview");
    const bar = make("div", "turn-composition");
    fillCompositionBar(bar, session.metrics);
    sessionBar.append(bar);
    const summary = activitySummary(session.activity);
    if (summary.tools.length || summary.files.length || summary.skills.length) {
      const activity = make("div", "session-activity");
      if (summary.tools.length) activity.append(make("span", "activity-chip", `工具 ${summary.tools.length} 类 · ${summary.tools.reduce((sum, item) => sum + item[1], 0)} 次`));
      if (summary.files.length) activity.append(make("span", "activity-chip", `文件 ${summary.files.length} 个`));
      if (summary.skills.length) activity.append(make("span", "activity-chip", `技能 ${summary.skills.length} 项`));
      sessionBar.append(activity);
    }
    details.append(sessionBar);
    const turnList = make("div", "turn-list");
    session.turns.forEach((turn, index) => turnList.append(renderTurn(turn, index, session.turns.length)));
    details.append(turnList);
    card.append(details);
    return card;
}

function renderSessions(sessions) {
  const content = $("content");
  content.className = "content content-list";
  content.textContent = "";
  if (!sessions.length) {
    content.append(make("div", "empty", "这个时间范围内没有匹配的请求。确认 Codex 的请求经过 Magpie 网关后再刷新。"));
    return;
  }
  for (const session of sessions) content.append(createSessionCard(session));
}

function squarify(items, box = { x: 0, y: 0, w: 100, h: 100 }) {
  const sized = items.filter((item) => item.tokens > 0).sort((a, b) => b.tokens - a.tokens);
  let total = 0;
  for (const item of sized) total += item.tokens;
  if (!sized.length || total <= 0 || box.w <= 0 || box.h <= 0) return [];
  const scale = (box.w * box.h) / total;
  const entries = sized.map((item) => ({ item, area: item.tokens * scale }));
  const output = [];
  let remaining = { ...box };
  let row = [];
  const worst = (areas, side) => {
    let sum = 0;
    for (const area of areas) sum += area;
    const thickness = sum / side;
    let score = 0;
    for (const area of areas) {
      const length = area / thickness;
      const ratio = length > thickness ? length / thickness : thickness / length;
      if (ratio > score) score = ratio;
    }
    return score;
  };
  const flush = () => {
    let sum = 0;
    for (const item of row) sum += item.area;
    if (remaining.w >= remaining.h) {
      const thickness = sum / remaining.h;
      let y = remaining.y;
      for (const item of row) {
        const length = item.area / thickness;
        output.push({ item: item.item, rect: { x: remaining.x, y, w: thickness, h: length } });
        y += length;
      }
      remaining = { x: remaining.x + thickness, y: remaining.y, w: remaining.w - thickness, h: remaining.h };
    } else {
      const thickness = sum / remaining.w;
      let x = remaining.x;
      for (const item of row) {
        const length = item.area / thickness;
        output.push({ item: item.item, rect: { x, y: remaining.y, w: length, h: thickness } });
        x += length;
      }
      remaining = { x: remaining.x, y: remaining.y + thickness, w: remaining.w, h: remaining.h - thickness };
    }
    row = [];
  };
  for (const entry of entries) {
    if (row.length) {
      const side = Math.min(remaining.w, remaining.h);
      if (worst([...row.map((item) => item.area), entry.area], side) > worst(row.map((item) => item.area), side)) flush();
    }
    row.push(entry);
  }
  flush();
  return output;
}

function renderMap(sessions) {
  const content = $("content");
  content.className = "content content-map";
  content.textContent = "";
  if (!sessions.length) {
    content.append(make("div", "empty", "没有可绘制的地图数据。"));
    return;
  }
  const map = make("div", "map-canvas");
  const items = sessions.map((session, index) => ({
    session,
    tokens: session.metrics.total,
    color: SERIES_COLORS[index % SERIES_COLORS.length],
  }));
  for (const { item, rect } of squarify(items)) {
    const session = item.session;
    const block = make("section", "map-session");
    block.style.left = `${rect.x + 0.25}%`;
    block.style.top = `${rect.y + 0.25}%`;
    block.style.width = `${Math.max(0.8, rect.w - 0.5)}%`;
    block.style.height = `${Math.max(0.8, rect.h - 0.5)}%`;
    block.style.setProperty("--map-color", item.color);
    const head = make("button", "map-session-head");
    head.type = "button";
    head.dataset.focusSession = session.key;
    head.append(make("span", "map-session-title", session.title));
    head.append(make("b", "", fmtCompact(session.metrics.total)));
    head.append(make("span", "map-session-cost", fmtCost(session.metrics.cost)));
    head.addEventListener("mouseenter", (event) => showMapTip(event, session));
    head.addEventListener("mousemove", moveChartTooltip);
    head.addEventListener("mouseleave", hideChartTooltip);
    block.append(head);
    const body = make("div", "map-session-body");
    const turnItems = session.turns.map((turn, index) => ({ turn, tokens: turn.metrics.total, index }));
    for (const turnLayout of squarify(turnItems)) {
      const turn = turnLayout.item.turn;
      const turnBlock = make("button", "map-turn");
      turnBlock.type = "button";
      turnBlock.dataset.focusTurn = turn.key;
      turnBlock.dataset.focusSession = session.key;
      turnBlock.style.left = `${turnLayout.rect.x + 0.2}%`;
      turnBlock.style.top = `${turnLayout.rect.y + 0.2}%`;
      turnBlock.style.width = `${Math.max(0.8, turnLayout.rect.w - 0.4)}%`;
      turnBlock.style.height = `${Math.max(0.8, turnLayout.rect.h - 0.4)}%`;
      turnBlock.style.setProperty("--map-turn-color", item.color);
      if (turnLayout.rect.w > 9 && turnLayout.rect.h > 12) {
        turnBlock.append(make("span", "map-turn-label", `#${String(turnItems.length - turnLayout.item.index).padStart(2, "0")}`));
        turnBlock.append(make("b", "", fmtCompact(turn.metrics.total)));
      }
      turnBlock.addEventListener("mouseenter", (event) => showTurnTip(event, session, turn));
      turnBlock.addEventListener("mousemove", moveChartTooltip);
      turnBlock.addEventListener("mouseleave", hideChartTooltip);
      turnBlock.addEventListener("click", (event) => {
        event.stopPropagation();
        focusTurn(session.key, turn.key);
      });
      body.append(turnBlock);
    }
    block.append(body);
    map.append(block);
  }
  content.append(map);
  const legend = make("div", "map-legend");
  for (const item of items.slice(0, 10)) {
    const entry = make("span", "map-legend-item");
    const dot = make("span", "legend-dot");
    dot.style.background = item.color;
    entry.append(dot, make("span", "", item.session.title));
    legend.append(entry);
  }
  content.append(legend);
}

function showMapTip(event, session) {
  showChartTooltip(
    event,
    `${session.title}\n${fmtCompact(session.metrics.total)} · ${fmtExact(session.metrics.total)} tokens\n${fmtCost(session.metrics.cost)} · ${session.turns.length} 轮 · ${fmtPercent(session.metrics.cacheHit)} 缓存`,
  );
}

function showTurnTip(event, session, turn) {
  showChartTooltip(
    event,
    `${session.title}\n轮次 ${fmtTime(turn.start)}\n${fmtCompact(turn.metrics.total)} · ${fmtExact(turn.metrics.total)} tokens\n${fmtCost(turn.metrics.cost)} · ${turn.rows.length} 请求 · ${fmtPercent(turn.metrics.cacheHit)} 缓存`,
  );
}

function renderGrid(sessions) {
  const content = $("content");
  content.className = "content content-grid";
  content.textContent = "";
  if (!sessions.length) {
    content.append(make("div", "empty", "没有可绘制的方格数据。"));
    return;
  }
  const totals = state.lastTotals || summaryTotals(state.summary, state.rows);
  const waffleBlock = make("section", "grid-block");
  const waffleHead = make("div", "grid-block-head");
  waffleHead.append(make("h3", "", "Token 方格"));
  waffleHead.append(make("span", "", "按会话 Token 等比划分 · 每格代表一个会话的份额"));
  waffleBlock.append(waffleHead);
  const waffle = make("div", "token-waffle");
  const sessionItems = sessions
    .map((session, index) => ({
      session,
      value: session.metrics.total,
      color: SERIES_COLORS[index % SERIES_COLORS.length],
    }))
    .filter((item) => item.value > 0);
  const maxSession = Math.max(1, ...sessionItems.map((item) => item.value));
  const totalSession = sessionItems.reduce((sum, item) => sum + item.value, 0) || 1;
  let cellSession = sessionItems[0]?.session || null;
  for (let index = 0; index < 100; index += 1) {
    const ratio = (index + 0.5) / 100;
    let cumulative = 0;
    let picked = sessionItems[sessionItems.length - 1] || null;
    for (const item of sessionItems) {
      cumulative += item.value / totalSession;
      if (ratio <= cumulative) {
        picked = item;
        break;
      }
    }
    const cell = make("button", "waffle-cell");
    cell.type = "button";
    if (picked) {
      const alpha = 0.35 + 0.65 * Math.sqrt(picked.value / maxSession);
      cell.style.setProperty("--waffle-color", picked.color);
      cell.style.setProperty("--waffle-alpha", alpha.toFixed(3));
      cell.dataset.session = picked.session.key;
      cell.setAttribute("aria-label", `${picked.session.title} · 约 ${fmtPercent(1)}`);
      cell.addEventListener("click", () => focusSession(picked.session.key));
      cell.addEventListener("mouseenter", (event) =>
        showChartTooltip(
          event,
          `${picked.session.title}\n${fmtCompact(picked.value)} · ${fmtExact(picked.value)} tokens\n占全部 ${fmtPercent((picked.value / totalSession) * 100)}`,
        ),
      );
      cell.addEventListener("mousemove", moveChartTooltip);
      cell.addEventListener("mouseleave", hideChartTooltip);
    }
    waffle.append(cell);
  }
  waffleBlock.append(waffle);
  content.append(waffleBlock);

  const sessionBlock = make("section", "grid-block");
  const sessionHead = make("div", "grid-block-head");
  sessionHead.append(make("h3", "", "会话方格"));
  sessionHead.append(make("span", "", "颜色深浅 = 轮次 Token 密度"));
  sessionBlock.append(sessionHead);
  const grid = make("div", "session-grid");
  const maxTurn = Math.max(1, ...sessions.flatMap((session) => session.turns.map((turn) => turn.metrics.total)));
  for (const [sessionIndex, session] of sessions.entries()) {
    const card = make("article", "session-grid-card");
    const head = make("button", "session-grid-head");
    head.type = "button";
    head.dataset.focusSession = session.key;
    head.append(make("b", "", session.title));
    head.append(make("small", "", `${fmtCompact(session.metrics.total)} · ${fmtCost(session.metrics.cost)}`));
    head.addEventListener("click", () => focusSession(session.key));
    card.append(head);
    const tiles = make("div", "turn-tiles");
    const color = SERIES_COLORS[sessionIndex % SERIES_COLORS.length];
    session.turns.slice(0, 24).forEach((turn) => {
      const tile = make("button", "turn-tile");
      tile.type = "button";
      tile.dataset.focusTurn = turn.key;
      tile.dataset.focusSession = session.key;
      tile.style.setProperty("--tile-color", color);
      tile.style.setProperty("--tile-strength", `${Math.round(16 + 70 * (turn.metrics.total / maxTurn))}%`);
      tile.title = `${fmtTime(turn.start)} · ${fmtCompact(turn.metrics.total)} tokens`;
      tile.addEventListener("mouseenter", (event) => showTurnTip(event, session, turn));
      tile.addEventListener("mousemove", moveChartTooltip);
      tile.addEventListener("mouseleave", hideChartTooltip);
      tile.addEventListener("click", () => focusTurn(session.key, turn.key));
      tiles.append(tile);
    });
    card.append(tiles);
    card.append(make("small", "session-grid-foot", `${session.turns.length} 轮 · ${session.rows.length} 请求 · ${fmtPercent(session.metrics.cacheHit)} 缓存`));
    grid.append(card);
  }
  sessionBlock.append(grid);
  content.append(sessionBlock);
}

function renderRanking(sessions, turns) {
  const scope = state.rankingScope;
  const metric = state.rankingMetric;
  const list = $("ranking-list");
  list.textContent = "";
  const scopeButtons = $("ranking-scope").querySelectorAll("button");
  scopeButtons.forEach((button) => button.setAttribute("aria-selected", String(button.dataset.scope === scope)));
  if (!RANKING_KEYS.includes(metric)) {
    state.rankingMetric = "total";
  }
  $("ranking-metric").querySelectorAll("button").forEach((button) => {
    button.setAttribute("aria-selected", String(button.dataset.metric === state.rankingMetric));
  });
  const items = (scope === "turn" ? turns : sessions)
    .map((item) => {
      const value = categoryValue(item.metrics, state.rankingMetric);
      return {
        item,
        value,
        label: scope === "turn" ? `轮次 ${fmtTime(item.start)}` : item.title,
        sub: scope === "turn" ? `${item.models.join(" / ") || "模型未知"} · ${item.rows.length} 请求` : `${item.turns.length} 轮 · ${item.rows.length} 请求`,
      };
    })
    .filter((item) => item.value > 0)
    .sort((left, right) => right.value - left.value);
  const max = items.length ? items[0].value : 1;
  $("ranking-subtitle").textContent = state.rankingMetric === "total"
    ? "按 Token 合计排序。"
    : `按「${categoryLabel(state.rankingMetric)}」排序。`;
  if (!items.length) {
    list.append(make("div", "empty small", "当前范围没有可排序数据。"));
    return;
  }
  const visibleItems = state.rankingExpanded ? items : items.slice(0, 7);
  for (const item of visibleItems) {
    const row = make("button", "ranking-row");
    row.type = "button";
    row.dataset.rankingSession = scope === "session" ? item.item.key : item.item.session;
    row.dataset.rankingTurn = scope === "turn" ? item.item.key : "";
    row.append(make("span", "ranking-label", item.label));
    const value = make("span", "ranking-value", fmtCompact(item.value));
    row.append(value);
    row.append(make("span", "ranking-exact", fmtExact(item.value)));
    const bar = make("span", "ranking-bar");
    const fill = make("i");
    fill.style.width = `${Math.max(2, (item.value / max) * 100)}%`;
    fill.style.background = state.rankingMetric === "total"
      ? "var(--accent)"
      : RANKING_META[state.rankingMetric]?.color || "var(--accent)";
    bar.append(fill);
    row.append(bar);
    row.append(make("small", "ranking-sub", item.sub));
    row.addEventListener("mouseenter", (event) => showChartTooltip(event, `${item.label}\n${fmtCompact(item.value)} · ${fmtExact(item.value)} tokens`));
    row.addEventListener("mousemove", moveChartTooltip);
    row.addEventListener("mouseleave", hideChartTooltip);
    row.addEventListener("click", () => {
      if (scope === "session") focusSession(item.item.key);
      else focusTurn(item.item.session, item.item.key);
    });
    list.append(row);
  }
  if (items.length > 7) {
    const toggle = make("button", "ranking-expand", state.rankingExpanded
      ? "收起"
      : `展开全部 ${items.length} 项`);
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", String(state.rankingExpanded));
    toggle.addEventListener("click", () => {
      state.rankingExpanded = !state.rankingExpanded;
      renderRanking(state.lastSessions, state.lastTurns);
    });
    list.append(toggle);
  }
}

function reconcileSessions(content, sessions) {
  const existing = [...content.querySelectorAll(":scope > .session-card")];
  const openKeys = existing.map((card) => card.dataset.sessionKey).filter(Boolean);
  const byKey = new Map(sessions.map((session) => [session.key, session]));
  const retained = new Set();
  for (const key of openKeys) {
    if (!byKey.has(key)) continue;
    const oldCard = content.querySelector(`:scope > .session-card[data-session-key="${CSS.escape(key)}"]`);
    if (!oldCard) continue;
    const session = byKey.get(key);
    const head = oldCard.querySelector(".session-head");
    const details = oldCard.querySelector(".session-details");
    const open = state.expandedSessions.has(key);
    if (details) details.hidden = !open;
    if (head) head.setAttribute("aria-expanded", String(open));
    const chevron = head?.querySelector(".turn-chevron");
    if (chevron) chevron.textContent = open ? "−" : "+";
    const title = head?.querySelector(".session-title");
    const metrics = head?.querySelectorAll(".session-metric");
    const values = [
      fmtCompact(session.metrics.total),
      fmtCompact(session.metrics.uncachedInput),
      fmtCompact(session.metrics.output),
      fmtCompact(session.metrics.cacheRead),
      fmtCost(session.metrics.cost),
      fmtExact(session.turns.length),
      fmtExact(session.rows.length),
      fmtPercent(session.metrics.cacheHit),
      contextDisplay(session.context, session.preciseTurns < session.turns.length),
    ];
    const subValues = [
      `${fmtExact(session.metrics.total)} tokens`,
      `${fmtExact(session.metrics.uncachedInput)} 输入`,
      `${fmtExact(session.metrics.output)} 输出`,
      `${fmtExact(session.metrics.cacheRead)} 缓存`,
      "费用",
      "轮次",
      "请求",
      "缓存命中",
      "上下文",
    ];
    metrics?.forEach((cell, index) => {
      const value = cell.querySelector("b");
      if (value && value.textContent !== values[index]) value.textContent = values[index];
      const sub = cell.querySelector("small");
      if (sub && sub.textContent !== subValues[index]) sub.textContent = subValues[index];
    });
    if (title && title.textContent !== session.title) title.textContent = session.title;
    const bar = details?.querySelector(".session-overview .turn-composition");
    if (bar) fillCompositionBar(bar, session.metrics);
    const activity = details?.querySelector(".session-activity");
    if (activity) {
      const summary = activitySummary(session.activity);
      activity.textContent = "";
      if (summary.tools.length) activity.append(make("span", "activity-chip", `工具 ${summary.tools.length} 类 · ${summary.tools.reduce((sum, item) => sum + item[1], 0)} 次`));
      if (summary.files.length) activity.append(make("span", "activity-chip", `文件 ${summary.files.length} 个`));
      if (summary.skills.length) activity.append(make("span", "activity-chip", `技能 ${summary.skills.length} 项`));
    }
    const turnList = details?.querySelector(".turn-list");
    if (turnList && open) {
      const oldTurns = new Map(
        [...turnList.querySelectorAll(".turn")].map((turn) => [turn.dataset.turnKey, turn]),
      );
      const orderedTurns = [];
      session.turns.forEach((turn, index) => {
        const oldTurn = oldTurns.get(turn.key) || renderTurn(turn, index, session.turns.length);
        const head = oldTurn.querySelector(".turn-head");
        const turnOpen = state.expandedTurns.has(turn.key);
        const turnDetails = oldTurn.querySelector(".turn-details");
        if (turnDetails) turnDetails.hidden = !turnOpen;
        if (head) head.setAttribute("aria-expanded", String(turnOpen));
        const turnChevron = head?.querySelector(".turn-chevron");
        if (turnChevron) turnChevron.textContent = turnOpen ? "−" : "+";
        const turnMetrics = head?.querySelectorAll(".turn-metric");
        const values = [
          fmtCompact(turn.metrics.total),
          fmtCompact(turn.metrics.uncachedInput),
          fmtCompact(turn.metrics.output),
          fmtCompact(turn.metrics.cacheRead),
          fmtCost(turn.metrics.cost),
          fmtExact(turn.rows.length),
          fmtPercent(turn.metrics.cacheHit),
          contextDisplay(turn.context, turn.mode !== "precise"),
        ];
        const subValues = [
          `${fmtExact(turn.metrics.total)} tokens`,
          `${fmtExact(turn.metrics.uncachedInput)} 输入`,
          `${fmtExact(turn.metrics.output)} 输出`,
          `${fmtExact(turn.metrics.cacheRead)} 缓存`,
          "费用",
          "模型请求",
          "缓存命中",
          "上下文",
        ];
        turnMetrics?.forEach((cell, cellIndex) => {
          const value = cell.querySelector("b");
          if (value && value.textContent !== values[cellIndex]) value.textContent = values[cellIndex];
          const sub = cell.querySelector("small");
          if (sub && sub.textContent !== subValues[cellIndex]) sub.textContent = subValues[cellIndex];
        });
        const bar = oldTurn.querySelector(".turn-composition");
        if (bar) fillCompositionBar(bar, turn.metrics);
        oldTurn.dataset.turnIndex = String(index);
        orderedTurns.push(oldTurn);
      });
      for (const turn of turnList.querySelectorAll(".turn")) {
        if (!orderedTurns.includes(turn)) turn.remove();
      }
      for (const turn of orderedTurns) turnList.append(turn);
    }
    retained.add(key);
  }
  for (const card of existing) {
    if (!retained.has(card.dataset.sessionKey)) card.remove();
  }
  const ordered = new Map(
    [...content.querySelectorAll(":scope > .session-card")]
      .map((card) => [card.dataset.sessionKey, card]),
  );
  const orderedCards = [];
  for (const session of sessions) {
    let card = ordered.get(session.key);
    if (!card) card = createSessionCard(session);
    if (card) orderedCards.push(card);
  }
  for (const card of orderedCards) content.append(card);
}

function renderContent() {
  if (!state.lastSessions.length) {
    $("content").className = "content";
    $("content").innerHTML = '<div class="empty">没有可显示的数据。</div>';
    return;
  }
  if (state.view === "map") renderMap(state.lastSessions);
  else if (state.view === "grid") renderGrid(state.lastSessions);
  else {
    const content = $("content");
    const hasCards = content.classList.contains("content-list") && content.querySelector(".session-card");
    if (hasCards) {
      content.className = "content content-list";
      reconcileSessions(content, state.lastSessions);
    } else {
      renderSessions(state.lastSessions);
    }
  }
}

function scheduleRefresh() {
  window.clearTimeout(state.refreshTimer);
  state.refreshTimer = 0;
  if (!state.refreshSeconds) return;
  state.refreshTimer = window.setTimeout(() => {
    if (!document.hidden && !state.loading) refreshAll({ quiet: true });
    scheduleRefresh();
  }, state.refreshSeconds * 1000);
}

function setRefreshSeconds(seconds) {
  state.refreshSeconds = [0, 5, 10, 30, 60].includes(Number(seconds)) ? Number(seconds) : 5;
  try { localStorage.setItem(REFRESH_KEY, String(state.refreshSeconds)); } catch {}
  const label = state.refreshSeconds === 0 ? "关闭" : state.refreshSeconds === 60 ? "1 分钟" : `${state.refreshSeconds} 秒`;
  $("refresh-cycle").textContent = label;
  $("refresh-menu").querySelectorAll("button[data-refresh]").forEach((button) => {
    button.setAttribute("aria-selected", String(Number(button.dataset.refresh) === state.refreshSeconds));
  });
  scheduleRefresh();
}

function setPeriod(period) {
  state.period = ["today", "7d", "30d", "all", "custom"].includes(period) ? period : "today";
  try { localStorage.setItem(PERIOD_KEY, state.period); } catch {}
  $("period-switch").querySelectorAll("button").forEach((button) => {
    button.setAttribute("aria-selected", String(button.dataset.period === state.period));
  });
  $("custom-range").hidden = state.period !== "custom";
}

function setView(view) {
  state.view = ["list", "map", "grid"].includes(view) ? view : "list";
  try { localStorage.setItem(VIEW_KEY, state.view); } catch {}
  const buttons = $("view-switch").querySelectorAll("button");
  buttons.forEach((button) => button.setAttribute("aria-selected", String(button.dataset.view === state.view)));
  renderContent();
}

function focusSession(key) {
  state.view = "list";
  state.expandedSessions.add(key);
  try { localStorage.setItem(VIEW_KEY, state.view); } catch {}
  setView(state.view);
  requestAnimationFrame(() => document.querySelector(`[data-session-toggle="${CSS.escape(key)}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
}

function focusTurn(sessionKey, turnKey) {
  state.view = "list";
  state.expandedSessions.add(sessionKey);
  state.expandedTurns.add(turnKey);
  try { localStorage.setItem(VIEW_KEY, state.view); } catch {}
  setView(state.view);
  requestAnimationFrame(() => document.querySelector(`[data-turn-toggle="${CSS.escape(turnKey)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
}

function updateResultsMeta(sessions, turns) {
  const precise = sessions.reduce((sum, session) => sum + session.preciseTurns, 0);
  const mixed = sessions.reduce((sum, session) => sum + session.mixedTurns, 0);
  const estimated = sessions.reduce((sum, session) => sum + session.estimatedTurns, 0);
  const totalText = state.total !== null ? ` / 共 ${fmtExact(state.total)} 条` : "";
  $("results-meta").textContent =
    `${fmtExact(state.rows.length)} 条请求${totalText} · ${fmtExact(sessions.length)} 会话 · ${fmtExact(turns.length)} 轮 · ` +
    `${fmtExact(precise)} 精确 / ${fmtExact(mixed)} 混合 / ${fmtExact(estimated)} 估算`;
}

async function refreshAll({ append = false, quiet = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  if (!quiet) {
    showError("");
    $("refresh").disabled = true;
  }
  if (!append) {
    state.offset = 0;
    state.rows = [];
    if (!quiet) {
      state.expandedSessions.clear();
      state.expandedTurns.clear();
      $("content").textContent = "";
    }
  }
  try {
    const bounds = periodBounds();
    const useRange = !!bounds;
    const compositionQuery = bounds
      ? new URLSearchParams({ from: bounds.from, to: bounds.to })
      : new URLSearchParams({ period: state.period });
    const [summaryResult, rowResult, compositionResult] = await Promise.all([
      useRange ? Promise.resolve(null) : api(`/api/summary?period=${encodeURIComponent(state.period)}`),
      useRange ? api(`/api/range?${rangeQuery(state.offset)}`) : api(`/api/requests?${reqQuery(state.offset)}`),
      api(`/api/composition?${compositionQuery}`),
    ]);
    const incoming = asRows(rowResult).map(normalizeRow);
    state.summary = summaryResult || rowResult.summary || rowResult;
    state.rows = append ? [...state.rows, ...incoming] : incoming;
    state.composition = compositionResult;
    state.total = getTotal(rowResult);
    await loadContexts(state.rows);
    const scopedRows = state.rows.filter(inRequestedRange);
    const turns = buildTurns(scopedRows);
    const sessions = buildSessions(turns);
    state.lastTurns = turns;
    state.lastSessions = sessions;
    renderSummary(state.summary, scopedRows, sessions, turns);
    renderRanking(sessions, turns);
    renderContent();
    updateResultsMeta(sessions, turns);
    state.offset = state.rows.length;
    $("load-more").hidden = incoming.length < state.limit || (state.total !== null && state.rows.length >= state.total);
    $("last-updated").textContent = `更新于 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
  } catch (err) {
    showError(`${err.message}\n\n请确认 Magpie 正在运行，并且本机网关地址为 http://127.0.0.1:3425。若你修改过 Magpie 端口，在 server.mjs 或启动环境变量 MAGPIE_URL 中设置实际地址。`);
    if (!state.rows.length) $("content").innerHTML = '<div class="empty">未能读取请求记录。</div>';
  } finally {
    state.loading = false;
    $("refresh").disabled = false;
  }
}

function toggleSession(key) {
  if (!key) return;
  if (state.expandedSessions.has(key)) state.expandedSessions.delete(key);
  else state.expandedSessions.add(key);
  renderContent();
}

function toggleTurn(key) {
  if (!key) return;
  if (state.expandedTurns.has(key)) state.expandedTurns.delete(key);
  else state.expandedTurns.add(key);
  renderContent();
}

function applyThemeFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const theme = params.get("theme");
  if (theme === "dark" || theme === "light") document.documentElement.dataset.magpieTheme = theme;
  for (const [key, value] of params.entries()) {
    if (!key.startsWith("magpie-") || !value) continue;
    const cssKey = key.slice("magpie-".length);
    document.documentElement.style.setProperty(`--${cssKey}`, value);
    document.documentElement.style.setProperty(`--magpie-${cssKey}`, value);
  }
}

async function loadMagpieTheme() {
  try {
    const theme = await api("/api/theme");
    const root = document.documentElement;
    if (!root.dataset.magpieTheme && (theme.theme === "dark" || theme.theme === "light")) {
      root.dataset.magpieTheme = theme.theme;
    }
    if (theme.uiFont?.family) {
      root.style.setProperty("--font", `${JSON.stringify(theme.uiFont.family)}, "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", sans-serif`);
      if (Number.isFinite(Number(theme.uiFont.weight))) root.style.setProperty("--ui-weight", String(theme.uiFont.weight));
    }
    if (theme.codeFont?.family) {
      root.style.setProperty("--code", `${JSON.stringify(theme.codeFont.family)}, "Cascadia Mono", Consolas, "Microsoft YaHei UI", monospace`);
    }
  } catch {}
}

function initView() {
  try {
    const stored = localStorage.getItem(VIEW_KEY);
    if (["list", "map", "grid"].includes(stored)) state.view = stored;
  } catch {}
  $("view-switch").querySelectorAll("button").forEach((button) => {
    button.setAttribute("aria-selected", String(button.dataset.view === state.view));
  });
}

applyThemeFromQuery();
initView();
$("refresh").addEventListener("click", () => refreshAll());
$("period-switch").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-period]");
  if (!button) return;
  setPeriod(button.dataset.period);
  if (state.period !== "custom") refreshAll();
});
$("range-apply").addEventListener("click", () => {
  state.customFrom = $("range-from").value;
  state.customTo = $("range-to").value;
  if (!state.customFrom || !state.customTo) {
    showError("请选择完整的开始日期和结束日期。");
    return;
  }
  if (state.customFrom > state.customTo) {
    [state.customFrom, state.customTo] = [state.customTo, state.customFrom];
    $("range-from").value = state.customFrom;
    $("range-to").value = state.customTo;
  }
  setPeriod("custom");
  refreshAll();
});
$("refresh-cycle").addEventListener("click", () => {
  const menu = $("refresh-menu");
  menu.hidden = !menu.hidden;
  $("refresh-cycle").setAttribute("aria-expanded", String(!menu.hidden));
});
$("refresh-menu").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-refresh]");
  if (!button) return;
  setRefreshSeconds(button.dataset.refresh);
  $("refresh-menu").hidden = true;
  $("refresh-cycle").setAttribute("aria-expanded", "false");
});
$("load-more").addEventListener("click", () => refreshAll({ append: true }));
$("view-switch").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-view]");
  if (button) setView(button.dataset.view);
});
$("ranking-scope").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-scope]");
  if (!button) return;
  state.rankingScope = button.dataset.scope;
  renderRanking(state.lastSessions, state.lastTurns);
});
$("ranking-metric").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-metric]");
  if (!button) return;
  state.rankingMetric = button.dataset.metric || "total";
  $("ranking-metric").querySelectorAll("button").forEach((item) => {
    item.setAttribute("aria-selected", String(item.dataset.metric === state.rankingMetric));
  });
  renderRanking(state.lastSessions, state.lastTurns);
});
document.querySelector(".composition-panel")?.addEventListener("click", (event) => {
  // Token composition focus is intentionally hover-only; clicks must not lock a category.
  if (event.target.closest("[data-category]")) event.preventDefault();
});
$("content").addEventListener("click", (event) => {
  const sessionToggle = event.target.closest("[data-session-toggle]");
  if (sessionToggle) {
    toggleSession(sessionToggle.dataset.sessionToggle);
    return;
  }
  const turnToggle = event.target.closest("[data-turn-toggle]");
  if (turnToggle) {
    toggleTurn(turnToggle.dataset.turnToggle);
    return;
  }
  const focusSessionButton = event.target.closest("[data-focus-session]");
  if (focusSessionButton && !event.target.closest("[data-focus-turn]")) {
    focusSession(focusSessionButton.dataset.focusSession);
  }
});
$("expand-all").addEventListener("click", () => {
  state.expandedSessions = new Set(state.lastSessions.map((session) => session.key));
  state.expandedTurns = new Set(state.lastTurns.map((turn) => turn.key));
  renderContent();
});
$("collapse-all").addEventListener("click", () => {
  state.expandedSessions.clear();
  state.expandedTurns.clear();
  renderContent();
});
try {
  const storedPeriod = localStorage.getItem(PERIOD_KEY);
  if (["today", "7d", "30d", "all"].includes(storedPeriod)) state.period = storedPeriod;
  const storedRefresh = Number(localStorage.getItem(REFRESH_KEY));
  if ([0, 5, 10, 30, 60].includes(storedRefresh)) state.refreshSeconds = storedRefresh;
} catch {}
const today = localDateKey(new Date());
state.customFrom = today;
state.customTo = today;
$("range-from").value = today;
$("range-to").value = today;
setPeriod(state.period);
setRefreshSeconds(state.refreshSeconds);
loadMagpieTheme().finally(() => refreshAll());
