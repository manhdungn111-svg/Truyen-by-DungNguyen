// Máy chủ nhỏ: phục vụ trang và chuyển tiếp /api/* tới api.mangadex.org.
// Chạy: node server.js   (cần Node 18 trở lên, không cần cài thêm gói)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const UPSTREAM = (process.env.MANGADEX_API || 'https://api.mangadex.org').replace(/\/$/, '');
const COVERS = (process.env.COVERS_BASE || 'https://uploads.mangadex.org').replace(/\/$/, '');
const UA = 'QuytTruyen/1.0 (self-hosted reader)';
const TTL = 60 * 1000;
const cache = new Map();

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/config') return send(res, 200, JSON.stringify({ covers: COVERS }));

  if (url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET') return send(res, 405, '{"error":"GET only"}');
    const target = UPSTREAM + url.pathname.slice(4) + url.search;
    const hit = cache.get(target);
    if (hit && Date.now() - hit.t < TTL) return send(res, hit.code, hit.body);
    try {
      const r = await fetch(target, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      const body = await r.text();
      if (r.ok) cache.set(target, { t: Date.now(), code: r.status, body });
      if (cache.size > 500) cache.delete(cache.keys().next().value);
      return send(res, r.status, body);
    } catch (e) {
      return send(res, 502, JSON.stringify({ error: 'Không kết nối được MangaDex', detail: String(e.message || e) }));
    }
  }

  const file = path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (!file.startsWith(path.join(__dirname, 'public'))) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
    send(res, 200, data, types[path.extname(file)] || 'application/octet-stream');
  });
});

server.listen(PORT, () => console.log('Quýt Truyện chạy tại http://localhost:' + PORT));
