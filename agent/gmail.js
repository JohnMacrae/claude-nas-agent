#!/usr/bin/env node
// Gmail REST client for property-agent — read-only (search/read/attachment).
// Raw fetch + OAuth refresh token, mirrors gcal.js's auth pattern. No
// googleapis dependency, no Python. Auth comes from a single token.json file
// (client_id, client_secret, refresh_token all embedded — see gmail-mcp's
// gmail_client.py, which reads the same file format).
//
//   node gmail.js search '<query>'
//   node gmail.js read <message_id>
//
// Env: GMAIL_TOKEN_PATH (default /gmail-config/token.json)

const fs = require('fs');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

let cachedToken = null;
let cachedExpires = 0;

function loadTokenFile() {
  const p = process.env.GMAIL_TOKEN_PATH || '/gmail-config/token.json';
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!data.refresh_token || !data.client_id || !data.client_secret) {
    throw new Error(`gmail: token file ${p} missing client_id/client_secret/refresh_token`);
  }
  return data;
}

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedExpires) return cachedToken;
  const { client_id, client_secret, refresh_token } = loadTokenFile();
  const body = new URLSearchParams({
    client_id,
    client_secret,
    refresh_token,
    grant_type: 'refresh_token',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Gmail token refresh failed: ${JSON.stringify(data)}`);
  }
  cachedToken = data.access_token;
  cachedExpires = Date.now() + (Number(data.expires_in || 3500) - 60) * 1000;
  return cachedToken;
}

async function apiGet(pathAndQuery) {
  const token = await getAccessToken();
  const res = await fetch(`${API}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Gmail API ${res.status} ${pathAndQuery}: ${JSON.stringify(data)}`);
  }
  return data;
}

function headerMap(headers) {
  const h = {};
  for (const entry of headers || []) h[entry.name] = entry.value;
  return h;
}

async function searchMessages(query, maxResults = 50) {
  const listResp = await apiGet(`/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`);
  const results = [];
  for (const m of listResp.messages || []) {
    const msg = await apiGet(
      `/messages/${m.id}?format=metadata` +
      `&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date&metadataHeaders=To`
    );
    const h = headerMap(msg.payload && msg.payload.headers);
    results.push({
      id: msg.id,
      snippet: msg.snippet || '',
      subject: h.Subject || '',
      from: h.From || '',
      to: h.To || '',
      date: h.Date || '',
      unread: (msg.labelIds || []).includes('UNREAD'),
    });
  }
  return results;
}

function* iterParts(payload) {
  yield payload;
  for (const part of payload.parts || []) {
    yield* iterParts(part);
  }
}

function extractBody(payload, snippet) {
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  }
  for (const part of payload.parts || []) {
    const result = extractBody(part, snippet);
    if (result) return result;
  }
  return snippet || '';
}

async function readMessage(messageId) {
  const msg = await apiGet(`/messages/${messageId}?format=full`);
  const h = headerMap(msg.payload && msg.payload.headers);

  const attachments = [];
  for (const part of iterParts(msg.payload)) {
    if (part.filename && part.body && part.body.attachmentId) {
      attachments.push({
        filename: part.filename,
        attachment_id: part.body.attachmentId,
        mime_type: part.mimeType || '',
      });
    }
  }

  return {
    id: msg.id,
    subject: h.Subject || '',
    from: h.From || '',
    to: h.To || '',
    date: h.Date || '',
    unread: (msg.labelIds || []).includes('UNREAD'),
    body: extractBody(msg.payload, msg.snippet),
    attachments,
  };
}

async function getAttachment(messageId, attachmentId) {
  const att = await apiGet(`/messages/${messageId}/attachments/${attachmentId}`);
  return Buffer.from(att.data, 'base64url');
}

module.exports = { searchMessages, readMessage, getAttachment, getAccessToken };

if (require.main === module) {
  const [cmd, arg] = process.argv.slice(2);
  (async () => {
    if (cmd === 'search') {
      console.log(JSON.stringify(await searchMessages(arg), null, 2));
    } else if (cmd === 'read') {
      console.log(JSON.stringify(await readMessage(arg), null, 2));
    } else {
      console.error('Usage: gmail.js search <query> | gmail.js read <message_id>');
      process.exit(1);
    }
  })().catch((e) => {
    console.error(JSON.stringify({ ok: false, error: e.message }));
    process.exit(1);
  });
}
