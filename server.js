const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-this-admin-key';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'remote-requests.json');
const MAX_BODY = 1024 * 1024;

const mime = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp'
};

function send(res, status, body, type='application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': type.startsWith('application/json') ? 'no-store' : 'public, max-age=300'
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
}
function clean(value, max=2000) { return String(value || '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max); }
function isAdmin(req, url) { return req.headers['x-admin-key'] === ADMIN_KEY || url.searchParams.get('admin_key') === ADMIN_KEY; }
async function ensureDataFile() { await fs.mkdir(DATA_DIR, { recursive: true }); try { await fs.access(DATA_FILE); } catch { await fs.writeFile(DATA_FILE, '[]\n'); } }
async function readRequests() { await ensureDataFile(); return JSON.parse(await fs.readFile(DATA_FILE, 'utf8') || '[]'); }
async function writeRequests(items) { await ensureDataFile(); await fs.writeFile(DATA_FILE, JSON.stringify(items, null, 2) + '\n'); }
function ticketId() { const d = new Date(); const date = d.toISOString().slice(0,10).replace(/-/g,''); const rand = crypto.randomBytes(3).toString('hex').toUpperCase(); return `RT-${date}-${rand}`; }
function readBody(req) { return new Promise((resolve, reject) => { let size=0, chunks=[]; req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new Error('Request body is too large.')); req.destroy(); return; } chunks.push(c); }); req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); req.on('error', reject); }); }

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true, service: 'RoboTechi Remote Support Backend' });

  if (req.method === 'POST' && url.pathname === '/api/remote-requests') {
    let data;
    try { data = JSON.parse(await readBody(req)); } catch { return send(res, 400, { ok:false, error:'Invalid JSON body.' }); }
    const record = {
      ticketId: ticketId(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'new',
      name: clean(data.name, 120),
      email: clean(data.email, 160),
      phone: clean(data.phone, 80),
      os: clean(data.os, 80),
      tool: clean(data.tool, 120),
      sessionCode: clean(data.sessionCode, 120),
      oneTimeCode: clean(data.oneTimeCode, 120),
      issue: clean(data.issue, 5000),
      consent: data.consent === true,
      consentText: clean(data.consentText, 500),
      userAgent: clean(req.headers['user-agent'], 300),
      ipHint: clean(req.headers['x-forwarded-for'] || req.socket.remoteAddress, 120)
    };
    if (!record.name || !record.email || !record.issue) return send(res, 422, { ok:false, error:'Name, email, and issue are required.' });
    if (!record.consent) return send(res, 422, { ok:false, error:'Customer consent is required before remote support.' });
    const items = await readRequests(); items.unshift(record); await writeRequests(items);
    return send(res, 201, { ok:true, ticketId: record.ticketId, status: record.status, message:'Remote support ticket created.' });
  }

  if (req.method === 'GET' && url.pathname === '/api/remote-requests') {
    if (!isAdmin(req, url)) return send(res, 401, { ok:false, error:'Admin key required.' });
    const items = await readRequests();
    return send(res, 200, { ok:true, requests: items });
  }

  const patchMatch = url.pathname.match(/^\/api\/remote-requests\/([^/]+)$/);
  if (req.method === 'PATCH' && patchMatch) {
    if (!isAdmin(req, url)) return send(res, 401, { ok:false, error:'Admin key required.' });
    let data; try { data = JSON.parse(await readBody(req)); } catch { return send(res, 400, { ok:false, error:'Invalid JSON body.' }); }
    const allowed = new Set(['new','contacted','in-session','closed']);
    const status = clean(data.status, 40);
    if (!allowed.has(status)) return send(res, 422, { ok:false, error:'Invalid status.' });
    const id = decodeURIComponent(patchMatch[1]);
    const items = await readRequests();
    const item = items.find(x => x.ticketId === id);
    if (!item) return send(res, 404, { ok:false, error:'Ticket not found.' });
    item.status = status; item.updatedAt = new Date().toISOString();
    if (data.note) { item.notes = item.notes || []; item.notes.push({ at: item.updatedAt, note: clean(data.note, 1000) }); }
    await writeRequests(items);
    return send(res, 200, { ok:true, ticket: item });
  }
  return send(res, 404, { ok:false, error:'API route not found.' });
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
  try {
    const data = await fs.readFile(filePath);
    send(res, 200, data, mime[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
  } catch {
    send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await serveStatic(req, res, url);
  } catch (err) {
    console.error(err);
    return send(res, 500, { ok:false, error:'Server error.' });
  }
});

server.listen(PORT, () => {
  console.log(`RoboTechi Remote Support Backend running at http://localhost:${PORT}`);
  if (ADMIN_KEY === 'change-this-admin-key') console.warn('WARNING: Set ADMIN_KEY before deploying.');
});
