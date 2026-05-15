#!/usr/bin/env node
// Telegram utility for the claude-nas-agent.
// Called by the agent via the Bash tool during a session.
//
// Usage:
//   node telegram.js send "message text"
//   node telegram.js updates [offset]
//   node telegram.js wait-reply "prompt text" [timeout_seconds]

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TOKEN || !CHAT_ID) {
  console.error(JSON.stringify({ ok: false, error: 'TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set' }));
  process.exit(1);
}

const BASE = `https://api.telegram.org/bot${TOKEN}`;

async function apiCall(method, params = {}) {
  const url = `${BASE}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram error on ${method}: ${JSON.stringify(data)}`);
  return data.result;
}

async function send(text) {
  const result = await apiCall('sendMessage', { chat_id: CHAT_ID, text, parse_mode: 'HTML' });
  console.log(JSON.stringify({ ok: true, message_id: result.message_id }));
}

async function updates(offset = 0) {
  const results = await apiCall('getUpdates', {
    offset,
    allowed_updates: ['message'],
  });
  const filtered = results.filter(
    u => u.message && String(u.message.chat.id) === String(CHAT_ID)
  );
  console.log(JSON.stringify(filtered));
}

async function waitReply(prompt, timeoutSecs = 120) {
  // Get current offset baseline
  const existing = await apiCall('getUpdates', { offset: -1 });
  let offset = existing.length > 0 ? existing[existing.length - 1].update_id + 1 : 0;

  // Send the prompt message
  await apiCall('sendMessage', { chat_id: CHAT_ID, text: prompt, parse_mode: 'HTML' });

  const deadline = Date.now() + timeoutSecs * 1000;

  while (Date.now() < deadline) {
    const remaining = Math.max(1, Math.floor((deadline - Date.now()) / 1000));
    const pollTimeout = Math.min(30, remaining);

    const batch = await apiCall('getUpdates', {
      offset,
      timeout: pollTimeout,
      allowed_updates: ['message'],
    });

    for (const u of batch) {
      offset = u.update_id + 1;
      if (u.message && String(u.message.chat.id) === String(CHAT_ID)) {
        // Advance offset so this update won't be returned again
        await apiCall('getUpdates', { offset });
        console.log(JSON.stringify({
          ok: true,
          text: u.message.text,
          message_id: u.message.message_id,
          from: u.message.from,
        }));
        return;
      }
    }
  }

  console.log(JSON.stringify({ ok: false, text: null, reason: 'timeout' }));
}

const [, , cmd, ...args] = process.argv;

switch (cmd) {
  case 'send':
    send(args[0]).catch(e => { console.error(JSON.stringify({ ok: false, error: e.message })); process.exit(1); });
    break;
  case 'updates':
    updates(Number(args[0] || 0)).catch(e => { console.error(JSON.stringify({ ok: false, error: e.message })); process.exit(1); });
    break;
  case 'wait-reply':
    waitReply(args[0], Number(args[1] || 120)).catch(e => { console.error(JSON.stringify({ ok: false, error: e.message })); process.exit(1); });
    break;
  default:
    console.error('Usage: telegram.js <send|updates|wait-reply> [args]');
    process.exit(1);
}
