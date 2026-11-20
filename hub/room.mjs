#!/usr/bin/env node
// dsh-room / room.mjs — 成员侧 CLI（pc / phone 的 agent 用它读写房间），零依赖。
//
//   node room.mjs say  <member> "内容" [--to phone,pc] [--reply <msg-id>] [--open]
//   node room.mjs next <member> [--since N] [--json] [--claim] [--watch]
//   node room.mjs read [--cursor N] [--json]
//   node room.mjs state
//
// 连接配置按顺序取：环境变量 ROOM_URL / ROOM_TOKEN → 同目录 config.json → http://127.0.0.1:38410
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function readJsonFile(p) {
  try {
    let s = fs.readFileSync(p, 'utf8');
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);   // PS 5.1 的 -Encoding utf8 会写 BOM
    return JSON.parse(s);
  } catch { return null; }
}

function cfg() {
  const file = readJsonFile(path.join(HERE, 'config.json')) || {};
  let token = process.env.ROOM_TOKEN || file.token || '';
  if (!token) {
    try { token = fs.readFileSync(path.join(HERE, 'token'), 'utf8').trim(); } catch {}
  }
  const url = (process.env.ROOM_URL || file.url || 'http://127.0.0.1:38410').replace(/\/+$/, '');
  return { url, token };
}

const { url: BASE, token: TOKEN } = cfg();

function q(p) {
  return TOKEN ? `${BASE}${p}${p.includes('?') ? '&' : '?'}token=${encodeURIComponent(TOKEN)}` : `${BASE}${p}`;
}

async function api(p, opts = {}) {
  const r = await fetch(q(p), {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${r.status} ${body.error || r.statusText}`);
  return body;
}

function envelope(m) {
  return `[[CHATv1 from=${m.from} msg=${m.msg} ts=${m.ts} chain=${m.chain} reply=${m.reply || '-'}]]`;
}

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) opt[k] = true;
      else { opt[k] = next; i++; }
    } else pos.push(a);
  }
  return { pos, opt };
}

async function cmdSay(pos, opt) {
  const [from, ...rest] = pos;
  const text = rest.join(' ').trim();
  if (!from || !text) throw new Error('用法: room.mjs say <member> "内容" [--to phone,pc] [--reply id]');
  const to = opt.to ? String(opt.to).split(',').map((s) => s.trim()).filter(Boolean) : [];
  const body = { from, text, to };
  if (opt.reply && opt.reply !== true) body.reply = opt.reply;
  const d = await api('/say', { method: 'POST', body: JSON.stringify(body) });
  console.log(d.envelope);
  if (opt.json) console.log(JSON.stringify(d.message, null, 2));
  return 0;
}

async function cmdNext(pos, opt) {
  const self = pos[0];
  if (!self) throw new Error('用法: room.mjs next <member> [--since N] [--claim] [--watch]');
  let since = Number(opt.since || 0);

  for (;;) {
    const d = await api(`/next?for=${encodeURIComponent(self)}&since=${since}`);
    since = Math.max(since, d.cursor || 0);

    if (!d.message) {
      if (opt.json) console.log(JSON.stringify({ speak: false, cursor: since, skipped: d.skipped || [] }));
      else console.log(`[${self}] 没有该接的话（cursor=${since}）`);
      if (opt.watch) { await new Promise((r) => setTimeout(r, 3000)); continue; }
      return 0;
    }

    if (d.needClaim && !opt.claim) {
      if (opt.json) {
        console.log(JSON.stringify({ speak: false, reason: 'need-claim', cursor: d.cursor, message: d.message }));
      } else {
        console.log(d.envelope);
        console.log(d.message.text);
        console.log(`--- 开放消息，要接就加 --claim（或让别人接）`);
      }
      return 0;
    }

    if (d.needClaim) {
      const c = await api('/claim', {
        method: 'POST',
        body: JSON.stringify({ seq: d.message.seq, member: self }),
      });
      if (!c.won) {
        if (opt.json) console.log(JSON.stringify({ speak: false, reason: 'claim-lost', owner: c.owner }));
        else console.log(`[${self}] “${c.owner}” 先接了这条（${d.message.msg}），跳过`);
        if (opt.watch) continue;
        return 0;
      }
    }

    if (opt.json) {
      console.log(JSON.stringify({
        speak: true,
        reason: d.reason,
        cursor: d.cursor,
        envelope: d.envelope,
        message: d.message,
      }, null, 2));
    } else {
      console.log(d.envelope);
      console.log(d.message.text);
      console.log(`--- 若要接话: node room.mjs say ${self} "…" --reply ${d.message.msg}`);
    }
    return 0;
  }
}

async function cmdRead(pos, opt) {
  const d = await api(`/since?cursor=${Number(opt.cursor || 0)}`);
  if (opt.json) { console.log(JSON.stringify(d, null, 2)); return 0; }
  if (!d.messages.length) { console.log('（没有新消息）'); return 0; }
  for (const m of d.messages) {
    console.log(`${m.ts.slice(11, 19)}  ${m.from.padEnd(6)} ${m.chain}`);
    console.log('   ' + m.text.replace(/\n/g, '\n   '));
  }
  console.log(`--- cursor=${d.cursor}`);
  return 0;
}

async function cmdState() {
  const s = await api('/state');
  console.log(JSON.stringify(s, null, 2));
  return 0;
}

const [cmd, ...argv] = process.argv.slice(2);
const { pos, opt } = parseArgs(argv);

try {
  const table = { say: cmdSay, next: cmdNext, read: cmdRead, state: cmdState };
  const fn = table[cmd];
  if (!fn) {
    console.log('用法: room.mjs <say|next|read|state> …');
    process.exit(2);
  }
  process.exit(await fn(pos, opt));
} catch (e) {
  console.error('错误:', e.message);
  if (String(e.message).includes('401')) {
    console.error('提示: 服务在跑，但 token 不对或没读到。当前实际使用:');
    console.error(`      url   = ${BASE}`);
    console.error(`      token = ${TOKEN ? TOKEN.slice(0, 8) + '…(' + TOKEN.length + ' 位)' : '(空)'}`);
    console.error('      临时绕过: $env:ROOM_TOKEN="<token 文件里的值>"; node room.mjs state');
  }
  process.exit(1);
}
