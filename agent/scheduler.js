#!/usr/bin/env node
// scheduler.js — wakes the claude-nas-agent on schedule and monitors for runaway sessions.
// Runs continuously inside the agent container.
// Merged from separate watchdog container: session-count and token-threshold checks
// now run in-process after each session and on a 5-minute timer.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const FLAGS_DIR = process.env.FLAGS_DIR || '/flags';
const LOGS_DIR = process.env.LOGS_DIR || '/logs';
const AGENT_DIR = process.env.AGENT_DIR || '/agent';
const SYSTEM_PROMPT_FILE = path.join(AGENT_DIR, 'agent-system-prompt.md');

const SUPABASE_URL = process.env.SUPABASE_PROJECT_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// --- Watchdog thresholds (from env, same defaults as old watchdog container) ---
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

// --- Logging ---

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

// --- Watchdog check (runs after each session + every 5 min) ---

let watchdogStatus = 'OK'; // OK | WARNED | PAUSED | KILLED
let lastDailyReset = null;

async function runWatchdogCheck() {
  // Daily reset of PAUSED flag (not KILLED — that requires manual intervention)
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

  // Check for large sessions in the last hour
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
        await sendPushover('Claude Agent Killed', `Session used ${tokens} tokens. Manual intervention required.`, 2);
      }
      return;
    } else if (watchdogStatus === 'OK') {
      watchdogStatus = 'WARNED';
      await sendPushover('Claude Agent Warning', `Session used ${tokens} tokens (warn threshold: ${THRESHOLDS.sessionTokens.warn}).`, 1);
    }
  }

  // Check session rate
  if (sessionsLastHour >= THRESHOLDS.sessionsPerHour.kill) {
    if (watchdogStatus !== 'KILLED') {
      watchdogStatus = 'KILLED';
      setFlag('PAUSED');
      setFlag('KILLED');
      await sendPushover('Claude Agent Killed', `${sessionsLastHour} sessions in last hour. Manual intervention required.`, 2);
    }
    return;
  }
  if (sessionsLastHour >= THRESHOLDS.sessionsPerHour.pause) {
    if (watchdogStatus !== 'PAUSED' && watchdogStatus !== 'KILLED') {
      watchdogStatus = 'PAUSED';
      setFlag('PAUSED');
      await sendPushover('Claude Agent Paused', `${sessionsLastHour} sessions in last hour. Will resume at midnight or via /resume.`, 1);
    }
    return;
  }
  if (sessionsLastHour >= THRESHOLDS.sessionsPerHour.warn && watchdogStatus === 'OK') {
    watchdogStatus = 'WARNED';
    await sendPushover('Claude Agent Warning', `${sessionsLastHour} sessions in last hour.`, 1);
  }

  if (watchdogStatus === 'WARNED' && !largeSession && sessionsLastHour < THRESHOLDS.sessionsPerHour.warn) {
    watchdogStatus = 'OK';
  }
}

// --- Session launcher ---

async function launchSession(trigger, context = null) {
  if (sessionRunning) {
    log(`Session already running — skipping ${trigger}`);
    return;
  }
  if (flagExists('PAUSED')) {
    log('PAUSED flag set — skipping session');
    return;
  }
  if (flagExists('KILLED')) {
    log('KILLED flag set — skipping session');
    return;
  }

  let systemPrompt;
  try {
    systemPrompt = fs.readFileSync(SYSTEM_PROMPT_FILE, 'utf8');
  } catch (e) {
    log(`Cannot read system prompt: ${e.message}`);
    return;
  }

  const pendingReplies = await fetchPendingTelegramReplies();
  let repliesBlock = '';
  if (pendingReplies.length > 0) {
    const lines = pendingReplies.map(r =>
      `- id:${r.id} message_id:${r.metadata?.telegram_message_id} received:${r.metadata?.received_at} text:"${r.content.replace(/^\[TELEGRAM-REPLY\]\s*/, '')}"`
    ).join('\n');
    repliesBlock = ` PENDING TELEGRAM REPLIES (${pendingReplies.length} unprocessed — process these first per the Telegram Reply Processing instructions):\n${lines}`;
    log(`Injecting ${pendingReplies.length} pending telegram reply(ies) into session prompt`);
  }

  const now = new Date();
  const prompt = `Run session. Trigger: ${trigger}. Current time: ${now.toISOString()}.${repliesBlock}${context ? ` Context: ${context}` : ''}`;

  const args = [
    '--print',
    '--dangerously-skip-permissions',
    '--system-prompt', systemPrompt,
    '--max-budget-usd', '1.50',
    prompt,
  ];

  log(`Launching ${trigger} session`);
  sessionRunning = true;

  const logPath = path.join(LOGS_DIR, `session-${trigger}-${Date.now()}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });

  const proc = spawn('claude', args, {
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proc.stdout.pipe(logStream);
  proc.stderr.pipe(logStream);

  proc.on('close', async (code) => {
    logStream.end();
    sessionRunning = false;
    log(`${trigger} session ended (exit ${code}) — log: ${logPath}`);
    if (code === 0 && pendingReplies.length > 0) {
      try { await markTelegramRepliesProcessed(pendingReplies); } catch (e) { log(`markTelegramRepliesProcessed failed: ${e.message}`); }
    }
    // Run watchdog check after every session
    try { await runWatchdogCheck(); } catch (e) { log(`Watchdog check failed: ${e.message}`); }
  });

  proc.on('error', (e) => {
    logStream.end();
    sessionRunning = false;
    log(`Failed to start ${trigger} session: ${e.message}`);
  });
}

// --- Scheduler tick (runs every minute) ---

let lastTick = { hm: -1, propertyCheckHour: -1 };

async function tick() {
  const now = new Date();
  const hm = now.getHours() * 100 + now.getMinutes();
  const workday = isWorkday(now);

  if (!workday) return;
  if (hm === lastTick.hm) return;
  lastTick.hm = hm;

  // Named sessions fire regardless of the property-check operating window
  if (hm === 600)  { await launchSession('morning'); return; }
  if (hm === 1200) { await launchSession('checkin'); return; }
  if (hm === 1800) { await launchSession('evening'); return; }

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

const VALID_TRIGGERS = ['morning', 'checkin', 'evening', 'property-check', 'manual'];
const HTTP_PORT = process.env.HTTP_PORT || 3001;

function startHttpServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost`);

    // GET /status
    if (req.method === 'GET' && url.pathname === '/status') {
      const sessions = readSessionLog();
      const hourAgo = Date.now() - 3600_000;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        sessionRunning,
        watchdogStatus,
        paused: flagExists('PAUSED'),
        killed: flagExists('KILLED'),
        sessionsLastHour: sessions.filter(s => new Date(s.startedAt).getTime() > hourAgo).length,
        recentSessions: sessions.slice(-5),
        time: new Date().toISOString(),
      }));
      return;
    }

    // POST /trigger  body: {"type":"morning"}
    if (req.method === 'POST' && url.pathname === '/trigger') {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', async () => {
        let triggerType, reason;
        try {
          const parsed = JSON.parse(body);
          triggerType = parsed.type;
          reason = parsed.reason;
        } catch {
          triggerType = url.searchParams.get('type');
        }

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

        if (reason) log(`External trigger: ${triggerType} — ${reason}`);
        launchSession(triggerType);
      });
      return;
    }

    // POST /resume — clear PAUSED and KILLED flags
    if (req.method === 'POST' && url.pathname === '/resume') {
      clearFlag('PAUSED');
      clearFlag('KILLED');
      watchdogStatus = 'OK';
      log('Agent manually resumed via /resume');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'Agent resumed' }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(HTTP_PORT, () => {
    log(`Control server listening on port ${HTTP_PORT}`);
  });
}

// --- Supabase REST helper ---

function supabaseRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    if (!SUPABASE_URL || !SUPABASE_KEY) return resolve(null);
    const url = new URL(`${SUPABASE_URL}/rest/v1${path}`);
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
    };
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// --- Pending Telegram replies fetcher & processor ---

async function markTelegramRepliesProcessed(replies) {
  if (!SUPABASE_URL || !SUPABASE_KEY || !replies.length) return;
  log(`Marking ${replies.length} telegram reply thought(s) as processed`);
  for (const reply of replies) {
    try {
      const merged = { ...(reply.metadata || {}), processed: true };
      await supabaseRequest('PATCH', `/thoughts?id=eq.${reply.id}`, { metadata: merged });
    } catch (e) {
      log(`Failed to mark thought ${reply.id} processed: ${e.message}`);
    }
  }
}

async function fetchPendingTelegramReplies() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];
  try {
    const rows = await supabaseRequest('GET',
      '/thoughts?content=like.*TELEGRAM-REPLY*&select=id,content,metadata,created_at&order=created_at.asc&limit=20'
    );
    if (!Array.isArray(rows)) return [];
    return rows.filter(r => !r.metadata?.processed);
  } catch (e) {
    log(`fetchPendingTelegramReplies error: ${e.message}`);
    return [];
  }
}

// --- Telegram outbound helper ---

function sendTelegram(chatId, text) {
  return new Promise((resolve) => {
    if (!TELEGRAM_BOT_TOKEN) return resolve();
    const payload = JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => { res.resume(); resolve(); });
    req.on('error', () => resolve());
    req.write(payload);
    req.end();
  });
}

// --- Telegram command processor ---

async function processTelegramCommands() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;

  const rows = await supabaseRequest('GET',
    '/telegram_commands?status=eq.pending&order=created_at.asc&limit=10&select=*'
  );
  if (!rows || !rows.length) return;

  for (const row of rows) {
    const { id, command, args, chat_id } = row;
    let result = '';

    try {
      if (command === 'status') {
        const sessions = readSessionLog();
        const hourAgo = Date.now() - 3600_000;
        const sessionsLastHour = sessions.filter(s => new Date(s.startedAt).getTime() > hourAgo).length;
        const last = sessions[sessions.length - 1];
        result = [
          `*Property Agent Status*`,
          `Running: ${sessionRunning ? 'yes' : 'no'}`,
          `Paused: ${flagExists('PAUSED') ? 'yes ⚠️' : 'no'}`,
          `Killed: ${flagExists('KILLED') ? 'yes 🚨' : 'no'}`,
          `Watchdog: ${watchdogStatus}`,
          `Sessions last hour: ${sessionsLastHour}`,
          last ? `Last session: ${last.trigger} at ${new Date(last.startedAt).toLocaleTimeString('en-GB')}` : '',
        ].filter(Boolean).join('\n');

      } else if (command === 'trigger') {
        const type = (args || 'manual').trim();
        const valid = ['morning', 'checkin', 'evening', 'property-check', 'manual'];
        if (!valid.includes(type)) {
          result = `Unknown type "${type}". Valid: ${valid.join(', ')}`;
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

      } else {
        result = `Unknown command: ${command}`;
      }
    } catch (e) {
      result = `Error: ${e.message}`;
    }

    await sendTelegram(chat_id, result);
    await supabaseRequest('PATCH',
      `/telegram_commands?id=eq.${id}`,
      { status: 'done', result, processed_at: new Date().toISOString() }
    );
    log(`Processed Telegram command: ${command} → ${result.split('\n')[0]}`);
  }
}

// --- Entry point ---

async function main() {
  log('Starting');

  await fetchBankHolidays();
  setInterval(fetchBankHolidays, 24 * 60 * 60 * 1000);

  startHttpServer();

  // Tick every minute
  setInterval(tick, 60_000);

  // Watchdog check every 5 minutes (independent of sessions)
  setInterval(async () => {
    try { await runWatchdogCheck(); } catch (e) { log(`Watchdog check failed: ${e.message}`); }
  }, 5 * 60_000);

  // Telegram command processor — every minute
  setInterval(async () => {
    try { await processTelegramCommands(); } catch (e) { log(`Command processor failed: ${e.message}`); }
  }, 60_000);

  await tick();
  await runWatchdogCheck();

  log('Scheduler running');
}

main().catch(e => {
  console.error(`[scheduler] Fatal: ${e.message}`);
  process.exit(1);
});
