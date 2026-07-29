#!/usr/bin/env node
// scheduler.js — wakes the property agent on schedule and monitors for runaway sessions.
// Runs continuously inside the agent container.
// Merged from separate watchdog container: session-count and token-threshold checks
// now run in-process after each session and on a 5-minute timer.
// Decoupled from OB1 — local JSON store + Telegram getUpdates for inbound ops.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const store = require('./store');
const pending = require('./pending');

const FLAGS_DIR = process.env.FLAGS_DIR || '/flags';
const LOGS_DIR = process.env.LOGS_DIR || '/logs';
const AGENT_DIR = process.env.AGENT_DIR || '/agent';
const DATA_DIR = process.env.DATA_DIR || '/data';
const SYSTEM_PROMPT_FILE = path.join(AGENT_DIR, 'agent-system-prompt.md');
const TELEGRAM_OFFSET_FILE = path.join(DATA_DIR, 'telegram-offset.json');
const RUNNER_PATH = path.join(AGENT_DIR, 'agent-runner.js');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const COMMAND_TOKEN = process.env.COMMAND_TOKEN || '';
const COMMAND_TIMEOUT_MS = parseInt(process.env.COMMAND_TIMEOUT_MS || '120000', 10);

const THRESHOLDS = {
  sessionsPerHour: {
    warn:  parseInt(process.env.WARN_SESSIONS_PER_HOUR  || '4'),
    pause: parseInt(process.env.PAUSE_SESSIONS_PER_HOUR || '6'),
    kill:  parseInt(process.env.KILL_SESSIONS_PER_HOUR  || '8'),
  },
  sessionTokens: {
    warn: parseInt(process.env.WARN_SESSION_TOKENS || '40000'),
    kill: parseInt(process.env.KILL_SESSION_TOKENS || '60000'),
  },
};

let bankHolidays = new Set();
let sessionRunning = false;

function log(msg) {
  console.log(`[scheduler ${new Date().toISOString()}] ${msg}`);
}

// --- Bank holidays ---

function fetchBankHolidays() {
  return new Promise((resolve) => {
    https.get('https://www.gov.uk/bank-holidays.json', (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const events = json['england-and-wales']?.events || [];
          bankHolidays = new Set(events.map(e => e.date));
          log(`Loaded ${bankHolidays.size} UK bank holidays`);
        } catch (e) {
          log(`Failed to parse bank holidays: ${e.message}`);
        }
        resolve();
      });
    }).on('error', (e) => {
      log(`Failed to fetch bank holidays: ${e.message}`);
      resolve();
    });
  });
}

// --- Helpers ---

function isWorkday(now) {
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const dateStr = now.toISOString().split('T')[0];
  return !bankHolidays.has(dateStr);
}

function isOperatingHours(now) {
  const h = now.getHours();
  return h >= 6 && h < 18;
}

function flagExists(name) {
  try {
    fs.accessSync(path.join(FLAGS_DIR, name));
    return true;
  } catch {
    return false;
  }
}

function setFlag(name) {
  try {
    fs.mkdirSync(FLAGS_DIR, { recursive: true });
    fs.writeFileSync(path.join(FLAGS_DIR, name), new Date().toISOString());
    log(`Flag set: ${name}`);
  } catch (e) {
    log(`Could not set flag ${name}: ${e.message}`);
  }
}

function clearFlag(name) {
  try {
    const p = path.join(FLAGS_DIR, name);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      log(`Flag cleared: ${name}`);
    }
  } catch (e) {
    log(`Could not clear flag ${name}: ${e.message}`);
  }
}

// --- Pushover ---

function sendPushover(title, message, priority) {
  const token = process.env.PUSHOVER_TOKEN;
  const user  = process.env.PUSHOVER_USER;
  if (!token || !user) {
    log(`Pushover not configured — skipping: ${title}`);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const payload = JSON.stringify({ token, user, title, message, priority: priority || 0,
      ...(priority === 2 ? { retry: 60, expire: 3600 } : {}) });
    const req = https.request({
      hostname: 'api.pushover.net',
      path: '/1/messages.json',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => { res.resume(); log(`Pushover sent: ${title} (${res.statusCode})`); resolve(); });
    req.on('error', (e) => { log(`Pushover failed: ${e.message}`); resolve(); });
    req.write(payload);
    req.end();
  });
}

// --- Session log ---

function readSessionLog() {
  const sessionFile = path.join(LOGS_DIR, 'sessions.json');
  try {
    if (fs.existsSync(sessionFile)) return JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  } catch (e) {
    log(`Could not read sessions.json: ${e.message}`);
  }
  return [];
}

// --- Watchdog ---

let watchdogStatus = 'OK'; // OK | WARNED | PAUSED | KILLED
let lastDailyReset = null;

async function runWatchdogCheck() {
  const todayStr = new Date().toISOString().split('T')[0];
  if (lastDailyReset !== todayStr) {
    lastDailyReset = todayStr;
    if (flagExists('PAUSED') && !flagExists('KILLED')) {
      clearFlag('PAUSED');
      watchdogStatus = 'OK';
      log('Daily reset: PAUSED flag cleared');
    }
  }

  const sessions = readSessionLog();
  const hourAgo = Date.now() - 3600_000;
  const sessionsLastHour = sessions.filter(s => new Date(s.startedAt).getTime() > hourAgo).length;

  const largeSession = sessions.find(
    s => new Date(s.startedAt).getTime() > hourAgo && (s.totalTokens || 0) > THRESHOLDS.sessionTokens.warn
  );
  if (largeSession) {
    const tokens = largeSession.totalTokens;
    if (tokens > THRESHOLDS.sessionTokens.kill) {
      if (watchdogStatus !== 'KILLED') {
        watchdogStatus = 'KILLED';
        setFlag('PAUSED');
        setFlag('KILLED');
        await sendPushover('Property Agent Killed', `Session used ${tokens} tokens. Manual intervention required.`, 2);
      }
      return;
    } else if (watchdogStatus === 'OK') {
      watchdogStatus = 'WARNED';
      await sendPushover('Property Agent Warning', `Session used ${tokens} tokens (warn threshold: ${THRESHOLDS.sessionTokens.warn}).`, 1);
    }
  }

  if (sessionsLastHour >= THRESHOLDS.sessionsPerHour.kill) {
    if (watchdogStatus !== 'KILLED') {
      watchdogStatus = 'KILLED';
      setFlag('PAUSED');
      setFlag('KILLED');
      await sendPushover('Property Agent Killed', `${sessionsLastHour} sessions in last hour. Manual intervention required.`, 2);
    }
    return;
  }
  if (sessionsLastHour >= THRESHOLDS.sessionsPerHour.pause) {
    if (watchdogStatus !== 'PAUSED' && watchdogStatus !== 'KILLED') {
      watchdogStatus = 'PAUSED';
      setFlag('PAUSED');
      await sendPushover('Property Agent Paused', `${sessionsLastHour} sessions in last hour. Will resume at midnight or via /resume.`, 1);
    }
    return;
  }
  if (sessionsLastHour >= THRESHOLDS.sessionsPerHour.warn && watchdogStatus === 'OK') {
    watchdogStatus = 'WARNED';
    await sendPushover('Property Agent Warning', `${sessionsLastHour} sessions in last hour.`, 1);
  }

  if (watchdogStatus === 'WARNED' && !largeSession && sessionsLastHour < THRESHOLDS.sessionsPerHour.warn) {
    watchdogStatus = 'OK';
  }
}

// --- Telegram replies (local store) ---

async function fetchPendingTelegramReplies() {
  return store.listPendingReplies();
}

async function markTelegramRepliesProcessed(replies) {
  if (!replies.length) return;
  const ids = replies.map(r => r.id);
  const count = await store.markRepliesProcessed(ids);
  log(`Marked ${count} telegram reply(ies) as processed`);
}

// --- Session launcher ---

function parseAgentResult(stdout) {
  const marker = '===AGENT_RESULT===';
  const idx = stdout.lastIndexOf(marker);
  if (idx === -1) return null;
  const after = stdout.slice(idx + marker.length).trim();
  const line = after.split('\n').find((l) => l.trim().startsWith('{'));
  if (!line) return null;
  try {
    return JSON.parse(line.trim());
  } catch {
    return null;
  }
}

/**
 * Launch an OpenRouter agent session.
 * @returns {Promise<{code:number, reply:string, result:object|null, logPath:string}>}
 */
async function launchSession(trigger, context = null, options = {}) {
  const { skipTelegramQueue = false, skipInbox = false } = options;

  if (sessionRunning) {
    log(`Session already running — skipping ${trigger}`);
    return { code: 409, reply: '', result: null, logPath: null, skipped: true };
  }
  if (flagExists('PAUSED')) {
    log('PAUSED flag set — skipping session');
    return { code: 423, reply: 'Agent is paused', result: null, logPath: null, skipped: true };
  }
  if (flagExists('KILLED')) {
    log('KILLED flag set — skipping session');
    return { code: 423, reply: 'Agent is killed', result: null, logPath: null, skipped: true };
  }

  if (!fs.existsSync(SYSTEM_PROMPT_FILE)) {
    log(`Cannot read system prompt: missing ${SYSTEM_PROMPT_FILE}`);
    return { code: 1, reply: 'System prompt missing', result: null, logPath: null };
  }

  let pendingReplies = [];
  let repliesBlock = '';
  if (!skipTelegramQueue) {
    pendingReplies = await fetchPendingTelegramReplies();
    if (pendingReplies.length > 0) {
      const lines = pendingReplies.map(r =>
        `- id:${r.id} message_id:${r.message_id} received:${r.received_at} text:"${(r.text || '').replace(/"/g, "'")}"`
      ).join('\n');
      repliesBlock = ` PENDING TELEGRAM REPLIES (${pendingReplies.length} unprocessed — process these first per the Telegram Reply Processing instructions):\n${lines}`;
      log(`Injecting ${pendingReplies.length} pending telegram reply(ies) into session prompt`);
    }
  }

  let inboxBlock = '';
  if (!skipInbox) {
    const openInbox = await store.listInbox();
    if (openInbox.length > 0) {
      inboxBlock = ` OPEN INBOX (${openInbox.length} item(s) — process per Local Inbox Intake):\n${JSON.stringify(openInbox)}`;
      log(`Injecting ${openInbox.length} open inbox item(s) into session prompt`);
    }
  }

  const confirm = pending.getPending();
  let pendingBlock = '';
  if (confirm) {
    pendingBlock = ` PENDING CONFIRM (active — if this command answers it, resolve then pending_clear; otherwise pending_clear and treat as a new command):\n${JSON.stringify(confirm)}`;
  }

  const now = new Date();
  const prompt = `Run session. Trigger: ${trigger}. Current time: ${now.toISOString()}.${repliesBlock}${inboxBlock}${pendingBlock}${context ? ` Context: ${context}` : ''}`;

  const args = [
    RUNNER_PATH,
    '--trigger', trigger,
    '--system-file', SYSTEM_PROMPT_FILE,
    '--prompt', prompt,
  ];

  log(`Launching ${trigger} session via OpenRouter runner`);
  sessionRunning = true;

  const logPath = path.join(LOGS_DIR, `session-${trigger}-${Date.now()}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });

  return new Promise((resolve) => {
    const proc = spawn('node', args, {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: AGENT_DIR,
    });

    let stdoutBuf = '';
    proc.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
      logStream.write(chunk);
    });
    proc.stderr.on('data', (chunk) => {
      logStream.write(chunk);
    });

    proc.on('close', async (code) => {
      logStream.end();
      sessionRunning = false;
      const result = parseAgentResult(stdoutBuf);
      const reply = (result && result.reply) || '';
      log(`${trigger} session ended (exit ${code}) — log: ${logPath}`);
      if (code === 0 && pendingReplies.length > 0) {
        try { await markTelegramRepliesProcessed(pendingReplies); } catch (e) { log(`markTelegramRepliesProcessed failed: ${e.message}`); }
      }
      try { await runWatchdogCheck(); } catch (e) { log(`Watchdog check failed: ${e.message}`); }
      try {
        const stillPending = await store.listPendingReplies();
        if (stillPending.length > 0 && !flagExists('PAUSED') && !flagExists('KILLED') && trigger !== 'command') {
          log(`${stillPending.length} telegram reply(ies) still pending — launching follow-up session`);
          launchSession('manual', 'Process pending Telegram replies and respond via Telegram');
        }
      } catch (e) {
        log(`Pending-reply follow-up check failed: ${e.message}`);
      }
      resolve({ code: code ?? 1, reply, result, logPath });
    });

    proc.on('error', (e) => {
      logStream.end();
      sessionRunning = false;
      log(`Failed to start ${trigger} session: ${e.message}`);
      resolve({ code: 1, reply: `Failed to start: ${e.message}`, result: null, logPath });
    });
  });
}

function checkCommandAuth(req) {
  if (!COMMAND_TOKEN) return false;
  const header = req.headers['x-command-token'] || '';
  const auth = req.headers.authorization || '';
  if (header && header === COMMAND_TOKEN) return true;
  if (auth.startsWith('Bearer ') && auth.slice(7) === COMMAND_TOKEN) return true;
  return false;
}

// --- Scheduler tick ---

let lastTick = { hm: -1, propertyCheckHour: -1 };

async function tick() {
  const now = new Date();
  const hm = now.getHours() * 100 + now.getMinutes();
  const workday = isWorkday(now);

  if (!workday) return;
  if (hm === lastTick.hm) return;
  lastTick.hm = hm;

  if (hm === 600) { await launchSession('morning'); return; }

  const operating = isOperatingHours(now);
  if (!operating) return;

  const h = now.getHours();
  if (now.getMinutes() === 0 && h >= 8 && h < 18 && h % 2 === 0) {
    if (h !== lastTick.propertyCheckHour) {
      lastTick.propertyCheckHour = h;
      await launchSession('property-check');
    }
  }
}

// --- HTTP control server ---

const VALID_TRIGGERS = ['morning', 'property-check', 'manual', 'http-trigger', 'command'];
const HTTP_PORT = process.env.HTTP_PORT || 3001;

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => resolve(body));
  });
}

function startHttpServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost`);

    if (req.method === 'GET' && url.pathname === '/status') {
      const sessions = readSessionLog();
      const hourAgo = Date.now() - 3600_000;
      const [openInbox, pendingTelegramReplies] = await Promise.all([
        store.listInbox(),
        store.listPendingReplies(),
      ]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        sessionRunning,
        watchdogStatus,
        paused: flagExists('PAUSED'),
        killed: flagExists('KILLED'),
        runner: 'openrouter',
        model: process.env.AGENT_MODEL || 'google/gemini-2.5-flash',
        openInbox: openInbox.length,
        pendingTelegramReplies: pendingTelegramReplies.length,
        pendingConfirm: pending.getPending(),
        sessionsLastHour: sessions.filter(s => new Date(s.startedAt).getTime() > hourAgo).length,
        recentSessions: sessions.slice(-5),
        time: new Date().toISOString(),
      }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/trigger') {
      const body = await readBody(req);
      let triggerType, reason;
      try {
        const parsed = JSON.parse(body || '{}');
        triggerType = parsed.type;
        reason = parsed.reason;
      } catch {
        triggerType = url.searchParams.get('type');
        reason = url.searchParams.get('reason');
      }

      // Accept legacy "ob-trigger" as http-trigger
      if (triggerType === 'ob-trigger') triggerType = 'http-trigger';

      if (!triggerType || !VALID_TRIGGERS.includes(triggerType)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `type must be one of: ${VALID_TRIGGERS.join(', ')}` }));
        return;
      }

      if (sessionRunning) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Session already running' }));
        return;
      }

      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, trigger: triggerType, reason: reason || null }));

      if (reason) log(`HTTP trigger: ${triggerType} — ${reason}`);
      launchSession(triggerType, reason || null);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/inbox') {
      const body = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(body || '{}');
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' }));
        return;
      }

      if (!parsed.property) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'property is required' }));
        return;
      }

      const record = await store.addInboxItem({
        property: parsed.property,
        type: parsed.type || 'maintenance',
        status: parsed.status || 'open',
        note: parsed.note || '',
        date: parsed.date,
        order_number: parsed.order_number || null,
        source: parsed.source || 'http',
      });
      log(`Inbox item added: ${record.id} ${record.property} ${record.order_number || ''} (${record.status})`);

      const urgent = String(record.status).toLowerCase() === 'urgent';
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, item: record, sessionTriggered: urgent && !sessionRunning }));

      if (urgent && !sessionRunning && !flagExists('PAUSED') && !flagExists('KILLED')) {
        launchSession('property-check', `Urgent inbox item ${record.order_number || record.id} at ${record.property}`);
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/resume') {
      clearFlag('PAUSED');
      clearFlag('KILLED');
      watchdogStatus = 'OK';
      log('Agent manually resumed via /resume');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'Agent resumed' }));
      return;
    }

    // Invoice ledger — replaces the Open Brain [GCAL-INVOICED] thoughts the
    // invoicing agent used to write. Called by property_invoicing over HTTP.
    if (req.method === 'POST' && (url.pathname === '/invoice-check' || url.pathname === '/invoice-mark')) {
      if (!checkCommandAuth(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized — set X-Command-Token' }));
        return;
      }

      const body = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(body || '{}');
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' }));
        return;
      }

      const eventId = parsed.event_id || parsed.eventId;
      if (!eventId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'event_id is required' }));
        return;
      }

      // Never let a store failure surface as a clean "not invoiced" — the
      // caller would read that as permission to bill again.
      try {
        if (url.pathname === '/invoice-check') {
          const row = await store.invoiceCheck(eventId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, invoiced: Boolean(row), row: row || null }));
          return;
        }

        const row = await store.invoiceMark(eventId, {
          acronym: parsed.acronym ?? null,
          hours: parsed.hours ?? null,
        });
        const duplicate = Boolean(row.duplicate);
        log(`Invoice ledger: ${eventId} ${duplicate ? 'already marked (duplicate)' : 'marked'}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, duplicate, row }));
      } catch (e) {
        log(`Invoice ledger error on ${url.pathname} for ${eventId}: ${e.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // Refresh tenant-contacts.json from /output/work_orders PDFs (called by WO processor)
    if (req.method === 'POST' && url.pathname === '/wo-scan') {
      log('HTTP /wo-scan');
      const proc = spawn('node', [path.join(AGENT_DIR, 'wo.js'), 'scan'], {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => { stdout += d; });
      proc.stderr.on('data', (d) => { stderr += d; });
      proc.on('close', (code) => {
        let result;
        try {
          result = JSON.parse(stdout.trim() || '{}');
        } catch {
          result = { ok: code === 0, raw: stdout.trim(), stderr: stderr.trim() };
        }
        if (code !== 0 && result.ok !== false) result.ok = false;
        if (stderr.trim()) result.stderr = stderr.trim();
        log(`wo-scan done: scanned=${result.scanned ?? '?'} properties=${result.properties ?? '?'}`);
        res.writeHead(code === 0 ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      });
      return;
    }

    // Siri Shortcuts / voice commands — sync reply suitable to speak aloud
    if (req.method === 'POST' && url.pathname === '/command') {
      if (!checkCommandAuth(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized — set X-Command-Token' }));
        return;
      }

      const body = await readBody(req);
      let text = '';
      try {
        const parsed = JSON.parse(body || '{}');
        text = (parsed.text || parsed.command || '').trim();
      } catch {
        text = (body || '').trim();
      }
      if (!text) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'text is required' }));
        return;
      }

      if (sessionRunning) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Session already running — try again shortly' }));
        return;
      }

      log(`HTTP /command: ${text.slice(0, 120)}`);
      const started = Date.now();
      const outcomePromise = launchSession(
        'command',
        `VOICE COMMAND (reply in 1–2 short speakable sentences; also telegram_send the same answer): ${text}`,
        { skipTelegramQueue: true, skipInbox: true }
      );

      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; }, COMMAND_TIMEOUT_MS);
      const outcome = await outcomePromise;
      clearTimeout(timer);

      if (outcome.skipped) {
        res.writeHead(outcome.code === 409 ? 409 : 423, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: outcome.reply || 'skipped', pending: pending.getPending() }));
        return;
      }

      const reply = outcome.reply || (outcome.result && outcome.result.reply) || '';
      const ok = outcome.code === 0 && !!(outcome.result && outcome.result.ok !== false);
      res.writeHead(ok ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok,
        reply,
        pending: pending.getPending(),
        model: outcome.result?.model || null,
        usage: outcome.result?.usage || null,
        elapsed_ms: Date.now() - started,
        timedOut,
        log: outcome.logPath,
      }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(HTTP_PORT, () => {
    log(`Control server listening on port ${HTTP_PORT}`);
  });
}

// --- Telegram getUpdates (property bot) ---

function telegramApi(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!TELEGRAM_BOT_TOKEN) return resolve(null);
    const payload = JSON.stringify(params);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_BOT_TOKEN}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (!json.ok) return reject(new Error(JSON.stringify(json)));
          resolve(json.result);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function sendTelegram(chatId, text) {
  return telegramApi('sendMessage', { chat_id: chatId, text }).catch((e) => {
    log(`sendTelegram failed: ${e.message}`);
  });
}

function readTelegramOffset() {
  try {
    if (fs.existsSync(TELEGRAM_OFFSET_FILE)) {
      const j = JSON.parse(fs.readFileSync(TELEGRAM_OFFSET_FILE, 'utf8'));
      return j.offset || 0;
    }
  } catch { /* ignore */ }
  return 0;
}

function writeTelegramOffset(offset) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TELEGRAM_OFFSET_FILE, JSON.stringify({ offset }, null, 2));
  } catch (e) {
    log(`Could not write telegram offset: ${e.message}`);
  }
}

async function handleTelegramCommand(chatId, command, args) {
  let result = '';

  if (command === 'status') {
    const sessions = readSessionLog();
    const hourAgo = Date.now() - 3600_000;
    const sessionsLastHour = sessions.filter(s => new Date(s.startedAt).getTime() > hourAgo).length;
    const last = sessions[sessions.length - 1];
    const [openInbox, pendingReplies] = await Promise.all([
      store.listInbox(),
      store.listPendingReplies(),
    ]);
    result = [
      `*Property Agent Status*`,
      `Running: ${sessionRunning ? 'yes' : 'no'}`,
      `Paused: ${flagExists('PAUSED') ? 'yes' : 'no'}`,
      `Killed: ${flagExists('KILLED') ? 'yes' : 'no'}`,
      `Watchdog: ${watchdogStatus}`,
      `Open inbox: ${openInbox.length}`,
      `Pending replies: ${pendingReplies.length}`,
      `Sessions last hour: ${sessionsLastHour}`,
      last ? `Last session: ${last.trigger} at ${new Date(last.startedAt).toLocaleTimeString('en-GB')}` : '',
    ].filter(Boolean).join('\n');
  } else if (command === 'trigger') {
    const type = (args || 'manual').trim();
    if (!VALID_TRIGGERS.includes(type)) {
      result = `Unknown type "${type}". Valid: ${VALID_TRIGGERS.join(', ')}`;
    } else if (sessionRunning) {
      result = 'A session is already running.';
    } else if (flagExists('PAUSED')) {
      result = 'Agent is paused. Use /resume first.';
    } else {
      launchSession(type);
      result = `Session "${type}" started.`;
    }
  } else if (command === 'maintenance') {
    if (!args) {
      result = 'No maintenance details provided.';
    } else if (sessionRunning) {
      result = 'A session is already running — maintenance task will be picked up in the next property-check.';
    } else {
      launchSession('manual', `Log this property maintenance issue using add_maintenance_task: ${args}`);
      result = `Logging maintenance task: "${args}"`;
    }
  } else if (command === 'resume') {
    clearFlag('PAUSED');
    clearFlag('KILLED');
    watchdogStatus = 'OK';
    result = 'Agent resumed. Flags cleared.';
  } else if (command === 'inbox') {
    const items = await store.listInbox();
    if (!items.length) {
      result = 'Inbox is empty.';
    } else {
      result = items.slice(0, 10).map(i =>
        `• ${i.property} ${i.order_number || ''} [${i.status}] ${i.note || ''}`.trim()
      ).join('\n');
    }
  } else if (command === 'start' || command === 'help') {
    result = [
      'Property Agent commands:',
      '/status — agent status',
      '/trigger [morning|property-check|manual] — start a session',
      '/resume — clear pause/kill flags',
      '/maintenance <details> — log a maintenance issue',
      '/inbox — list open inbox items',
      'Or reply with free text about a job (e.g. 59BC-1.5hr).',
    ].join('\n');
  } else {
    result = `Unknown command: /${command}. Try /help.`;
  }

  await sendTelegram(chatId, result);
  log(`Telegram command /${command} → ${result.split('\n')[0]}`);
}

async function pollTelegramUpdates() {
  if (!TELEGRAM_BOT_TOKEN) return;

  let offset = readTelegramOffset();
  let updates;
  let queuedFreeText = false;
  try {
    updates = await telegramApi('getUpdates', {
      offset,
      timeout: 0,
      allowed_updates: ['message'],
    });
  } catch (e) {
    log(`getUpdates failed: ${e.message}`);
    return;
  }
  if (!Array.isArray(updates) || !updates.length) return;

  for (const u of updates) {
    offset = u.update_id + 1;
    const msg = u.message;
    if (!msg || !msg.text) continue;

    const chatId = String(msg.chat.id);
    if (TELEGRAM_CHAT_ID && chatId !== String(TELEGRAM_CHAT_ID)) continue;

    const text = msg.text.trim();
    if (text.startsWith('/')) {
      const [rawCmd, ...rest] = text.slice(1).split(/\s+/);
      const command = (rawCmd || '').split('@')[0].toLowerCase();
      await handleTelegramCommand(chatId, command, rest.join(' '));
    } else {
      const reply = await store.addTelegramReply({
        text,
        message_id: msg.message_id,
        received_at: new Date((msg.date || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
      });
      log(`Queued telegram reply id=${reply.id}: ${text.slice(0, 80)}`);
      // Free-text must not wait for the next morning/property-check (esp. weekends).
      queuedFreeText = true;
    }
  }

  writeTelegramOffset(offset);

  if (queuedFreeText) {
    if (sessionRunning) {
      log('Telegram reply queued — session already running; will process after it ends');
    } else {
      launchSession('manual', 'Process pending Telegram replies and respond via Telegram');
    }
  }
}

// --- Entry point ---

async function main() {
  log('Starting');
  fs.mkdirSync(DATA_DIR, { recursive: true });

  await fetchBankHolidays();
  setInterval(fetchBankHolidays, 24 * 60 * 60 * 1000);

  startHttpServer();

  setInterval(tick, 60_000);

  setInterval(async () => {
    try { await runWatchdogCheck(); } catch (e) { log(`Watchdog check failed: ${e.message}`); }
  }, 5 * 60_000);

  // Telegram inbound — every 20s
  setInterval(async () => {
    try { await pollTelegramUpdates(); } catch (e) { log(`Telegram poll failed: ${e.message}`); }
  }, 20_000);

  await tick();
  await runWatchdogCheck();
  try { await pollTelegramUpdates(); } catch (e) { log(`Telegram poll failed: ${e.message}`); }

  // Catch replies queued while getUpdates was broken / over a weekend with no schedule.
  try {
    const backlog = await store.listPendingReplies();
    if (backlog.length > 0) {
      log(`Startup: ${backlog.length} pending telegram reply(ies) — launching session`);
      launchSession('manual', 'Process pending Telegram replies and respond via Telegram');
    }
  } catch (e) {
    log(`Startup pending-reply check failed: ${e.message}`);
  }

  log('Scheduler running (standalone — no OB1)');
}

main().catch(e => {
  console.error(`[scheduler] Fatal: ${e.message}`);
  process.exit(1);
});
