#!/usr/bin/env node
// scheduler.js — wakes the claude-nas-agent on schedule.
// Runs continuously inside the agent container.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const FLAGS_DIR = process.env.FLAGS_DIR || '/flags';
const LOGS_DIR = process.env.LOGS_DIR || '/logs';
const AGENT_DIR = process.env.AGENT_DIR || '/agent';
const SYSTEM_PROMPT_FILE = path.join(AGENT_DIR, 'agent-system-prompt.md');

let bankHolidays = new Set();
let sessionRunning = false;

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

function log(msg) {
  console.log(`[scheduler ${new Date().toISOString()}] ${msg}`);
}

function isWorkday(now) {
  const day = now.getDay(); // 0=Sun, 6=Sat
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

// --- Session launcher ---

async function launchSession(trigger) {
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

  const now = new Date();
  const prompt = `Run session. Trigger: ${trigger}. Current time: ${now.toISOString()}.`;

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

  proc.on('close', (code) => {
    logStream.end();
    sessionRunning = false;
    log(`${trigger} session ended (exit ${code}) — log: ${logPath}`);
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
  const operating = isOperatingHours(now);

  if (!workday || !operating) return;
  if (hm === lastTick.hm) return; // already fired this minute
  lastTick.hm = hm;

  // Fixed daily sessions
  if (hm === 600)  { await launchSession('morning'); return; }
  if (hm === 1200) { await launchSession('checkin'); return; }
  if (hm === 1800) { await launchSession('evening'); return; }

  // Property check every 2 hours, 08:00–18:00, on the hour
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        sessionRunning,
        paused: flagExists('PAUSED'),
        killed: flagExists('KILLED'),
        time: new Date().toISOString(),
      }));
      return;
    }

    // POST /trigger  body: {"type":"morning"} or ?type=morning
    if (req.method === 'POST' && url.pathname === '/trigger') {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', async () => {
        let triggerType;
        try {
          triggerType = JSON.parse(body).type;
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
        res.end(JSON.stringify({ ok: true, trigger: triggerType }));

        // Launch after response is sent
        launchSession(triggerType);
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(HTTP_PORT, () => {
    log(`Control server listening on port ${HTTP_PORT}`);
  });
}

// --- Entry point ---

async function main() {
  log('Starting');

  await fetchBankHolidays();
  // Refresh holidays daily at midnight
  setInterval(fetchBankHolidays, 24 * 60 * 60 * 1000);

  startHttpServer();

  // Tick every minute
  setInterval(tick, 60_000);

  // Fire immediately in case we started mid-window
  await tick();

  log('Scheduler running');
}

main().catch(e => {
  console.error(`[scheduler] Fatal: ${e.message}`);
  process.exit(1);
});
