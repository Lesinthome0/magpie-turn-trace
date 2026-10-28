import http from 'node:http';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.TRACE_PORT || 3426);
const MAGPIE_BASE = (process.env.MAGPIE_URL || 'http://127.0.0.1:3425').replace(/\/$/, '');
const LOCAL_ORIGINS = new Set([
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
  'http://127.0.0.1:3425',
  'http://localhost:3425',
  // Magpie's sandboxed WebView reports an opaque origin as "null".
  'null',
]);
const CODEX_HOME = (process.env.CODEX_HOME || path.join(os.homedir(), '.codex')).replace(/[\\/]+$/, '');
const SESSION_ROOT = path.join(CODEX_HOME, 'sessions');
const SESSION_INDEX = path.join(CODEX_HOME, 'session_index.jsonl');
const MAGPIE_SETTINGS = path.join(os.homedir(), '.config', 'magpie', 'settings.json');
const MAGPIE_ROUTING = path.join(os.homedir(), '.config', 'magpie', 'routing');
const MAX_CONTEXT_EVENTS = 800;
const MAX_ROLLOUT_TAIL_BYTES = 24 * 1024 * 1024;
const contextCache = new Map();
const rolloutCache = new Map();
const titleCache = { mtimeMs: 0, titles: new Map() };
const routingCache = new Map();
const rangeCache = new Map();
const RANGE_CACHE_MS = 5000;
const USAGE_PAGE_SIZE = 500;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
};

function json(res, status, data) {
  const origin = res.__traceOrigin || '';
  const cors = LOCAL_ORIGINS.has(origin)
    ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
    : { Vary: 'Origin' };
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'X-Content-Type-Options': 'nosniff',
    ...cors,
  });
  res.end(JSON.stringify(data));
}

function htmlHeaders(res, ext) {
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    // Magpie's WebView origin is not stable across releases. Keep embedding
    // compatible while the API's CORS policy remains restricted below.
    'Content-Security-Policy': `default-src http://127.0.0.1:${PORT}; script-src http://127.0.0.1:${PORT}; style-src http://127.0.0.1:${PORT}; connect-src http://127.0.0.1:${PORT}; img-src http://127.0.0.1:${PORT} data:; frame-ancestors *; base-uri 'none'; form-action 'none'`,
    'X-Content-Type-Options': 'nosniff',
  });
}

function validSessionId(value) {
  return /^[A-Za-z0-9_.:-]{8,180}$/.test(String(value || ''));
}

function turnIdFromRecord(record) {
  const payload = record?.payload;
  return String(
    payload?.turn_id ||
      payload?.internal_chat_message_metadata_passthrough?.turn_id ||
      payload?.item?.turn_id ||
      payload?.metadata?.turn_id ||
      record?.turn_id ||
      '',
  ).trim();
}

async function sessionTitle(sessionId) {
  try {
    const info = await stat(SESSION_INDEX);
    if (info.mtimeMs !== titleCache.mtimeMs) {
      const text = await readFile(SESSION_INDEX, 'utf8');
      const titles = new Map();
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (record?.id && record?.thread_name) titles.set(String(record.id), String(record.thread_name));
        } catch {}
      }
      titleCache.mtimeMs = info.mtimeMs;
      titleCache.titles = titles;
    }
  } catch {}
  return titleCache.titles.get(String(sessionId)) || '';
}

async function findRolloutFile(sessionId) {
  if (rolloutCache.has(sessionId)) return rolloutCache.get(sessionId);

  let found = null;
  const visit = async (directory, depth) => {
    if (found || depth > 6) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found) break;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(sessionId)) {
        found = fullPath;
      }
    }
  };

  await visit(SESSION_ROOT, 0);
  if (found) rolloutCache.set(sessionId, found);
  return found;
}

async function readRolloutTail(filePath) {
  const info = await stat(filePath);
  const bytes = Math.min(info.size, MAX_ROLLOUT_TAIL_BYTES);
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const start = Math.max(0, info.size - bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      if (firstNewline >= 0) text = text.slice(firstNewline + 1);
    }
    return { text, size: info.size, mtimeMs: info.mtimeMs };
  } finally {
    await handle.close();
  }
}

async function readRolloutHead(filePath, maxBytes = 64 * 1024) {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

function cwdFromHead(text) {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record?.payload?.cwd) return String(record.payload.cwd);
    } catch {}
  }
  return '';
}

function parseJsonMaybe(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function addFile(files, filePath, operation) {
  const value = String(filePath || '').trim().replace(/^["']|["']$/g, '');
  if (!value || value.length > 500) return;
  const item = files[value] || { count: 0, operations: [] };
  item.count += 1;
  if (operation && !item.operations.includes(operation)) item.operations.push(operation);
  files[value] = item;
}

function filesFromTool(payload) {
  const files = {};
  const name = String(payload?.name || '');
  const input = payload?.input ?? payload?.arguments;
  const text = typeof input === 'string' ? input : '';

  if (name === 'apply_patch') {
    for (const match of text.matchAll(/^\*\*\* (Update|Add|Delete) File:\s*(.+)$/gm)) {
      addFile(files, match[2], match[1].toLowerCase());
    }
    for (const match of text.matchAll(/^\*\*\* Move to:\s*(.+)$/gm)) {
      addFile(files, match[1], 'move');
    }
    return files;
  }

  const args = parseJsonMaybe(input);
  if (name === 'view_image' && args?.path) addFile(files, args.path, 'read');
  if ((name === 'write' || name === 'read') && (args?.path || args?.file_path)) {
    addFile(files, args.path || args.file_path, name);
  }
  if (name === 'exec_command') {
    const command = String(args?.cmd || '');
    for (const match of command.matchAll(/(?:[A-Za-z]:\\[^"'`\r\n]+|\\\\[^"'`\r\n]+)/g)) {
      const candidate = match[0].replace(/[),.;]+$/, '').trim();
      if (!candidate || /^https?:/i.test(candidate)) continue;
      if (!/\.[A-Za-z0-9]{1,12}(?:\s|$)/.test(candidate) && !candidate.endsWith('\\')) continue;
      addFile(files, candidate, 'reference');
    }
  }
  return files;
}

function parseRollout(text) {
  const events = [];
  const activityByTurn = {};
  let lastTurnId = '';
  let cwd = '';
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    const turnId = turnIdFromRecord(record);
    if (turnId) lastTurnId = turnId;
    const payload = record?.payload;
    if (payload?.type === 'session_meta' && payload.cwd) cwd = String(payload.cwd);
    if (payload?.type === 'function_call' || payload?.type === 'custom_tool_call' ||
        payload?.type === 'web_search_call' || payload?.type === 'tool_search_call') {
      const activity = activityByTurn[turnId || lastTurnId || 'unknown'] || { tools: {}, files: {} };
      const toolName = String(
        payload.name ||
        (payload.type === 'web_search_call' ? 'web_search' : '') ||
        (payload.type === 'tool_search_call' ? 'tool_search' : '') ||
        'tool',
      );
      activity.tools[toolName] = (activity.tools[toolName] || 0) + 1;
      for (const [filePath, fileInfo] of Object.entries(filesFromTool(payload))) {
        const existing = activity.files[filePath] || { count: 0, operations: [] };
        existing.count += fileInfo.count;
        for (const operation of fileInfo.operations) {
          if (!existing.operations.includes(operation)) existing.operations.push(operation);
        }
        activity.files[filePath] = existing;
      }
      activityByTurn[turnId || lastTurnId || 'unknown'] = activity;
    }
    if (payload?.type !== 'token_count') continue;

    const info = payload.info || {};
    const last = info.last_token_usage || {};
    const total = info.total_token_usage || {};
    const time = Date.parse(record.timestamp);
    if (!Number.isFinite(time)) continue;
    events.push({
      time,
      timestamp: record.timestamp,
      ordinal: record.ordinal ?? null,
      turnId: lastTurnId,
      inputTokens: Number(last.input_tokens) || 0,
      cachedInputTokens: Number(last.cached_input_tokens) || 0,
      cacheWriteInputTokens: Number(last.cache_write_input_tokens) || 0,
      outputTokens: Number(last.output_tokens) || 0,
      reasoningOutputTokens: Number(last.reasoning_output_tokens) || 0,
      totalTokens: Number(last.total_tokens) || 0,
      contextWindow: Number(info.model_context_window) || 0,
      sessionInputTokens: Number(total.input_tokens) || 0,
      sessionCachedInputTokens: Number(total.cached_input_tokens) || 0,
      sessionOutputTokens: Number(total.output_tokens) || 0,
      sessionTotalTokens: Number(total.total_tokens) || 0,
    });
  }
  return { events: events.slice(-MAX_CONTEXT_EVENTS), activityByTurn, cwd };
}

async function contextForSession(sessionId) {
  const filePath = await findRolloutFile(sessionId);
  if (!filePath) {
    return {
      session: sessionId,
      source: 'codex-rollout',
      title: await sessionTitle(sessionId),
      events: [],
      activityByTurn: {},
      error: '未找到对应的 Codex 会话记录',
    };
  }

  const info = await stat(filePath);
  const cached = contextCache.get(filePath);
  if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
    return { ...cached.payload, title: await sessionTitle(sessionId) };
  }

  const tail = await readRolloutTail(filePath);
  const head = await readRolloutHead(filePath);
  const parsed = parseRollout(tail.text);
  const payload = {
    session: sessionId,
    source: 'codex-rollout',
    title: await sessionTitle(sessionId),
    cwd: parsed.cwd || cwdFromHead(head),
    events: parsed.events,
    activityByTurn: parsed.activityByTurn,
  };
  contextCache.set(filePath, { size: info.size, mtimeMs: info.mtimeMs, payload });
  return payload;
}

async function routingFiles() {
  const files = [];
  try {
    for (const entry of await readdir(MAGPIE_ROUTING, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const match = entry.name.match(/^(\d{4}-\d{2}-\d{2})\.jsonl(?:\.gz)?$/);
      if (match) files.push({ day: match[1], path: path.join(MAGPIE_ROUTING, entry.name) });
    }
  } catch {}
  return files.sort((left, right) => left.day.localeCompare(right.day));
}

function promptParts(row) {
  const prompt = row?.prompt;
  if (!prompt || !Array.isArray(prompt.parts)) return null;
  const parts = {};
  for (const part of prompt.parts) {
    const kind = String(part?.kind || '');
    if (!kind) continue;
    parts[kind] = (parts[kind] || 0) + (Number(part.tokens) || 0);
  }
  return {
    time: Date.parse(row.time) || 0,
    session: String(row.session || ''),
    agent: String(row.agent || ''),
    model: String(row.model || ''),
    status: Number(row.status) || 0,
    window: Number(prompt.window) || 0,
    tokens: Number(prompt.tokens) || 0,
    counted: prompt.counted === true,
    parts,
  };
}

async function readRoutingDay(file) {
  const info = await stat(file.path);
  const cached = routingCache.get(file.path);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.prompts;
  const prompts = [];
  const compressed = await readFile(file.path);
  const text = file.path.endsWith('.gz')
    ? gunzipSync(compressed).toString('utf8')
    : compressed.toString('utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = promptParts(JSON.parse(line));
      if (parsed) prompts.push(parsed);
    } catch {}
  }
  routingCache.set(file.path, { mtimeMs: info.mtimeMs, size: info.size, prompts });
  return prompts;
}

async function routingPrompts(days) {
  const wanted = new Set();
  const today = new Date();
  for (let offset = 0; offset < days; offset += 1) {
    const day = new Date(today);
    day.setDate(today.getDate() - offset);
    wanted.add([
      day.getFullYear(),
      String(day.getMonth() + 1).padStart(2, "0"),
      String(day.getDate()).padStart(2, "0"),
    ].join("-"));
  }
  const prompts = [];
  for (const file of await routingFiles()) {
    if (days > 0 && !wanted.has(file.day)) continue;
    prompts.push(...await readRoutingDay(file));
  }
  return prompts;
}

function localDayKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

async function routingPromptsBetween(from, to) {
  const start = from ? new Date(`${from}T00:00:00`) : null;
  const end = to ? new Date(`${to}T23:59:59.999`) : null;
  const prompts = [];
  for (const file of await routingFiles()) {
    if (start && end) {
      const fileDay = new Date(`${file.day}T12:00:00`);
      if (fileDay < start || fileDay > end) continue;
    }
    prompts.push(...await readRoutingDay(file));
  }
  return prompts.filter((prompt) => {
    if (start && prompt.time < start.getTime()) return false;
    if (end && prompt.time > end.getTime()) return false;
    return true;
  });
}

function aggregatePromptParts(prompts, session = '') {
  const totals = {};
  const sessions = {};
  let requests = 0;
  let window = 0;
  let latest = 0;
  for (const prompt of prompts) {
    if (session && prompt.session !== session) continue;
    requests += 1;
    window = Math.max(window, prompt.window);
    latest = Math.max(latest, prompt.time);
    const sessionTotals = sessions[prompt.session] || (sessions[prompt.session] = {});
    for (const [kind, tokens] of Object.entries(prompt.parts)) {
      totals[kind] = (totals[kind] || 0) + tokens;
      sessionTotals[kind] = (sessionTotals[kind] || 0) + tokens;
    }
  }
  return { totals, sessions, requests, window, latest };
}

async function serveFile(res, filePath) {
  const ext = path.extname(filePath);
  const body = await readFile(filePath);
  htmlHeaders(res, ext);
  res.end(body);
}

function allowedQuery(incoming, endpoint) {
  const output = new URLSearchParams();
  const keys = endpoint === 'requests'
    ? ['period', 'day', 'offset', 'limit', 'agent', 'provider', 'model', 'account', 'callerKey', 'purpose', 'failed', 'retried', 'q', 'via', 'computer']
    : ['period'];
  for (const key of keys) {
    const value = incoming.searchParams.get(key);
    if (value !== null && value !== '') output.set(key, value);
  }
  return output;
}

async function proxyUsage(res, url, endpoint) {
  const query = allowedQuery(url, endpoint);
  // The summary endpoint uses week/month; the request log uses 7d/30d.
  if (endpoint === 'summary') {
    if (query.get('period') === '7d') query.set('period', 'week');
    if (query.get('period') === '30d') query.set('period', 'month');
  }
  const target = `${MAGPIE_BASE}/v1/magpie/usage${endpoint === 'requests' ? '/requests' : ''}${query.size ? `?${query}` : ''}`;
  try {
    const upstream = await fetch(target, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    const text = await upstream.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: text || `Magpie returned HTTP ${upstream.status}` }; }
    if (!upstream.ok) return json(res, upstream.status, { error: data.error || data.message || `Magpie API HTTP ${upstream.status}`, detail: data });
    return json(res, 200, data);
  } catch (err) {
    return json(res, 502, {
      error: `无法连接 Magpie API：${MAGPIE_BASE}`,
      detail: String(err?.message || err),
      hint: '确认 Magpie 正在运行；默认网关地址为 http://127.0.0.1:3425。若端口不同，请设置 MAGPIE_URL。',
    });
  }
}

function dateKeysBetween(from, to) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new Error('日期格式必须为 YYYY-MM-DD');
  }
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    throw new Error('日期范围无效');
  }
  const keys = [];
  for (let cursor = start; cursor <= end; cursor += 86400000) {
    if (keys.length >= 370) throw new Error('日期范围不能超过 370 天');
    keys.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return keys;
}

async function usageDay(day) {
  const rows = [];
  let summary = null;
  let offset = 0;
  let total = 0;
  do {
    const query = new URLSearchParams({
      period: 'all',
      day,
      offset: String(offset),
      limit: String(USAGE_PAGE_SIZE),
    });
    const response = await fetch(`${MAGPIE_BASE}/v1/magpie/usage/requests?${query}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data) {
      throw new Error(data?.error || data?.message || `Magpie 日用量接口 HTTP ${response.status}`);
    }
    summary ||= data;
    const page = Array.isArray(data.rows) ? data.rows : [];
    rows.push(...page);
    total = Math.max(0, Number(data.total) || 0);
    offset += page.length;
    if (!page.length) break;
  } while (offset < total);
  return { rows, summary };
}

function sumUsageSummary(days) {
  const fields = [
    'calls', 'errors', 'retried', 'input', 'output', 'cache_read', 'cache_write',
    'reasoning', 'cost', 'unpriced', 'credits', 'credited', 'timed', 'ttft_ms',
    'decode_ms', 'decode_out', 'decode_n',
  ];
  const summary = {};
  for (const field of fields) {
    summary[field] = days.reduce((sum, day) => sum + (Number(day.summary?.[field]) || 0), 0);
  }
  return summary;
}

async function usageRange(from, to) {
  const key = `${from}|${to}`;
  const cached = rangeCache.get(key);
  if (cached && Date.now() - cached.time < RANGE_CACHE_MS) return cached.value;

  const days = [];
  for (const day of dateKeysBetween(from, to)) days.push(await usageDay(day));
  const rows = days.flatMap((day) => day.rows).sort((left, right) => {
    const leftTime = Date.parse(left?.t || '') || 0;
    const rightTime = Date.parse(right?.t || '') || 0;
    return rightTime - leftTime;
  });
  const value = { rows, summary: sumUsageSummary(days), from, to };
  rangeCache.set(key, { time: Date.now(), value });
  return value;
}

async function magpieTheme() {
  try {
    const settings = JSON.parse(await readFile(MAGPIE_SETTINGS, 'utf8'));
    return {
      theme: settings.theme || 'system',
      lang: settings.lang || 'system',
      uiFont: settings.uiFont || null,
      codeFont: settings.codeFont || null,
    };
  } catch {
    return { theme: 'system', lang: 'system', uiFont: null, codeFont: null };
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  const requestOrigin = String(req.headers.origin || '');
  res.__traceOrigin = requestOrigin;
  if (requestOrigin && !LOCAL_ORIGINS.has(requestOrigin)) {
    return json(res, 403, { error: 'Forbidden origin.' });
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...(LOCAL_ORIGINS.has(requestOrigin)
        ? { 'Access-Control-Allow-Origin': requestOrigin, Vary: 'Origin' }
        : { Vary: 'Origin' }),
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
    });
    return res.end();
  }
  if (req.method !== 'GET') return json(res, 405, { error: 'Only GET is supported.' });
  if (url.pathname === '/health') return json(res, 200, { ok: true, magpieBase: MAGPIE_BASE, port: PORT });
  if (url.pathname === '/api/theme') return json(res, 200, await magpieTheme());
  if (url.pathname === '/api/composition') {
    const session = url.searchParams.get('session') || '';
    const period = url.searchParams.get('period') || 'today';
    const from = url.searchParams.get('from') || '';
    const to = url.searchParams.get('to') || '';
    const days = ({ today: 1, '7d': 7, '30d': 30, all: 0 })[period] ?? 1;
    try {
      const prompts = from || to ? await routingPromptsBetween(from, to) : await routingPrompts(days);
      return json(res, 200, { ...aggregatePromptParts(prompts, session), days, session });
    } catch (err) {
      return json(res, 500, { error: '无法读取 Magpie 上下文构成', detail: String(err?.message || err) });
    }
  }
  if (url.pathname === '/api/range') {
    const from = url.searchParams.get('from') || '';
    const to = url.searchParams.get('to') || '';
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get('limit')) || 500));
    try {
      const range = await usageRange(from, to);
      return json(res, 200, {
        ...range.summary,
        summary: range.summary,
        rows: range.rows.slice(offset, offset + limit),
        offset,
        limit,
        total: range.rows.length,
        period: 'custom',
        from: range.from,
        to: range.to,
      });
    } catch (err) {
      return json(res, 400, { error: '无法读取日期范围', detail: String(err?.message || err) });
    }
  }
  if (url.pathname === '/api/summary') return proxyUsage(res, url, 'summary');
  if (url.pathname === '/api/requests') return proxyUsage(res, url, 'requests');
  if (url.pathname === '/api/context') {
    const session = url.searchParams.get('session') || '';
    if (!validSessionId(session)) return json(res, 400, { error: 'Invalid session id.' });
    try {
      return json(res, 200, await contextForSession(session));
    } catch (err) {
      return json(res, 500, { error: '无法读取 Codex 会话记录', detail: String(err?.message || err) });
    }
  }

  const routes = {
    '/': path.join(ROOT, 'dashboard', 'index.html'),
    '/index.html': path.join(ROOT, 'dashboard', 'index.html'),
    '/app.js': path.join(ROOT, 'dashboard', 'app.js'),
    '/style.css': path.join(ROOT, 'dashboard', 'style.css'),
    '/icon.svg': path.join(ROOT, 'page', 'icon.svg'),
  };
  const filePath = routes[url.pathname];
  if (!filePath) return json(res, 404, { error: 'Not found' });
  try { await serveFile(res, filePath); }
  catch (err) { json(res, 500, { error: '无法读取面板文件', detail: String(err?.message || err) }); }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Magpie Turn Trace listening on http://127.0.0.1:${PORT}/`);
  console.log(`Magpie API: ${MAGPIE_BASE}`);
  console.log('Only loopback is exposed. Press Ctrl+C to stop.');
});
