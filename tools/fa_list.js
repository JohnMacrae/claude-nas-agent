// Read-only: list FreeAgent invoices from a cutoff date. Creates nothing.
const CLIENT_ID = process.env.FREEAGENT_CLIENT_ID;
const CLIENT_SECRET = process.env.FREEAGENT_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.FREEAGENT_REFRESH_TOKEN;
const BASE = 'https://api.freeagent.com/v2';
const FROM = process.env.FA_FROM || '2026-05-01';

async function token() {
  const params = new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: REFRESH_TOKEN,
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
  });
  const res = await fetch(`${BASE}/token_endpoint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const d = await res.json();
  if (!res.ok || !d.access_token) throw new Error(`token: ${res.status} ${JSON.stringify(d)}`);
  return d.access_token;
}

(async () => {
  const t = await token();
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const url = `${BASE}/invoices?from_date=${FROM}&per_page=100&page=${page}&nested_invoice_items=true`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${t}`, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`invoices: ${res.status} ${await res.text()}`);
    const d = await res.json();
    const batch = d.invoices || [];
    out.push(...batch);
    if (batch.length < 100) break;
  }
  console.log(JSON.stringify(out.map(i => ({
    ref: i.reference,
    dated_on: i.dated_on,
    status: i.status,
    total: i.total_value,
    contact: i.contact_name,
    comments: i.comments || '',
    items: (i.invoice_items || []).map(x => x.description).join(' | '),
  })), null, 1));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
