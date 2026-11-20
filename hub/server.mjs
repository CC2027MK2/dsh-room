#!/usr/bin/env node
// dsh-room / server.mjs — 三方群聊 hub（user / phone / pc），CHATv1 信封，零依赖。
// 启动: node server.mjs        （默认 0.0.0.0:38410）
// 环境: ROOM_PORT ROOM_HOST ROOM_TOKEN ROOM_MAX_HOPS ROOM_RATE ROOM_MEMBERS ROOM_DATA
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.ROOM_DATA || path.join(HERE, 'data');
const LOG_PATH = path.join(DATA_DIR, 'room.jsonl');

const CFG = {
  port: Number(process.env.ROOM_PORT || 38410),
  host: process.env.ROOM_HOST || '0.0.0.0',
  maxHops: Number(process.env.ROOM_MAX_HOPS || 6),
  maxPerMinute: Number(process.env.ROOM_RATE || 12),
  members: (process.env.ROOM_MEMBERS || 'user,phone,pc')
    .split(',').map((s) => s.trim()).filter(Boolean),
};

const TOKEN = process.env.ROOM_TOKEN || (() => {
  try { return fs.readFileSync(path.join(HERE, 'token'), 'utf8').trim(); } catch { return ''; }
})();

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------- 状态 ---------- */

let messages = [];
let seq = 0;
const claims = new Map();   // msgSeq -> member（开放消息谁接了）
const subs = new Set();     // SSE 连接
const recent = new Map();   // from -> [timestamp]

(function load() {
  if (!fs.existsSync(LOG_PATH)) return;
  for (const line of fs.readFileSync(LOG_PATH, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const m = JSON.parse(t);
      if (typeof m?.seq === 'number') { messages.push(m); seq = Math.max(seq, m.seq); }
    } catch { /* 坏行跳过 */ }
  }
})();

const memberSet = new Set(CFG.members);

class HttpError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}

/* ---------- 工具 ---------- */

function newMsgId(from, ts) {
  const stamp = ts.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${from}-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

function hopsOf(chain) {
  return String(chain || '').split('/').filter(Boolean).length;
}

function lastSpeaker() {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].kind === 'system') continue;
    return messages[i].from;
  }
  return null;
}

function rateOk(from) {
  const now = Date.now();
  const arr = (recent.get(from) || []).filter((t) => now - t < 60_000);
  recent.set(from, arr);
  return arr.length < CFG.maxPerMinute;
}

function touchRate(from) {
  const arr = recent.get(from) || [];
  arr.push(Date.now());
  recent.set(from, arr);
}

/* ---------- 写消息 ---------- */

function append({ from, text, to = [], reply = null, kind = 'chat', files = [] }) {
  if (!memberSet.has(from)) throw new HttpError(400, `unknown member: ${from}`);
  const hasFiles = Array.isArray(files) && files.length > 0;
  if (typeof text !== 'string' || (!text.trim() && !hasFiles)) throw new HttpError(400, 'text required');
  // 限流只管 agent，不限制人
  if (kind !== 'system' && from !== 'user' && !rateOk(from)) {
    throw new HttpError(429, `rate limit ${CFG.maxPerMinute}/min for ${from}`);
  }

  let chain = from;
  let parent = null;
  if (reply) {
    parent = messages.find((m) => m.msg === reply) || null;
    if (!parent) throw new HttpError(404, `reply target not found: ${reply}`);
    chain = `${parent.chain}/${from}`;
  }
  const hops = hopsOf(chain);
  if (hops > CFG.maxHops) {
    throw new HttpError(409, `hop limit ${CFG.maxHops} reached (chain=${chain})；请由 user 开新话题`);
  }

  const ts = new Date().toISOString();
  // @name in the text counts as addressing, the same as an explicit `to` list.
  // People type "@phone ..." in the UI and agents copy that habit; without this
  // the message stays "open", the first responder wins, and the named member
  // never gets woken.
  let addressed = Array.isArray(to) ? to.filter((x) => memberSet.has(x)) : [];
  if (addressed.length === 0 && typeof text === 'string') {
    const named = new Set();
    for (const hit of text.matchAll(/(^|[\s(（,，、])@([A-Za-z0-9_-]+)/g)) {
      const name = hit[2].toLowerCase();
      if (name !== from && memberSet.has(name)) named.add(name);
    }
    if (named.size > 0) addressed = [...named];
  }
  const m = {
    seq: ++seq,
    msg: newMsgId(from, ts),
    ts,
    from,
    to: addressed,
    text: typeof text === 'string' ? text.trim() : '',
    reply,
    chain,
    kind,
  };
  if (hasFiles) m.files = files;

  messages.push(m);
  touchRate(from);
  fs.appendFileSync(LOG_PATH, JSON.stringify(m) + '\n');
  for (const r of subs) {
    try { r.write(`data: ${JSON.stringify(m)}\n\n`); } catch { /* 掉线忽略 */ }
  }
  return m;
}

/* ---------- 发言判定 ---------- */

function evaluate(m, self) {
  if (!memberSet.has(self)) return { speak: false, reason: 'unknown-member' };
  if (m.from === self) return { speak: false, reason: 'self' };
  if (m.kind === 'system') return { speak: false, reason: 'system' };
  // 我已经回过这条了（防止同一条被反复唤醒）
  if (messages.some((x) => x.reply === m.msg && x.from === self)) {
    return { speak: false, reason: 'already-answered' };
  }
  if (hopsOf(m.chain) >= CFG.maxHops) return { speak: false, reason: 'max-hops' };

  const to = m.to || [];
  const addressedMe = to.includes(self);
  if (to.length && !addressedMe) return { speak: false, reason: 'not-addressed' };
  if (!rateOk(self)) return { speak: false, reason: 'rate' };

  if (addressedMe) return { speak: true, reason: 'addressed', claim: false };

  // 开放式消息：谁先举手谁接；刚说完的一方不再连说
  if (lastSpeaker() === self) return { speak: false, reason: 'self-last' };
  const owner = claims.get(m.seq);
  if (owner && owner !== self) return { speak: false, reason: `claimed-by-${owner}` };
  return { speak: true, reason: 'open', claim: true };
}

/* ---------- HTTP ---------- */

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(s);
}

function authed(req, url) {
  if (!TOKEN) return true;
  const h = String(req.headers.authorization || '');
  if (h.startsWith('Bearer ') && h.slice(7).trim() === TOKEN) return true;
  return url.searchParams.get('token') === TOKEN;
}

async function readBody(req) {
  let raw = '';
  for await (const c of req) {
    raw += c;
    if (raw.length > 1_000_000) throw new HttpError(413, 'body too large');
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new HttpError(400, 'invalid json'); }
}

/* ---------- 附件（图片） ---------- */

const FILES_DIR = path.join(DATA_DIR, 'files');
const MAX_FILE_BYTES = Number(process.env.ROOM_MAX_FILE || 12 * 1024 * 1024);
const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
};

async function readBinary(req, limit = MAX_FILE_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, `file too large (limit ${limit} bytes)`);
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function safeName(name, fallback) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  const cleaned = base.replace(/[^\w.\-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
  return cleaned || fallback;
}

function storeFile(buf, mime, name) {
  const ext = MIME_EXT[mime];
  if (!ext) throw new HttpError(415, `unsupported image type: ${mime || '(none)'}`);
  if (!buf.length) throw new HttpError(400, 'empty file');
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const id = sha256.slice(0, 16);
  const file = `${id}.${ext}`;
  fs.mkdirSync(FILES_DIR, { recursive: true });
  const dest = path.join(FILES_DIR, file);
  const meta = { id, file, name: safeName(name, `image.${ext}`), mime, size: buf.length, sha256 };
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, buf);
  fs.writeFileSync(`${dest}.json`, JSON.stringify(meta));
  return meta;
}

// 只认已落盘的附件，避免客户端塞任意 URL / 路径进消息。
function resolveFiles(list) {
  if (!Array.isArray(list) || !list.length) return [];
  const out = [];
  for (const item of list) {
    const file = typeof item === 'string' ? item : item&&item.file;
    if (typeof file !== 'string' || !/^[0-9a-f]{16}\.(png|jpg|webp|gif|bmp)$/.test(file)) {
      throw new HttpError(400, `bad attachment reference: ${JSON.stringify(item)}`);
    }
    const full = path.join(FILES_DIR, file);
    if (!fs.existsSync(full)) throw new HttpError(404, `attachment not found: ${file}`);
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(`${full}.json`, 'utf8')); } catch { /* 老文件没有边车 */ }
    if (!meta) {
      const ext = file.split('.').pop();
      meta = {
        id: file.slice(0, 16),
        file,
        mime: Object.keys(MIME_EXT).find((m) => MIME_EXT[m] === ext) || 'application/octet-stream',
        size: fs.statSync(full).size,
        sha256: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'),
        name: (item && item.name) || file,
      };
    }
    out.push(meta);
  }
  return out;
}

function envelope(m) {
  return `[[CHATv1 from=${m.from} msg=${m.msg} ts=${m.ts} chain=${m.chain} reply=${m.reply || '-'}]]`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/health') {
      return json(res, 200, { ok: true, seq, members: CFG.members, auth: Boolean(TOKEN), maxFileBytes: MAX_FILE_BYTES });
    }

    // 静态 UI：不鉴权，页面自己收 token
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/ui')) {
      const file = path.join(HERE, 'ui.html');
      if (!fs.existsSync(file)) return json(res, 404, { error: 'ui.html missing' });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(file));
    }

    if (!authed(req, url)) return json(res, 401, { error: 'unauthorized' });

    /* 取附件（<img src> 用 ?token= 鉴权） */
    if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
      const name = path.basename(url.pathname.replace('/files/', ''));
      if (!/^[0-9a-f]{16}\.(png|jpg|webp|gif|bmp)$/.test(name)) {
        return json(res, 404, { error: 'not found' });
      }
      const full = path.join(FILES_DIR, name);
      if (!fs.existsSync(full)) return json(res, 404, { error: 'not found' });
      const ext = name.split('.').pop();
      const mime = Object.keys(MIME_EXT).find((m) => MIME_EXT[m] === ext) || 'application/octet-stream';
      res.writeHead(200, {
        'content-type': mime,
        'content-length': fs.statSync(full).size,
        'cache-control': 'public, max-age=31536000, immutable',
      });
      return res.end(fs.readFileSync(full));
    }

    /* 上传图片：body 是原始字节，文件名走 ?name=，类型走请求头 */
    if (req.method === 'POST' && url.pathname === '/upload') {
      const mime = String(req.headers['content-type'] || '').split(';')[0].trim();
      const buf = await readBinary(req);
      const file = storeFile(buf, mime, url.searchParams.get('name'));
      return json(res, 201, { file });
    }

    /* 发消息 */
    if (req.method === 'POST' && url.pathname === '/say') {
      const body = await readBody(req);
      const m = append({
        from: body.from,
        text: body.text,
        to: body.to,
        reply: body.reply || null,
        kind: body.kind || 'chat',
        files: resolveFiles(body.files),
      });
      return json(res, 201, { message: m, envelope: envelope(m) });
    }

    /* 增量读 */
    if (req.method === 'GET' && url.pathname === '/since') {
      const cursor = Number(url.searchParams.get('cursor') || 0);
      const limit = Math.min(Number(url.searchParams.get('limit') || 200), 500);
      const list = messages.filter((m) => m.seq > cursor).slice(0, limit);
      return json(res, 200, {
        cursor: list.length ? list[list.length - 1].seq : Math.max(cursor, seq),
        seq,
        messages: list,
      });
    }

    /* 给某个成员找下一条该回的 */
    if (req.method === 'GET' && url.pathname === '/next') {
      const self = url.searchParams.get('for');
      if (!self) throw new HttpError(400, 'for required');
      if (!memberSet.has(self)) throw new HttpError(400, `unknown member: ${self}`);
      const since = Number(url.searchParams.get('since') || 0);
      const skipped = [];
      for (const m of messages) {
        if (m.seq <= since) continue;
        const v = evaluate(m, self);
        if (!v.speak) { skipped.push({ seq: m.seq, reason: v.reason }); continue; }
        return json(res, 200, {
          cursor: m.seq,
          message: m,
          envelope: envelope(m),
          speak: true,
          reason: v.reason,
          needClaim: v.claim,
        });
      }
      return json(res, 200, {
        cursor: Math.max(since, seq),
        seq,
        message: null,
        speak: false,
        skipped: skipped.slice(-20),
      });
    }

    /* 抢答开放消息 */
    if (req.method === 'POST' && url.pathname === '/claim') {
      const body = await readBody(req);
      const target = messages.find((m) => m.seq === Number(body.seq));
      if (!target) throw new HttpError(404, 'no such seq');
      if (!memberSet.has(body.member)) throw new HttpError(400, 'unknown member');
      const owner = claims.get(target.seq);
      if (owner && owner !== body.member) {
        return json(res, 200, { won: false, owner });
      }
      claims.set(target.seq, body.member);
      return json(res, 200, { won: true, owner: body.member });
    }

    /* 房间状态：给人看的防回环透视 */
    if (req.method === 'GET' && url.pathname === '/state') {
      const counts = {};
      for (const m of messages) counts[m.from] = (counts[m.from] || 0) + 1;
      return json(res, 200, {
        seq,
        members: CFG.members,
        limits: { maxHops: CFG.maxHops, maxPerMinute: CFG.maxPerMinute },
        lastSpeaker: lastSpeaker(),
        counts,
        openClaims: [...claims.entries()].map(([s, who]) => ({ seq: s, member: who })),
        tail: messages.slice(-10),
      });
    }

    /* SSE 实时流 */
    if (req.method === 'GET' && url.pathname === '/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(`: connected seq=${seq}\n\n`);
      subs.add(res);
      const ka = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20_000);
      req.on('close', () => { clearInterval(ka); subs.delete(res); });
      return;
    }

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    const code = e instanceof HttpError ? e.code : 500;
    return json(res, code, { error: e.message || String(e) });
  }
});

server.listen(CFG.port, CFG.host, () => {
  const auth = TOKEN ? 'token 已启用' : '⚠ 无 token（仅建议本机/可信内网）';
  console.log(`[room] http://${CFG.host}:${CFG.port}  members=${CFG.members.join(',')}`);
  console.log(`[room] 日志 ${LOG_PATH}  seq=${seq}  ${auth}`);
  console.log(`[room] 防回环 maxHops=${CFG.maxHops} rate=${CFG.maxPerMinute}/min`);
});
