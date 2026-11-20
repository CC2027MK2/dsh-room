#!/usr/bin/env node
// dsh-room / mcp.mjs — 把房间暴露成 MCP 工具（stdio，零依赖）。
// 让我（pc 的 agent）直接 room_say / room_read，不用碰 shell。
//
// DSH 的 mcp 配置里加：
//   "room": { "command": "node", "args": ["<path>"] }
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = process.env.ROOM_SELF || 'pc';

function readJsonFile(p) {
  try {
    let s = fs.readFileSync(p, 'utf8');
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);   // PS 5.1 的 -Encoding utf8 会写 BOM
    return JSON.parse(s);
  } catch { return null; }
}

const file = readJsonFile(path.join(HERE, 'config.json')) || {};
let TOKEN = process.env.ROOM_TOKEN || file.token || '';
if (!TOKEN) {
  try { TOKEN = fs.readFileSync(path.join(HERE, 'token'), 'utf8').trim(); } catch {}
}
// 本机 agent ↔ hub 的地址：优先环境变量，其次桥写下的 memo（桥会在换网后
// 重新发现 hub 并更新它），最后才用 loopback。
const MEMO = path.join(os.homedir(), '.dsh', 'room-bridge', 'hub.json');

function memoBase() {
  try {
    const memo = JSON.parse(fs.readFileSync(MEMO, 'utf8'));
    if (memo && typeof memo.url === 'string' && memo.url) return memo.url.replace(/\/+$/, '');
  } catch { /* 没有 memo 就是还没跑过桥 */ }
  return '';
}

let BASE = (process.env.ROOM_URL || memoBase() || 'http://127.0.0.1:38410').replace(/\/+$/, '');

const q = (p, base = BASE) => (TOKEN ? `${base}${p}${p.includes('?') ? '&' : '?'}token=${encodeURIComponent(TOKEN)}` : `${base}${p}`);

/* ---------- hub 自启：App 重启后 hub 跟着一起回来，不用再单开终端 ---------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function alive() {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

let booting = null;
function ensureHub() {
  // 只有本机 hub 才由我拉起；远端 hub（手机连 PC）没得拉，也不该拉。
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(BASE)) return Promise.resolve();
  if (!booting) booting = (async () => {
    if (await alive()) return;
    try {
      const child = spawn(process.execPath, [path.join(HERE, 'server.mjs')], {
        cwd: HERE,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, ROOM_TOKEN: TOKEN },
      });
      child.unref();
    } catch { /* 起不来就让下面的 api 自己报错 */ }
    for (let i = 0; i < 30; i++) { await sleep(200); if (await alive()) return; }
  })();
  return booting;
}

async function api(p, opts = {}) {
  await ensureHub();
  let r;
  try {
    r = await fetch(q(p), {
      ...opts,
      headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    });
  } catch (e) {
    // 换网了：memo 可能已经更新，换一次地址再试。
    const fresh = memoBase();
    if (fresh && fresh !== BASE) {
      BASE = fresh;
      try {
        r = await fetch(q(p), {
          ...opts,
          headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
        });
      } catch (e2) {
        booting = null;
        throw new Error(`连不上 hub（${BASE}）：${e2.message}`);
      }
    } else {
      booting = null;
      throw new Error(`连不上 hub（${BASE}）：${e.message}`);
    }
  }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${r.status} ${body.error || r.statusText}`);
  return body;
}

const envelope = (m) =>
  `[[CHATv1 from=${m.from} msg=${m.msg} ts=${m.ts} chain=${m.chain} reply=${m.reply || '-'}]]`;

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

function human(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// 附件在正文后面单独成行，这样 agent 一眼能看出「这条有图、图叫什么、要不要取」。
function filesOf(m) {
  if (!Array.isArray(m.files) || !m.files.length) return '';
  return '\n' + m.files
    .map((f, i) => `[图片${i + 1}] ${f.name} · ${f.mime} · ${human(f.size)} · sha256:${String(f.sha256).slice(0, 12)} · file:${f.file}`)
    .join('\n');
}

const INBOX = path.join(os.homedir(), '.dsh', 'room-bridge', 'inbox');

const TOOLS = [
  {
    name: 'room_read',
    description: '读房间里的新消息（从 cursor 之后）。返回每条消息的信封头、正文，以及附件（图片）清单。',
    inputSchema: {
      type: 'object',
      properties: { cursor: { type: 'number', description: '上次返回的 cursor，默认 0 从头读' } },
    },
  },
  {
    name: 'room_next',
    description: '问房间「现在轮到我说话吗」。会按防回环规则判定：是否 @我、是否已达跳数上限、是否被别人接了。needClaim 为 true 时会自动替我举手。',
    inputSchema: {
      type: 'object',
      properties: { since: { type: 'number', description: '我的游标' } },
    },
  },
  {
    name: 'room_say',
    description: `以 ${SELF} 身份在房间发言。to 为空表示开放消息（谁先接谁答）；reply 传对方 msg id 以接在某个话题链上。`,
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '正文' },
        to: { type: 'array', items: { type: 'string' }, description: '定向：["phone"] / ["user"]，留空=开放' },
        reply: { type: 'string', description: '要回复的消息 msg id' },
      },
      required: ['text'],
    },
  },
  {
    name: 'room_send_image',
    description: '把本机的一张图片发到房间（png/jpeg/webp/gif/bmp，≤12MB）。text 可选，作为图片的配文。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '本机图片绝对路径' },
        text: { type: 'string', description: '配文（可选）' },
        to: { type: 'array', items: { type: 'string' }, description: '定向成员，留空=开放' },
        reply: { type: 'string', description: '要接在哪条消息后面' },
      },
      required: ['path'],
    },
  },
  {
    name: 'room_fetch',
    description: '把房间里的一张图片下载到本机收件箱，返回绝对路径（之后用 read_image 看它）。',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string', description: '消息里的 file:<名字>' } },
      required: ['file'],
    },
  },
];

async function uploadImage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) throw new Error(`不支持的图片类型：${ext || '(无扩展名)'}（只收 png/jpeg/webp/gif/bmp）`);
  const buf = fs.readFileSync(filePath);
  await ensureHub();
  const name = path.basename(filePath);
  const r = await fetch(q(`/upload?name=${encodeURIComponent(name)}`), {
    method: 'POST',
    headers: { 'content-type': mime },
    body: buf,
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${r.status} ${body.error || r.statusText}`);
  return body.file;
}

async function downloadFile(file) {
  await ensureHub();
  const r = await fetch(q(`/files/${encodeURIComponent(file)}`));
  if (!r.ok) throw new Error(`${r.status} 取不到 ${file}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.mkdirSync(INBOX, { recursive: true });
  const dest = path.join(INBOX, file);
  fs.writeFileSync(dest, buf);
  return { dest, size: buf.length };
}

async function call(name, args = {}) {
  if (name === 'room_read') {
    const d = await api(`/since?cursor=${Number(args.cursor || 0)}`);
    if (!d.messages.length) return `（没有新消息，cursor=${d.cursor}）`;
    const out = d.messages.map((m) => `${envelope(m)}\n${m.text}${filesOf(m)}`).join('\n\n');
    return `${out}\n\n--- cursor=${d.cursor}`;
  }

  if (name === 'room_next') {
    const d = await api(`/next?for=${encodeURIComponent(SELF)}&since=${Number(args.since || 0)}`);
    if (!d.message) return `轮不到我说话（cursor=${d.cursor}，跳过原因：${(d.skipped || []).map((s) => `${s.seq}:${s.reason}`).join(' ') || '无新消息'}）`;
    let claimed = null;
    if (d.needClaim) {
      const c = await api('/claim', { method: 'POST', body: JSON.stringify({ seq: d.message.seq, member: SELF }) });
      if (!c.won) return `话题被 ${c.owner} 先接了（${d.message.msg}），不用回。cursor=${d.cursor}`;
      claimed = true;
    }
    return `${d.envelope}\n${d.message.text}${filesOf(d.message)}\n\n--- 判定：${d.reason}${claimed ? '，已举手' : ''}；要接话就 room_say({text, reply:"${d.message.msg}"})，cursor=${d.cursor}`;
  }

  if (name === 'room_say') {
    const body = {
      from: SELF,
      text: String(args.text || ''),
      to: Array.isArray(args.to) ? args.to : args.to ? [args.to] : [],
    };
    if (args.reply) body.reply = args.reply;
    const d = await api('/say', { method: 'POST', body: JSON.stringify(body) });
    return `${d.envelope}\n已写入房间。`;
  }

  if (name === 'room_send_image') {
    const p = String(args.path || '');
    if (!p || !fs.existsSync(p)) throw new Error(`找不到文件：${p}`);
    const file = await uploadImage(p);
    const body = {
      from: SELF,
      text: String(args.text || ''),
      to: Array.isArray(args.to) ? args.to : args.to ? [args.to] : [],
      files: [file],
    };
    if (args.reply) body.reply = args.reply;
    const d = await api('/say', { method: 'POST', body: JSON.stringify(body) });
    return `${d.envelope}\n${filesOf(d.message).trim()}\n已发到房间（${human(file.size)}，sha256:${file.sha256.slice(0, 12)}）。`;
  }

  if (name === 'room_fetch') {
    const file = String(args.file || '').replace(/^file:/, '');
    const { dest, size } = await downloadFile(file);
    return `已下载到 ${dest}（${human(size)}）。用 read_image({path:"${dest}"}) 查看。`;
  }

  throw new Error(`unknown tool: ${name}`);
}

/* ---------- JSON-RPC over stdio ---------- */

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', async (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try { msg = JSON.parse(t); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }

  const { id, method, params } = msg;
  const reply = (result) => send({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  try {
    if (method === 'initialize') {
      return reply({
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'dsh-room', version: '0.1.0' },
      });
    }
    if (method === 'notifications/initialized' || method?.startsWith('notifications/')) return;
    if (method === 'tools/list') return reply({ tools: TOOLS });
    if (method === 'tools/call') {
      const text = await call(params?.name, params?.arguments || {});
      return reply({ content: [{ type: 'text', text }] });
    }
    if (method === 'ping') return reply({});
    return fail(-32601, `method not found: ${method}`);
  } catch (e) {
    return reply({ content: [{ type: 'text', text: '错误: ' + e.message }], isError: true });
  }
});

rl.on('close', () => process.exit(0));
