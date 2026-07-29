#!/usr/bin/env node
// Google Calendar CLI for the property agent (no Claude OAuth).
//
//   node gcal.js list-calendars
//   node gcal.js list-events --calendar Maintenance --from ISO --to ISO
//   node gcal.js create-event --calendar Maintenance --summary "..." --date YYYY-MM-DD [--description ...] [--color-id N]
//   node gcal.js update-event --calendar Maintenance --event-id ID [--description "..."] [--color-id N|default]
//
// Event colours are Google's fixed palette, by id:
//   1 Lavender  2 Sage     3 Grape    4 Flamingo  5 Banana   6 Tangerine
//   7 Peacock   8 Graphite 9 Blueberry 10 Basil   11 Tomato
// An event with no colorId uses the calendar's own colour; --color-id default
// restores that.
//
// Auth via env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN

const KNOWN = {
  Maintenance: '963dbd01a359d150a2ba10371bf80a30dc448da1100abb14ab750966a9e8a547@group.calendar.google.com',
  Property: 'jj52rrbqum0q362phqmsjp20uc@group.calendar.google.com',
  'Property Calendar': 'jj52rrbqum0q362phqmsjp20uc@group.calendar.google.com',
};

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';

let cachedToken = null;
let cachedExpires = 0;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function resolveCalendarId(nameOrId) {
  if (!nameOrId) throw new Error('--calendar is required');
  if (KNOWN[nameOrId]) return KNOWN[nameOrId];
  const lower = String(nameOrId).toLowerCase();
  for (const [k, v] of Object.entries(KNOWN)) {
    if (k.toLowerCase() === lower) return v;
  }
  return nameOrId;
}

async function getAccessToken() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN must be set'
    );
  }
  if (cachedToken && Date.now() < cachedExpires) return cachedToken;

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Google token refresh failed: ${JSON.stringify(data)}`);
  }
  cachedToken = data.access_token;
  cachedExpires = Date.now() + (Number(data.expires_in || 3500) - 60) * 1000;
  return cachedToken;
}

async function api(method, path, { query, body } = {}) {
  const token = await getAccessToken();
  let url = `${API}${path}`;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v != null && v !== '') qs.set(k, String(v));
    }
    url += `?${qs}`;
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`gcal ${method} ${path} → ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function listCalendars() {
  const data = await api('GET', '/users/me/calendarList');
  const items = (data.items || []).map((c) => ({
    id: c.id,
    summary: c.summary,
    primary: !!c.primary,
    knownAs: Object.entries(KNOWN).find(([, id]) => id === c.id)?.[0] || null,
  }));
  return { ok: true, calendars: items, known: KNOWN };
}

async function listEvents(args) {
  const calendarId = resolveCalendarId(args.calendar);
  const timeMin = args.from;
  const timeMax = args.to;
  if (!timeMin || !timeMax) throw new Error('--from and --to (ISO) are required');
  const data = await api('GET', `/calendars/${encodeURIComponent(calendarId)}/events`, {
    query: {
      timeMin,
      timeMax,
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: args.limit || '50',
    },
  });
  const events = (data.items || []).map((e) => ({
    id: e.id,
    summary: e.summary || '',
    description: e.description || '',
    start: e.start?.date || e.start?.dateTime || null,
    end: e.end?.date || e.end?.dateTime || null,
    allDay: !!e.start?.date,
    // Google omits colorId entirely when the event uses the calendar's default
    // colour, so null means "default", not "unset".
    colorId: e.colorId || null,
    htmlLink: e.htmlLink || null,
  }));
  return { ok: true, calendarId, count: events.length, events };
}

async function createEvent(args) {
  const calendarId = resolveCalendarId(args.calendar);
  if (!args.summary || args.summary === true) throw new Error('--summary is required');
  if (!args.date || args.date === true) throw new Error('--date YYYY-MM-DD is required');
  const date = String(args.date);
  // All-day: end is exclusive next day
  const endDate = new Date(`${date}T12:00:00Z`);
  endDate.setUTCDate(endDate.getUTCDate() + 1);
  const endStr = endDate.toISOString().slice(0, 10);
  const body = {
    summary: args.summary,
    description: args.description && args.description !== true ? args.description : '',
    start: { date },
    end: { date: endStr },
  };
  if (args['color-id'] !== undefined && args['color-id'] !== true) {
    body.colorId = String(args['color-id']);
  }
  const created = await api('POST', `/calendars/${encodeURIComponent(calendarId)}/events`, { body });
  return {
    ok: true,
    event: {
      id: created.id,
      summary: created.summary,
      description: created.description || '',
      start: created.start?.date || created.start?.dateTime,
      end: created.end?.date || created.end?.dateTime,
      colorId: created.colorId || null,
      htmlLink: created.htmlLink,
    },
  };
}

async function updateEvent(args) {
  const calendarId = resolveCalendarId(args.calendar);
  const eventId = args['event-id'];
  if (!eventId || eventId === true) throw new Error('--event-id is required');
  const patch = {};
  if (args.description !== undefined && args.description !== true) patch.description = args.description;
  if (args.summary !== undefined && args.summary !== true) patch.summary = args.summary;
  if (args['color-id'] !== undefined && args['color-id'] !== true) {
    // 'default' clears the override so the event falls back to the calendar
    // colour. Google wants null, not an empty string, to unset it.
    patch.colorId = String(args['color-id']) === 'default' ? null : String(args['color-id']);
  }
  if (!Object.keys(patch).length) {
    throw new Error('Provide --description, --summary and/or --color-id to update');
  }
  const updated = await api(
    'PATCH',
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { body: patch }
  );
  return {
    ok: true,
    event: {
      id: updated.id,
      summary: updated.summary,
      description: updated.description || '',
      start: updated.start?.date || updated.start?.dateTime,
      end: updated.end?.date || updated.end?.dateTime,
      colorId: updated.colorId || null,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  let result;
  switch (cmd) {
    case 'list-calendars':
      result = await listCalendars();
      break;
    case 'list-events':
      result = await listEvents(args);
      break;
    case 'create-event':
      result = await createEvent(args);
      break;
    case 'update-event':
      result = await updateEvent(args);
      break;
    default:
      throw new Error(
        'Usage: gcal.js list-calendars|list-events|create-event|update-event'
      );
  }
  console.log(JSON.stringify(result));
}

module.exports = {
  listCalendars,
  listEvents,
  createEvent,
  updateEvent,
  resolveCalendarId,
  KNOWN,
};

if (require.main === module) {
  main().catch((e) => {
    console.error(JSON.stringify({ ok: false, error: e.message }));
    process.exit(1);
  });
}
