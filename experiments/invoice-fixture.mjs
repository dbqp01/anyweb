import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const discoveryRows = [
  ['2026-01', 'INV-101', 1250, 'EUR', 'paid'],
  ['2026-01', 'INV-102', 300, 'EUR', 'open'],
  ['2026-01', 'INV-103', 4999, 'EUR', 'paid'],
  ['2026-01', 'INV-104', 0, 'EUR', 'void'],
  ['2026-01', 'INV-105', 875, 'EUR', 'open'],
  ['2026-02', 'INV-201', 1999, 'USD', 'paid'],
];

export async function startInvoiceFixture({ rows = discoveryRows, port = 0, pageSize = 2, fault = null } = {}) {
  const records = rows.map(([month, number, cents, currency, state]) => ({ key: randomUUID(), month, number, cents, currency, state }));
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), method: req.method });
    const json = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.method !== 'GET') return json(405, { error: 'read only' });
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><html lang="en"><head><title>Invoice desk</title></head><body>
<main><h1>Invoice desk</h1><p>Browse invoices by month. Amounts are shown in the invoice currency.</p>
<label>Month (YYYY-MM) <input id="month" aria-label="Month" value="2026-01"></label><button id="search">Find invoices</button>
<p id="summary"></p><table><thead><tr><th>Invoice</th><th>Amount</th><th>Currency</th><th>Status</th></tr></thead><tbody id="rows"></tbody></table><button id="next" disabled>Next page</button></main>
<script>
let cursor=null;
async function load(next=false){
 const u=new URL('/ledger',location.origin);u.searchParams.set('month',document.querySelector('#month').value);if(next&&cursor)u.searchParams.set('after',cursor);
 const r=await fetch(u);const data=await r.json();if(!r.ok){document.querySelector('#summary').textContent=data.error;return;}
 document.querySelector('#rows').replaceChildren(...data.entries.map(e=>{const tr=document.createElement('tr');for(const text of [e.number,(e.cents/100).toFixed(2),e.currency,e.state]){const td=document.createElement('td');td.textContent=text;tr.append(td);}return tr;}));
 document.querySelector('#summary').textContent='Showing '+data.entries.length+' of '+data.total+' invoices';cursor=data.next;document.querySelector('#next').disabled=!cursor;
}
document.querySelector('#search').onclick=()=>load();document.querySelector('#next').onclick=()=>load(true);
</script></body></html>`);
    }
    if (url.pathname !== '/ledger') return json(404, { error: 'not found' });
    if (fault === 'unauthorized') return json(401, { error: 'session expired' });
    const month = url.searchParams.get('month');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month ?? '')) return json(400, { error: 'month must be YYYY-MM' });
    const matching = records.filter(r => r.month === month);
    const after = url.searchParams.get('after');
    const offset = after ? matching.findIndex(r => r.key === after) + 1 : 0;
    if (after && !offset) return json(400, { error: 'invalid cursor' });
    const entries = matching.slice(offset, offset + pageSize);
    let next = offset + entries.length < matching.length ? entries.at(-1).key : null;
    if (fault === 'repeat-cursor' && entries.length) next = after ?? entries.at(-1).key;
    if (fault === 'truncated') next = null;
    return json(200, { entries, total: matching.length, next });
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise(resolve => server.close(resolve)) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = await startInvoiceFixture({ port: 4332 });
  console.log(`Invoice experiment: ${fixture.origin}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => fixture.close().then(() => process.exit(0)));
}
