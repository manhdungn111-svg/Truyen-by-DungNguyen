// Proxy MangaDex + tài khoản sao lưu cho Quýt Truyện (Cloudflare Worker).
// Cần gắn một KV namespace với tên biến QT để dùng đăng ký, đăng nhập, đồng bộ.
// Không có KV thì phần proxy vẫn chạy, chỉ phần tài khoản báo chưa bật.
// Đổi ALLOWED_ORIGIN thành địa chỉ gốc trang của bạn (không có dấu / ở cuối).
const ALLOWED_ORIGIN = 'https://manhdungn111-svg.github.io';
const UA = 'QuytTruyen/1.0 (personal reader)';
const UUID = /^[0-9a-f-]{36}$/;
const FILE = /^[\w.\-]{1,150}$/;
const enc = new TextEncoder();

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const rand = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return hex(a); };
function safeEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export default {
  async fetch(req, env) {
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Vary': 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    const u = new URL(req.url);
    if (u.pathname === '/ping') return json({ ok: true, v: 6, kv: !!(env && env.QT), img: true }, 200, cors);
    if (u.pathname.startsWith('/auth/') || u.pathname === '/sync') {
      return account(req, env, u, cors);
    }

    if (req.method !== 'GET') return new Response('GET only', { status: 405, headers: cors });

    let target, ttl = 60, accept = 'application/json';
    if (u.pathname.startsWith('/covers/')) {
      target = 'https://uploads.mangadex.org' + u.pathname;
      ttl = 86400; accept = '*/*';
    } else if (u.pathname === '/proxy') {
      let t;
      try { t = new URL(u.searchParams.get('u') || ''); }
      catch (e) { return new Response('Bad url', { status: 400, headers: cors }); }
      const ok = (t.protocol === 'https:' || t.protocol === 'http:') &&
        (t.hostname === 'uploads.mangadex.org' || t.hostname.endsWith('.mangadex.network'));
      if (!ok) return new Response('Host not allowed', { status: 403, headers: cors });
      target = t.toString();
      ttl = 86400; accept = '*/*';
    } else {
      target = 'https://api.mangadex.org' + u.pathname + u.search;
    }

    const r = await fetch(target, {
      headers: { 'User-Agent': UA, Accept: accept },
      cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': ttl, '300-599': 0 } },
    });
    const h = new Headers(r.headers);
    Object.entries(cors).forEach(([k, v]) => h.set(k, v));
    return new Response(r.body, { status: r.status, headers: h });
  },
};

/* ---------- tài khoản ---------- */
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function readBody(req, max) {
  const text = await req.text();
  if (text.length > max) throw new Error('too_big');
  return text;
}

async function issueToken(env, name) {
  const token = rand(32);
  await env.QT.put('t:' + (await sha256(token)), name, { expirationTtl: 60 * 86400 });
  return { token, user: name };
}

async function who(req, env) {
  const m = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.get('Authorization') || '');
  if (!m) return null;
  return env.QT.get('t:' + (await sha256(m[1])));
}

function cleanItems(a, max) {
  if (!Array.isArray(a)) return [];
  const out = [];
  for (const x of a.slice(0, max)) {
    if (!x || typeof x !== 'object' || !UUID.test(x.id || '')) continue;
    out.push({
      id: x.id,
      t: String(x.t || '').slice(0, 200),
      c: FILE.test(x.c || '') ? x.c : '',
      au: String(x.au || '').slice(0, 100),
      ch: UUID.test(x.ch || '') ? x.ch : '',
      l: String(x.l || '').slice(0, 60),
      ts: Number(x.ts) || 0,
      d: !!x.d,
    });
  }
  return out;
}

async function account(req, env, u, cors) {
  if (!env.QT) return json({ error: 'no_kv' }, 503, cors);
  try {
    const p = u.pathname;

    if (p === '/auth/register' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 2000));
      const name = String(b.u || '').toLowerCase();
      const k = String(b.k || '');
      if (!/^[a-z0-9_]{3,20}$/.test(name)) return json({ error: 'bad_user' }, 400, cors);
      if (!/^[0-9a-f]{64}$/.test(k)) return json({ error: 'bad_key' }, 400, cors);
      if (await env.QT.get('u:' + name)) return json({ error: 'taken' }, 409, cors);
      const salt = rand(16);
      await env.QT.put('u:' + name, JSON.stringify({ s: salt, h: await sha256(salt + k), c: Date.now() }));
      return json(await issueToken(env, name), 200, cors);
    }

    if (p === '/auth/login' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 2000));
      const name = String(b.u || '').toLowerCase();
      const k = String(b.k || '');
      if (!/^[a-z0-9_]{3,20}$/.test(name) || !/^[0-9a-f]{64}$/.test(k)) return json({ error: 'bad_login' }, 401, cors);
      const rk = 'r:' + name;
      const tries = Number(await env.QT.get(rk)) || 0;
      if (tries >= 10) return json({ error: 'locked' }, 429, cors);
      const rec = JSON.parse((await env.QT.get('u:' + name)) || 'null');
      const ok = rec && safeEq(await sha256(rec.s + k), rec.h);
      if (!ok) {
        await env.QT.put(rk, String(tries + 1), { expirationTtl: 900 });
        return json({ error: 'bad_login' }, 401, cors);
      }
      return json(await issueToken(env, name), 200, cors);
    }

    if (p === '/auth/logout' && req.method === 'POST') {
      const m = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.get('Authorization') || '');
      if (m) await env.QT.delete('t:' + (await sha256(m[1])));
      return json({ ok: true }, 200, cors);
    }

    if (p === '/sync') {
      const name = await who(req, env);
      if (!name) return json({ error: 'unauthorized' }, 401, cors);
      if (req.method === 'GET') {
        const d = await env.QT.get('d:' + name);
        return json(d ? JSON.parse(d) : { fav: [], hist: [] }, 200, cors);
      }
      if (req.method === 'PUT') {
        const b = JSON.parse(await readBody(req, 400000));
        const data = { fav: cleanItems(b.fav, 1000), hist: cleanItems(b.hist, 500), upd: Date.now() };
        await env.QT.put('d:' + name, JSON.stringify(data));
        return json({ ok: true, upd: data.upd }, 200, cors);
      }
    }

    return json({ error: 'not_found' }, 404, cors);
  } catch (e) {
    if (e && e.message === 'too_big') return json({ error: 'too_big' }, 413, cors);
    return json({ error: 'bad_request' }, 400, cors);
  }
}
