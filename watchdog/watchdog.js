#!/usr/bin/env node
'use strict';

const fs    = require('fs');
const path  = require('path');
const http  = require('http');
const https = require('https');

const CONFIG = {
  anthropicApiKey:  process.env.ANTHROPIC_API_KEY,
  pushoverToken:    process.env.PUSHOVER_TOKEN,
  pushoverUser:     process.env.PUSHOVER_USER,
  flagsDir:  process.env.FLAGS_DIR  || '/flags',
  logsDir:   process.env.LOGS_DIR   || '/logs',
  stateFile: process.env.STATE_FILE || '/logs/watchdog-state.json',
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '300000'),
  thresholds: {
    hourlySpend: {
      warn:  parseFloat(process.env.WARN_HOURLY_USD  || '0.63'),
      pause: parseFloat(process.env.PAUSE_HOURLY_USD || '1.27'),
      kill:  parseFloat(process.env.KILL_HOURLY_USD  || '2.54'),
    },
    dailySpend: {
      warn:  parseFloat(process.env.WARN_DAILY_USD  || '2.54'),
      pause: parseFloat(process.env.PAUSE_DAILY_USD || '3.81'),
      kill:  parseFloat(process.env.KILL_DAILY_USD  || '6.35'),
    },
    sessionsPerHour: {
      warn:  parseInt(process.env.WARN_SESSIONS_PER_HOUR  || '4'),
      pause: parseInt(process.env.PAUSE_SESSIONS_PER_HOUR || '6'),
      kill:  parseInt(process.env.KILL_SESSIONS_PER_HOUR  || '8'),
    },
    sessionTokens: {
      warn: parseInt(process.env.WARN_SESSION_TOKENS || '40000'),
      kill: parseInt(process.env.KILL_SESSION_TOKENS || '60000'),
    },
  },
};

let state = {
  lastCheck: null,
  currentStatus: 'OK',
  dailySpendUsd: 0,
  hourlySpendUsd: 0,
  sessionsThisHour: 0,
  lastDailyReset: null,
  lastHourlyReset: null,
  history: [],
};

function log(level, message, data = {}) {
  const entry = { ts: new Date().toISOString(), level, message, ...data };
  console.log(JSON.stringify(entry));
  try {
    fs.mkdirSync(CONFIG.logsDir, { recursive: true });
    fs.appendFileSync(path.join(CONFIG.logsDir, 'watchdog.log'), JSON.stringify(entry) + '\n');
  } catch (e) { console.error('Failed to write log:', e.message); }
}

function loadState() {
  try {
    if (fs.existsSync(CONFIG.stateFile)) {
      state = { ...state, ...JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8')) };
      log('INFO', 'State loaded', { status: state.currentStatus });
    }
  } catch (e) { log('WARN', 'Could not load state', { error: e.message }); }
}

function saveState() {
  try {
    fs.mkdirSync(CONFIG.logsDir, { recursive: true });
    fs.writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 2));
  } catch (e) { log('ERROR', 'Could not save state', { error: e.message }); }
}

function readSessionLog() {
  const sessionFile = path.join(CONFIG.logsDir, 'sessions.json');
  try {
    if (fs.existsSync(sessionFile)) return JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  } catch (e) { log('WARN', 'Could not read session log', { error: e.message }); }
  return [];
}

function countRecentSessions(sessions, windowMs) {
  const cutoff = Date.now() - windowMs;
  return sessions.filter(s => new Date(s.startedAt).getTime() > cutoff).length;
}

function findLargeSession(sessions, tokenThreshold) {
  const oneHourAgo = Date.now() - 3600000;
  return sessions.find(
    s => new Date(s.startedAt).getTime() > oneHourAgo && (s.totalTokens || 0) > tokenThreshold
  );
}

function sendNotification(title, message, priority) {
  if (priority === undefined) priority = 0;
  return new Promise((resolve) => {
    if (!CONFIG.pushoverToken || !CONFIG.pushoverUser) {
      log('WARN', 'Pushover not configured — skipping notification');
      return resolve();
    }
    const payload = {
      token:    CONFIG.pushoverToken,
      user:     CONFIG.pushoverUser,
      title:    title,
      message:  message,
      priority: priority,
    };
    if (priority === 2) {
      payload.retry  = 60;
      payload.expire = 3600;
    }
    const body = JSON.stringify(payload);
    const options = {
      hostname: 'api.pushover.net',
      path:     '/1/messages.json',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      res.resume();
      log('INFO', 'Pushover notification sent', { title: title, priority: priority, status: res.statusCode });
      resolve();
    });
    req.on('error', (e) => {
      log('ERROR', 'Pushover failed', { error: e.message });
      resolve();
    });
    req.write(body);
    req.end();
  });
}

function setFlag(name) {
  try {
    fs.mkdirSync(CONFIG.flagsDir, { recursive: true });
    fs.writeFileSync(path.join(CONFIG.flagsDir, name), new Date().toISOString());
    log('INFO', 'Flag set: ' + name);
  } catch (e) { log('ERROR', 'Could not set flag ' + name, { error: e.message }); }
}

function clearFlag(name) {
  try {
    const p = path.join(CONFIG.flagsDir, name);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      log('INFO', 'Flag cleared: ' + name);
    }
  } catch (e) { log('ERROR', 'Could not clear flag ' + name, { error: e.message }); }
}

function flagExists(name) {
  return fs.existsSync(path.join(CONFIG.flagsDir, name));
}

function maybeReset() {
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  if (state.lastDailyReset !== todayStr) {
    state.dailySpendUsd = 0;
    state.lastDailyReset = todayStr;
    log('INFO', 'Daily spend counter reset');
    if (flagExists('PAUSED')) { clearFlag('PAUSED'); state.currentStatus = 'OK'; }
  }
  const hourStr = now.toISOString().substring(0, 13);
  if (state.lastHourlyReset !== hourStr) {
    state.hourlySpendUsd = 0;
    state.sessionsThisHour = 0;
    state.lastHourlyReset = hourStr;
    log('INFO', 'Hourly counters reset');
  }
}

async function takeAction(level, reason) {
  log(level, 'Watchdog action: ' + level, { reason: reason });
  state.history.push({ ts: new Date().toISOString(), level: level, reason: reason });
  if (state.history.length > 50) state.history.shift();
  if (level === 'WARN') {
    if (state.currentStatus === 'OK') {
      state.currentStatus = 'WARNED';
      await sendNotification('Claude Agent Warning', reason, 1);
    }
  } else if (level === 'PAUSE') {
    if (state.currentStatus !== 'PAUSED' && state.currentStatus !== 'KILLED') {
      state.currentStatus = 'PAUSED';
      setFlag('PAUSED');
      await sendNotification('Claude Agent Paused', reason + ' Will resume at midnight or via /resume endpoint.', 1);
    }
  } else if (level === 'KILL') {
    state.currentStatus = 'KILLED';
    setFlag('PAUSED');
    setFlag('KILLED');
    await sendNotification('Claude Agent Killed', reason + ' Manual intervention required.', 2);
  }
  saveState();
}

async function runCheck() {
  log('INFO', 'Running watchdog check');
  maybeReset();
  const now      = new Date();
  const sessions = readSessionLog();
  const sessionsLastHour = countRecentSessions(sessions, 3600000);
  state.sessionsThisHour = sessionsLastHour;
  const largeSession = findLargeSession(sessions, CONFIG.thresholds.sessionTokens.warn);
  if (largeSession) {
    if (largeSession.totalTokens > CONFIG.thresholds.sessionTokens.kill) {
      await takeAction('KILL', 'Session used ' + largeSession.totalTokens + ' tokens.'); return;
    } else {
      await takeAction('WARN', 'Session used ' + largeSession.totalTokens + ' tokens.');
    }
  }
  if (sessionsLastHour >= CONFIG.thresholds.sessionsPerHour.kill) {
    await takeAction('KILL', sessionsLastHour + ' sessions in last hour.'); return;
  } else if (sessionsLastHour >= CONFIG.thresholds.sessionsPerHour.pause) {
    await takeAction('PAUSE', sessionsLastHour + ' sessions in last hour.'); return;
  } else if (sessionsLastHour >= CONFIG.thresholds.sessionsPerHour.warn) {
    await takeAction('WARN', sessionsLastHour + ' sessions in last hour.');
  }
  if (state.currentStatus === 'WARNED') {
    state.currentStatus = 'OK';
    log('INFO', 'Status returned to OK');
  }
  state.lastCheck = now.toISOString();
  saveState();
}

function startStatusServer() {
  const port = parseInt(process.env.STATUS_PORT || '3001');
  http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/resume') {
      clearFlag('PAUSED');
      clearFlag('KILLED');
      state.currentStatus = 'OK';
      saveState();
      log('INFO', 'Agent manually resumed');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'Agent resumed' }));
    } else {
      const sessions = readSessionLog();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        watchdog: {
          status: state.currentStatus,
          lastCheck: state.lastCheck,
          flags: {
            paused: flagExists('PAUSED'),
            killed: flagExists('KILLED'),
          },
        },
        spend: {
          hourlyUsd: state.hourlySpendUsd.toFixed(4),
          dailyUsd:  state.dailySpendUsd.toFixed(4),
        },
        sessions: {
          thisHour:   state.sessionsThisHour,
          recentList: sessions.slice(-10),
        },
        history: state.history.slice(-20),
      }, null, 2));
    }
  }).listen(port, () => log('INFO', 'Status server on port ' + port));
}

async function main() {
  log('INFO', 'Watchdog starting', { pollIntervalMs: CONFIG.pollIntervalMs });
  if (!CONFIG.anthropicApiKey) log('WARN', 'ANTHROPIC_API_KEY not set');
  if (!CONFIG.pushoverToken)   log('WARN', 'PUSHOVER_TOKEN not set — notifications disabled');
  loadState();
  startStatusServer();
  await runCheck();
  setInterval(async () => {
    try { await runCheck(); }
    catch (e) { log('ERROR', 'Unhandled error in runCheck', { error: e.message }); }
  }, CONFIG.pollIntervalMs);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
