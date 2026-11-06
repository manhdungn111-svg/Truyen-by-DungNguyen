// Proxy MangaDex cho trang chạy trên GitHub Pages.
// Dán toàn bộ file này vào Cloudflare Worker.
// Đổi ALLOWED_ORIGIN thành địa chỉ trang của bạn (không có dấu / ở cuối).
const ALLOWED_ORIGIN = 'https://manhdungn111-svg.github.io';

export default {
  async fetch(req) {
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Vary': 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'GET') return new Response('GET only', { status: 405, headers: cors });
    const u = new URL(req.url);
    const r = await fetch('https://api.mangadex.org' + u.pathname + u.search, {
      headers: { 'User-Agent': 'QuytTruyen/1.0 (personal reader)', Accept: 'application/json' },
      cf: { cacheTtl: 60, cacheEverything: true },
    });
    const h = new Headers(r.headers);
    Object.entries(cors).forEach(([k, v]) => h.set(k, v));
    return new Response(r.body, { status: r.status, headers: h });
  },
};
