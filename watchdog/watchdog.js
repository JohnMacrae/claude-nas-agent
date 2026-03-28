#!/usr/bin/env node

/**
 * Claude NAS Agent - Watchdog
 *
 * Monitors Anthropic API spend and session frequency.
 * Operates independently of the agent — no Claude Code dependency.
 *
 * Actions:
 *   WARN  → ntfy push notification
 *   PAUSE → writes /flags/PAUSED (agent checks before starting)
 *   KILL  → sends SIGTERM to agent container via Docker socket
 *
 * Thresholds (configurable via environment variables):
 *   Hourly spend:    warn £0.50 / pause £1.00 / kill £2.00
 *   Daily spend:     warn £2.00 / pause £3.00 / kill £5.00
 *   Sessions/hour:   warn 4     / pause 6     / kill 8
 *   Session tokens:  warn 40000 / kill 60000
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// ─── Configuration ────────────────────────────────────────────────────────────

const CONFIG = {
  // Anthropic API
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,

  // ntfy
  ntfyUrl:   process.env.NTFY_URL   || 'http://ntfy:80',
  ntfyTopic: process.env.NTFY_TOPIC || 'claude-agent',

  // Paths (mounted volumes)
  flagsDir: process.env.FLAGS_DIR || '/flags',
  logsDir:  process.env.LOGS_DIR  || '/logs',
  stateFile: process.env.STATE_FILE || '/logs/watchdog-state.json',

  // Poll interval
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '300000'), // 5 min default

  // Thresholds — spend in USD (Anthropic bills in USD)
  // £1 ≈ $1.27 — using USD internally, converting for display
  thresholds: {
    hourlySpend: {
      warn:  parseFloat(process.env.WARN_HOURLY_USD  || '0.63'),  // ~£0.50
      pause: parseFloat(process.env.PAUSE_HOURLY_USD || '1.27'),  // ~£1.00
      kill:  parseFloat(process.env.KILL_HOURLY_USD  || '2.54'),  // ~£2.00
    },
    dailySpend: {
      warn:  parseFloat(process.env.WARN_DAILY_USD  || '2.54'),   // ~£2.00
      pause: parseFloat(process.env.PAUSE_DAILY_USD || '3.81'),   // ~£3.00
      kill:  parseFloat(process.env.KILL_DAILY_USD  || '6.35'),   // ~£5.00
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

// ─── State ────────────────────────────────────────────────────────────────────

let state = {
  lastCheck: null,
  currentStatus: 'OK',   // OK | WARNED | PAUSED | KILLED
  dailySpendUsd: 0,
  hourlySpendUsd: 0,
  sessionsThisHour: 0,
  lastDailyReset: null,
  lastHourlyReset: null,
  history: [],           // last 50 events
};

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(level, message, data = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...data,
  };
  console.log(JSON.stringify(entry));

  // Append to log file
  try {
    fs.mkdirSync(CONFIG.logsDir, { recursive: true });
    fs.appendFileSync(
      path.join(CONFIG.logsDir, 'watchdog.log'),
      JSON.stringify(entry) + '\n'
    );
  } catch (e) {
    console.error('Failed to write log file:', e.message);
  }
}

// ─── State persistence ────────────────────────────────────────────────────────

function loadState() {
  try {
    if (fs.existsSync(CONFIG.stateFile)) {
      const raw = fs.readFileSync(CONFIG.stateFile, 'utf8');
      state = { ...state, ...JSON.parse(raw) };
      log('INFO', 'State loaded', { status: state.currentStatus });
    }
  } catch (e) {
    log('WARN', 'Could not load state, starting fresh', { error: e.message });
  }
}

function saveState() {
  try {
    fs.mkdirSync(CONFIG.logsDir, { recursive: true });
    fs.writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 2));
  } catch (e) {
    log('ERROR', 'Could not save state', { error: e.message });
  }
}

// ─── Session tracking (written by agent, read by watchdog) ───────────────────

function readSessionLog() {
  const sessionFile = path.join(CONFIG.logsDir, 'sessions.json');
  try {
    if (fs.existsSync(sessionFile)) {
      return JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    }
  } catch (e) {
    log('WARN', 'Could not read session log', { error: e.message });
  }
  return [];
}

function countRecentSessions(sessions, windowMs) {
  const cutoff = Date.now() - windowMs;
  return sessions.filter(s => new Date(s.startedAt).getTime() > cutoff).length;
}

function findLargeSession(sessions, tokenThreshold) {
  const oneHourAgo = Date.now() - 3600000;
  return sessions.find(
    s => new Date(s.startedAt).getTime() > oneHourAgo &&
         (s.totalTokens || 0) > tokenThreshold
  );
}

// ─── Anthropic spend (usage API) ─────────────────────────────────────────────

function fetchAnthropicUsage(startDate, endDate) {
  return new Promise((resolve, reject) => {
    if (!CONFIG.anthropicApiKey) {
      return reject(new Error('ANTHROPIC_API_KEY not set'));
    }

    // Format dates as YYYY-MM-DD
    const start = startDate.toISOString().split('T')[0];
    const end   = endDate.toISOString().split('T')[0];

    const options = {
      hostname: 'api.anthropic.com',
      path: `/v1/usage?start_date=${start}&end_date=${end}`,
      method: 'GET',
      headers: {
        'x-api-key': CONFIG.anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (res.statusCode !== 200) {
            return reject(new Error(`API error ${res.statusCode}: ${body}`));
          }
          // Sum up cost_usd across all usage entries
          const totalUsd = (data.data || []).reduce(
            (sum, entry) => sum + (entry.cost_usd || 0), 0
          );
          resolve(totalUsd);
        } catch (e) {
          reject(new Error(`Failed to parse usage response: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

// ─── ntfy notifications ───────────────────────────────────────────────────────

function sendNotification(title, message, priority = 'default') {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      topic:    CONFIG.ntfyTopic,
      title,
      message,
      priority, // min/low/default/high/urgent
      tags:     ['robot', 'warning'],
    });

    const url = new URL(`${CONFIG.ntfyUrl}/${CONFIG.ntfyTopic}`);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const options = {
      hostname: url.hostname,
      port:     url.port || (isHttps ? 443 : 80),
      path:     url.pathname,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = lib.request(options, (res) => {
      res.resume();
      log('INFO', 'ntfy notification sent', { title, priority, status: res.statusCode });
      resolve();
    });

    req.on('error', (e) => {
      log('ERROR', 'ntfy notification failed', { error: e.message });
      resolve(); // don't crash watchdog on notification failure
    });

    req.write(body);
    req.end();
  });
}

// ─── Flag file management ─────────────────────────────────────────────────────

function setFlag(name) {
  try {
    fs.mkdirSync(CONFIG.flagsDir, { recursive: true });
    fs.writeFileSync(path.join(CONFIG.flagsDir, name), new Date().toISOString());
    log('INFO', `Flag set: ${name}`);
  } catch (e) {
    log('ERROR', `Could not set flag ${name}`, { error: e.message });
  }
}

function clearFlag(name) {
  try {
    const flagPath = path.join(CONFIG.flagsDir, name);
    if (fs.existsSync(flagPath)) {
      fs.unlinkSync(flagPath);
      log('INFO', `Flag cleared: ${name}`);
    }
  } catch (e) {
    log('ERROR', `Could not clear flag ${name}`, { error: e.message });
  }
}

function flagExists(name) {
  return fs.existsSync(path.join(CONFIG.flagsDir, name));
}

// ─── Hourly / daily resets ────────────────────────────────────────────────────

function maybeReset() {
  const now = new Date();

  // Daily reset at midnight
  const todayStr = now.toISOString().split('T')[0];
  if (state.lastDailyReset !== todayStr) {
    state.dailySpendUsd = 0;
    state.lastDailyReset = todayStr;
    log('INFO', 'Daily spend counter reset');

    // Clear PAUSED flag at midnight so agent can start fresh
    if (flagExists('PAUSED')) {
      clearFlag('PAUSED');
      state.currentStatus = 'OK';
      log('INFO', 'PAUSED flag cleared on daily reset');
    }
  }

  // Hourly reset
  const hourStr = now.toISOString().substring(0, 13); // YYYY-MM-DDTHH
  if (state.lastHourlyReset !== hourStr) {
    state.hourlySpendUsd = 0;
    state.sessionsThisHour = 0;
    state.lastHourlyReset = hourStr;
    log('INFO', 'Hourly counters reset');
  }
}

// ─── Core check ───────────────────────────────────────────────────────────────

async function runCheck() {
  log('INFO', 'Running watchdog check');
  maybeReset();

  const now = new Date();
  const sessions = readSessionLog();

  // ── Session frequency check ──────────────────────────────────────────────
  const sessionsLastHour = countRecentSessions(sessions, 3600000);
  state.sessionsThisHour = sessionsLastHour;

  const largeSession = findLargeSession(sessions, CONFIG.thresholds.sessionTokens.warn);

  if (largeSession) {
    log('WARN', 'Large session detected', {
      tokens: largeSession.totalTokens,
      sessionId: largeSession.id,
    });
    if (largeSession.totalTokens > CONFIG.thresholds.sessionTokens.kill) {
      await takeAction('KILL', `Session used ${largeSession.totalTokens} tokens (kill threshold: ${CONFIG.thresholds.sessionTokens.kill})`);
      return;
    } else {
      await takeAction('WARN', `Session used ${largeSession.totalTokens} tokens (warn threshold: ${CONFIG.thresholds.sessionTokens.warn})`);
    }
  }

  if (sessionsLastHour >= CONFIG.thresholds.sessionsPerHour.kill) {
    await takeAction('KILL', `${sessionsLastHour} sessions in last hour (kill threshold: ${CONFIG.thresholds.sessionsPerHour.kill})`);
    return;
  } else if (sessionsLastHour >= CONFIG.thresholds.sessionsPerHour.pause) {
    await takeAction('PAUSE', `${sessionsLastHour} sessions in last hour (pause threshold: ${CONFIG.thresholds.sessionsPerHour.pause})`);
    return;
  } else if (sessionsLastHour >= CONFIG.thresholds.sessionsPerHour.warn) {
    await takeAction('WARN', `${sessionsLastHour} sessions in last hour (warn threshold: ${CONFIG.thresholds.sessionsPerHour.warn})`);
  }

  // ── Spend check ──────────────────────────────────────────────────────────
  try {
    // Daily spend: midnight to now
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const dailySpend = await fetchAnthropicUsage(midnight, now);
    state.dailySpendUsd = dailySpend;

    // Hourly spend: 1 hour ago to now
    const oneHourAgo = new Date(now.getTime() - 3600000);
    const hourlySpend = await fetchAnthropicUsage(oneHourAgo, now);
    state.hourlySpendUsd = hourlySpend;

    log('INFO', 'Spend fetched', {
      hourlyUsd: hourlySpend.toFixed(4),
      dailyUsd:  dailySpend.toFixed(4),
    });

    // Daily thresholds
    if (dailySpend >= CONFIG.thresholds.dailySpend.kill) {
      await takeAction('KILL', `Daily spend $${dailySpend.toFixed(2)} exceeds kill threshold $${CONFIG.thresholds.dailySpend.kill}`);
      return;
    } else if (dailySpend >= CONFIG.thresholds.dailySpend.pause) {
      await takeAction('PAUSE', `Daily spend $${dailySpend.toFixed(2)} exceeds pause threshold $${CONFIG.thresholds.dailySpend.pause}`);
      return;
    } else if (dailySpend >= CONFIG.thresholds.dailySpend.warn) {
      await takeAction('WARN', `Daily spend $${dailySpend.toFixed(2)} exceeds warn threshold $${CONFIG.thresholds.dailySpend.warn}`);
    }

    // Hourly thresholds
    if (hourlySpend >= CONFIG.thresholds.hourlySpend.kill) {
      await takeAction('KILL', `Hourly spend $${hourlySpend.toFixed(2)} exceeds kill threshold $${CONFIG.thresholds.hourlySpend.kill}`);
      return;
    } else if (hourlySpend >= CONFIG.thresholds.hourlySpend.pause) {
      await takeAction('PAUSE', `Hourly spend $${hourlySpend.toFixed(2)} exceeds pause threshold $${CONFIG.thresholds.hourlySpend.pause}`);
      return;
    } else if (hourlySpend >= CONFIG.thresholds.hourlySpend.warn) {
      await takeAction('WARN', `Hourly spend $${hourlySpend.toFixed(2)} exceeds warn threshold $${CONFIG.thresholds.hourlySpend.warn}`);
    }

  } catch (e) {
    log('ERROR', 'Failed to fetch spend from Anthropic API', { error: e.message });
    // Don't crash — spend check failure shouldn't kill the agent
  }

  // ── All clear ────────────────────────────────────────────────────────────
  if (state.currentStatus === 'WARNED') {
    state.currentStatus = 'OK';
    log('INFO', 'Status returned to OK');
  }

  state.lastCheck = now.toISOString();
  saveState();
}

// ─── Action handler ───────────────────────────────────────────────────────────

async function takeAction(level, reason) {
  log(level, `Watchdog action: ${level}`, { reason });

  // Record in history
  state.history.push({ ts: new Date().toISOString(), level, reason });
  if (state.history.length > 50) state.history.shift();

  switch (level) {
    case 'WARN':
      if (state.currentStatus === 'OK') {
        state.currentStatus = 'WARNED';
        await sendNotification(
          '⚠️ Claude Agent Warning',
          reason,
          'high'
        );
      }
      break;

    case 'PAUSE':
      if (state.currentStatus !== 'PAUSED' && state.currentStatus !== 'KILLED') {
        state.currentStatus = 'PAUSED';
        setFlag('PAUSED');
        await sendNotification(
          '🛑 Claude Agent Paused',
          `${reason}\n\nAgent will not start new sessions until manually resumed or midnight reset.`,
          'urgent'
        );
      }
      break;

    case 'KILL':
      state.currentStatus = 'KILLED';
      setFlag('PAUSED'); // also set PAUSED so agent won't restart
      setFlag('KILLED');
      await sendNotification(
        '🚨 Claude Agent Killed',
        `${reason}\n\nManual intervention required. Check logs at /logs/watchdog.log`,
        'urgent'
      );
      log('ERROR', 'KILL action taken — agent paused, manual intervention required');
      break;
  }

  saveState();
}

// ─── HTTP status endpoint ─────────────────────────────────────────────────────
// Simple JSON status page — accessible from approval UI and for debugging

function startStatusServer() {
  const port = parseInt(process.env.STATUS_PORT || '3001');
  const server = http.createServer((req, res) => {
    if (req.url === '/status' || req.url === '/') {
      const sessions = readSessionLog();
      const status = {
        watchdog: {
          status:          state.currentStatus,
          lastCheck:       state.lastCheck,
          flags: {
            paused: flagExists('PAUSED'),
            killed: flagExists('KILLED'),
          },
        },
        spend: {
          hourlyUsd: state.hourlySpendUsd.toFixed(4),
          dailyUsd:  state.dailySpendUsd.toFixed(4),
          thresholds: CONFIG.thresholds,
        },
        sessions: {
          thisHour:   state.sessionsThisHour,
          recentList: sessions.slice(-10),
        },
        history: state.history.slice(-20),
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status, null, 2));

    } else if (req.url === '/resume' && req.method === 'POST') {
      // Manual resume endpoint
      clearFlag('PAUSED');
      clearFlag('KILLED');
      state.currentStatus = 'OK';
      saveState();
      log('INFO', 'Agent manually resumed via HTTP');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'Agent resumed' }));

    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  server.listen(port, () => {
    log('INFO', `Watchdog status server listening on port ${port}`);
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log('INFO', 'Watchdog starting', {
    pollIntervalMs: CONFIG.pollIntervalMs,
    thresholds:     CONFIG.thresholds,
    ntfyUrl:        CONFIG.ntfyUrl,
    flagsDir:       CONFIG.flagsDir,
    logsDir:        CONFIG.logsDir,
  });

  if (!CONFIG.anthropicApiKey) {
    log('ERROR', 'ANTHROPIC_API_KEY is not set — spend monitoring disabled');
  }

  loadState();
  startStatusServer();

  // Run immediately on start
  await runCheck();

  // Then on interval
  setInterval(async () => {
    try {
      await runCheck();
    } catch (e) {
      log('ERROR', 'Unhandled error in runCheck', { error: e.message, stack: e.stack });
    }
  }, CONFIG.pollIntervalMs);
}

main().catch(e => {
  console.error('Fatal watchdog error:', e);
  process.exit(1);
});
