// Proxy MangaDex + tài khoản sao lưu cho Quýt Truyện (Cloudflare Worker).
// Cần gắn một KV namespace với tên biến QT để dùng đăng ký, đăng nhập, đồng bộ.
// Không có KV thì phần proxy vẫn chạy, chỉ phần tài khoản báo chưa bật.
// Dịch truyện bằng AI: gắn Workers AI với tên biến AI (Settings > Bindings > Add > Workers AI).
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
    if (u.pathname === '/ping') return json({ ok: true, v: 8, kv: !!(env && env.QT), img: true, ai: !!(env && env.AI) }, 200, cors);
    if (u.pathname.startsWith('/auth/') || u.pathname === '/sync') {
      return account(req, env, u, cors);
    }

    if (u.pathname === '/translate' && req.method === 'POST') return translate(req, env, cors);
    if (u.pathname === '/translate-text' && req.method === 'POST') return translateText(req, env, cors);

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

/* ---------- dịch truyện bằng AI ---------- */
const AI_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
const AI_PROMPT =
  'You are a professional manga translator. Read ALL the text in this comic page (speech bubbles, captions, narration, sound effects) in reading order, ' +
  'and translate it into natural, concise Vietnamese that fits each character. ' +
  'Reply with ONLY a JSON array, no markdown and no explanation. Each item must look like {"s":"original text","v":"Vietnamese translation"}. ' +
  'If the page has no text, reply with [].';

function cleanItem(x) {
  return { s: String((x && (x.s || x.src)) || '').slice(0, 300), v: String((x && (x.v || x.vi)) || '').slice(0, 400) };
}

function parseItems(raw) {
  const text = String(raw || '').replace(/```(?:json)?/gi, '').trim();
  if (!text) return [];
  // 1) mảng JSON đầy đủ
  const a = text.indexOf('['), b = text.lastIndexOf(']');
  if (a >= 0 && b > a) {
    try {
      const arr = JSON.parse(text.slice(a, b + 1));
      if (Array.isArray(arr)) return arr.filter((x) => x && typeof x === 'object').slice(0, 40).map(cleanItem).filter((x) => x.v);
    } catch (e) { /* thử cách khác */ }
  }
  // 2) nhặt từng đối tượng {..} (kể cả khi mảng bị cắt dở)
  const objs = text.match(/\{[^{}]*\}/g) || [];
  const got = [];
  for (const o of objs) {
    try { const x = cleanItem(JSON.parse(o)); if (x.v) got.push(x); } catch (e) { /* bỏ qua */ }
  }
  if (got.length) return got.slice(0, 40);
  // 3) văn bản thường: mỗi dòng là một câu
  if (text.length > 1500) return null;
  const lines = text.split(/\n+/).map((l) => l.replace(/^[\s\-*\d.)]+/, '').trim()).filter((l) => l.length > 1);
  return lines.length ? lines.slice(0, 20).map((l) => ({ s: '', v: l.slice(0, 400) })) : [];
}

async function runModel(env, img) {
  return env.AI.run(AI_MODEL, {
    messages: [{ role: 'user', content: [
      { type: 'text', text: AI_PROMPT },
      { type: 'image_url', image_url: { url: img } },
    ] }],
    max_tokens: 1400,
    temperature: 0.2,
  });
}

async function translate(req, env, cors) {
  if (!env.AI) return json({ error: 'no_ai' }, 503, cors);
  if (req.headers.get('Origin') !== ALLOWED_ORIGIN) return json({ error: 'forbidden' }, 403, cors);
  let img;
  try {
    const b = JSON.parse(await readBody(req, 1800000));
    img = String(b.img || '');
  } catch (e) {
    return json({ error: e && e.message === 'too_big' ? 'too_big' : 'bad_request' }, e && e.message === 'too_big' ? 413 : 400, cors);
  }
  if (!/^data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/.test(img)) return json({ error: 'bad_image' }, 400, cors);
  try {
    let r;
    try { r = await runModel(env, img); }
    catch (e) {
      // Llama 3.2 Vision cần đồng ý điều khoản một lần duy nhất.
      if (/agree|license|5016/i.test(String(e && e.message))) {
        await env.AI.run(AI_MODEL, { prompt: 'agree' });
        r = await runModel(env, img);
      } else throw e;
    }
    const raw = typeof r === 'string' ? r : (r && (r.response || (r.result && r.result.response))) || '';
    const items = parseItems(typeof raw === 'string' ? raw : JSON.stringify(raw));
    if (!items) return json({ error: 'bad_output' }, 502, cors);
    return json({ items }, 200, cors);
  } catch (e) {
    const m = String((e && e.message) || e);
    if (/quota|limit|neuron|4006|exceeded/i.test(m)) return json({ error: 'quota' }, 429, cors);
    return json({ error: 'ai_failed', detail: m.slice(0, 220) }, 502, cors);
  }
}

/* ---------- dịch văn bản (dùng cho chữ đã nhận dạng trong ảnh) ---------- */
const TXT_MODEL = '@cf/meta/llama-3.1-8b-instruct';
const LANG_NAME = { en: 'English', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', 'zh-hk': 'Chinese', es: 'Spanish', fr: 'French', de: 'German', 'pt-br': 'Portuguese', pt: 'Portuguese', id: 'Indonesian', ru: 'Russian', it: 'Italian', tr: 'Turkish', pl: 'Polish' };

async function translateText(req, env, cors) {
  if (!env.AI) return json({ error: 'no_ai' }, 503, cors);
  if (req.headers.get('Origin') !== ALLOWED_ORIGIN) return json({ error: 'forbidden' }, 403, cors);
  let texts, from;
  try {
    const b = JSON.parse(await readBody(req, 60000));
    texts = Array.isArray(b.texts) ? b.texts.slice(0, 40).map((t) => String(t).replace(/\s+/g, ' ').trim().slice(0, 300)) : [];
    from = LANG_NAME[String(b.from || 'en')] || 'English';
  } catch (e) {
    return json({ error: e && e.message === 'too_big' ? 'too_big' : 'bad_request' }, e && e.message === 'too_big' ? 413 : 400, cors);
  }
  if (!texts.length) return json({ items: [] }, 200, cors);
  const prompt =
    'Translate each numbered line of this comic dialogue from ' + from + ' into natural, concise Vietnamese that sounds like a real character speaking. ' +
    'Keep the same numbering. Output ONLY lines in the format N|translation, one per input line, with no explanation.\n\n' +
    texts.map((t, i) => (i + 1) + '|' + t).join('\n');
  try {
    const r = await env.AI.run(TXT_MODEL, {
      messages: [
        { role: 'system', content: 'You are a professional comic translator into Vietnamese.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 1800,
      temperature: 0.3,
    });
    const raw = typeof r === 'string' ? r : (r && (r.response || (r.result && r.result.response))) || '';
    const out = texts.map(() => '');
    for (const line of String(raw).split(/\n+/)) {
      const m = /^\s*(\d{1,2})\s*[|.:)\-]\s*(.+?)\s*$/.exec(line);
      if (m) { const i = Number(m[1]) - 1; if (i >= 0 && i < out.length && !out[i]) out[i] = m[2].slice(0, 400); }
    }
    return json({ items: out }, 200, cors);
  } catch (e) {
    const m = String((e && e.message) || e);
    if (/quota|limit|neuron|4006|exceeded/i.test(m)) return json({ error: 'quota' }, 429, cors);
    return json({ error: 'ai_failed', detail: m.slice(0, 220) }, 502, cors);
  }
}
