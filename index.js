#!/usr/bin/env node
// dsh-room-bridge — mirror a dsh-room hub into a live DSH session.
//
// The room hub (dsh-room/server.mjs) is a dumb append-only log: it stores and
// serves messages, but it never wakes anyone. Until now the only way a human
// could get an agent to answer in the room was to walk into the agent's chat
// and literally say "go read the room".
//
// This plugin closes that loop. It polls `/next?for=<member>`, which runs the
// hub's own anti-loop `evaluate()`, and when the hub says "this member should
// speak", it injects the message into the live session as a user turn. The
// agent then answers with its normal `room_say` tool, and the human never has
// to poke it.
//
// Design notes
// - The hub stays authoritative: hop limits, `to` addressing, claim races,
//   rate limits and `self-last` are all decided there, not here. We only ask.
// - The cursor is persisted, so a restart resumes instead of replaying.
// - Injections are collapsed: several messages that arrive together become one
//   turn, and nothing is injected more often than `minGapMs`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveHub } from './discovery.mjs';

export const name = 'room-bridge';
export const inject = ['agents'];

const DEFAULT_POLL_MS = 1500;
const DEFAULT_MIN_GAP_MS = 4000;
const MAX_BATCH = 6;

function readToken (config) {
  if (config.token) return String(config.token).trim();
  if (config.tokenFile) {
    try {
      return fs.readFileSync(config.tokenFile, 'utf8').trim();
    } catch (error) {
      console.error(`[room-bridge] cannot read tokenFile ${config.tokenFile}: ${error.message}`);
    }
  }
  return '';
}

function envelopeOf (m) {
  return `[[CHATv1 from=${m.from} msg=${m.msg} ts=${m.ts} chain=${m.chain} reply=${m.reply || '-'}]]`;
}

/**
 * Build the injected user message.
 *
 * `createUserMessage` lives in `@deepseek-ai/dsh-llm`, which only resolves for
 * a plugin that pnpm linked against the host's virtual store. A linked plugin
 * (as during development) cannot see it, so we reproduce the one-line shape
 * `message.js` defines: `{...input, role: 'user', id: <uuid>}`, frozen. If the
 * real helper is reachable we prefer it.
 */
let userMessageFactory;
async function buildUserMessage (text, log) {
  const content = [{ type: 'text', text }];
  const source = { kind: 'user' };
  if (userMessageFactory === undefined) {
    try {
      const llm = await import('@deepseek-ai/dsh-llm');
      userMessageFactory = typeof llm.createUserMessage === 'function' ? llm.createUserMessage : null;
    } catch (error) {
      log(`dsh-llm unresolved (${error.message}); hand-building messages`);
      userMessageFactory = null;
    }
  }
  if (userMessageFactory) return userMessageFactory({ content, source });
  return Object.freeze(structuredClone({ id: randomUUID(), role: 'user', content, source }));
}

/** The hub's /next skips lines that are not ours; run it to see what is owed. */async function askNext (base, token, member, since, log) {
  const url = new URL('/next', base);
  url.searchParams.set('for', member);
  url.searchParams.set('since', String(since));
  const res = await fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`/next ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  log(`next: seq<=${body.seq} speak=${body.speak} reason=${body.reason || '-'} cursor=${body.cursor}`);
  return body;
}

/** Claim an open message; the hub only lets the first caller answer it. */
async function claim (base, token, member, seq, log) {
  const res = await fetch(new URL('/claim', base), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ member, seq }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`/claim ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  log(`claim seq=${seq} won=${body.won} owner=${body.owner}`);
  return body.won === true;
}

/**
 * Find the agent to wake.
 *
 * The Agents registry does not publish a list method on every release, so we
 * try the shapes that exist in the wild and fall back to the newest session
 * directory of this profile. An explicit `sessionId` always wins.
 */
function liveAgent (ctx, config, log) {
  const agents = ctx.get('agents');
  if (!agents) {
    log('no agents service');
    return null;
  }
  const wanted = (config.sessionId || '').trim();
  if (wanted) {
    // A pinned session is a promise: never quietly deliver the batch somewhere
    // else just because the pinned one is not live right now. The caller
    // retries the window, so the message is simply redelivered later.
    const agent = agents.get(wanted);
    log(`agents.get(${wanted}) -> ${agent ? 'hit' : 'miss (pinned, no fallback)'}`);
    return agent ?? null;
  }
  for (const method of ['list', 'all', 'entries', 'values']) {
    const fn = agents[method];
    if (typeof fn !== 'function') continue;
    try {
      const raw = fn.call(agents);
      const items = Array.isArray(raw)
        ? raw
        : raw instanceof Map
          ? [...raw.values()]
          : raw && typeof raw === 'object'
            ? Object.values(raw)
            : [];
      // Bridge sessions of other agents (`peer:chat`, `pcchat:group`, …) are
      // real sessions too, and picking one of them is exactly how a wake-up
      // used to land in the wrong conversation. Only human chats qualify.
      const human = items.filter((item) => {
        const id = String(item?.session?.id ?? item?.id ?? '');
        return id && !/[:~]/.test(id) && !/^(peer|pcchat|watch|sub)/i.test(id);
      });
      if (human.length) {
        log(`agents.${method}() -> ${items.length} item(s), ${human.length} human session(s)`);
        return human[human.length - 1];
      }
      if (items.length) {
        log(`agents.${method}() -> ${items.length} item(s), none look like a human chat`);
      }
    } catch (error) {
      log(`agents.${method}() threw: ${error.message}`);
    }
  }
  const picked = newestSessionAgent(ctx, agents, log);
  if (picked) return picked;
  log('no live agent resolvable');
  return null;
}

let cachedAgent = null;
let lastEnsureAt = 0;

/**
 * Resolve the one session the room writes into (option B: a dedicated chat).
 *
 * Order matters: reuse the live agent, then try to revive the persisted
 * session, then create it. Creation has to happen through the agent factory
 * with the profile's current model selection, otherwise the first turn has no
 * model to run on. Both steps are cooldown-gated so an unavailable host does
 * not spin.
 */
async function ensureRoomAgent (ctx, config, log) {
  const id = (config.sessionId || '').trim();
  if (!id) return null;
  const agents = ctx.get('agents');
  if (!agents) {
    log('no agents service');
    return null;
  }
  const live = typeof agents.get === 'function' ? agents.get(id) : undefined;
  if (live) {
    cachedAgent = live;
    return live;
  }
  cachedAgent = null;
  const now = Date.now();
  if (now - lastEnsureAt < 15000) return null;
  lastEnsureAt = now;

  try {
    const handle = await agents.resume({ resumeSessionId: id });
    const agent = handle?.agent ?? handle ?? null;
    if (agent) {
      log(`session ${id}: resumed`);
      cachedAgent = agent;
      return agent;
    }
  } catch (error) {
    log(`session ${id}: resume failed (${error.message})`);
  }

  if (config.createIfMissing === false) return null;
  let installModelSelection = null;
  try {
    const mod = await import('@deepseek-ai/dsh-agent');
    installModelSelection = typeof mod.installModelSelection === 'function' ? mod.installModelSelection : null;
  } catch (error) {
    log(`dsh-agent import unavailable (${error.message}); creating without a model selection`);
  }
  const defaults = ctx.get('agentDefaultModel');
  const selection = () => {
    try {
      return defaults?.currentSelection?.() ?? {};
    } catch {
      return {};
    }
  };
  try {
    const handle = await agents.create({
      sessionId: id,
      agentOptions: {
        get provider() {
          return selection().provider;
        },
        get model() {
          return selection().model;
        },
        get reasoningEffort() {
          return selection().reasoningEffort;
        },
      },
      meta: { cwd: config.cwd || process.cwd() },
      setup: (agentCtx) => {
        if (installModelSelection) installModelSelection(agentCtx);
      },
    });
    const agent = handle?.agent ?? handle ?? null;
    if (agent) {
      log(`session ${id}: created`);
      cachedAgent = agent;
      return agent;
    }
  } catch (error) {
    log(`session ${id}: create failed (${error.message})`);
  }
  return null;
}
/** Last resort: newest session file of the current profile, looked up in the registry. */
function newestSessionAgent (ctx, agents, log) {
  try {
    const cwd = process.cwd();
    const slug = `--${cwd.replace(/[\\/:]/g, '-')}--`;
    const dir = path.join(os.homedir(), '.dsh', 'sessions', slug);
    if (!fs.existsSync(dir)) {
      log(`session dir missing: ${dir}`);
      return null;
    }
    const newest = fs.readdirSync(dir)
      .filter((entry) => entry.startsWith('session-'))
      .map((entry) => ({ entry, at: fs.statSync(path.join(dir, entry)).mtimeMs }))
      .sort((a, b) => b.at - a.at)[0];
    if (!newest) return null;
    const id = newest.entry.slice('session-'.length);
    const agent = agents.get(id);
    log(`newest session ${id} -> ${agent ? 'hit' : 'miss'}`);
    return agent ?? null;
  } catch (error) {
    log(`newestSessionAgent failed: ${error.message}`);
    return null;
  }
}

export function apply (ctx, config = {}) {
  const dataDir = config.dataDir || process.env.DSH_ROOM_BRIDGE_DATA || path.join(os.homedir(), '.dsh', 'room-bridge');
  fs.mkdirSync(dataDir, { recursive: true });
  const logFile = config.logFile || path.join(dataDir, 'bridge.log');
  const log = (msg) => {
    try {
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`);
    } catch { /* logging must never break the bridge */ }
  };

  let base = String(config.url || 'http://127.0.0.1:38410');
  const extraUrls = Array.isArray(config.urls) ? config.urls : [];
  const hubPort = Number(config.hubPort) || 38410;
  const token = readToken(config);
  const member = String(config.member || 'pc');
  const pollMs = Math.max(500, Number(config.pollMs) || DEFAULT_POLL_MS);
  const minGapMs = Math.max(0, Number(config.minGapMs) || DEFAULT_MIN_GAP_MS);
  const onlyAddressed = Boolean(config.onlyWhenAddressed);
  const cursorPath = path.join(dataDir, 'cursor.json');

  let cursor = 0;
  try {
    cursor = Number(JSON.parse(fs.readFileSync(cursorPath, 'utf8')).cursor) || 0;
  } catch { /* first run */ }
  const saveCursor = () => {
    try {
      fs.writeFileSync(cursorPath, JSON.stringify({ cursor, at: new Date().toISOString() }));
    } catch (error) {
      log(`cursor save failed: ${error.message}`);
    }
  };

  log(`apply() url=${base} member=${member} cursor=${cursor} pollMs=${pollMs}`);

  // A fresh install must not replay the room's history into the session: the
  // human already read those lines in the UI. Start where the log ends unless
  // the deployment explicitly asks for a backfill.
  const ready = (async () => {
    // The hub lives at a DHCP address; find the one that actually answers
    // before we decide where the log currently ends.
    try {
      const hit = await resolveHub({
        configured: base,
        candidates: extraUrls,
        token,
        dataDir,
        port: hubPort,
        log,
      });
      if (hit && hit.url !== base) {
        log(`hub resolved: ${hit.url} (via ${hit.via})`);
        base = hit.url;
      }
    } catch (error) {
      log(`hub discovery failed: ${error.message}`);
    }
    if (cursor > 0 || config.backfill === true) return;
    try {
      const res = await fetch(`${base}/health`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(5000),
      });
      const body = await res.json();
      cursor = Number(body.seq) || 0;
      saveCursor();
      log(`initialised cursor at current seq=${cursor} (no backlog replay)`);
    } catch (error) {
      log(`cursor init failed: ${error.message}`);
    }
  })();

  let timer = null;
  let stopped = false;
  let lastInjectAt = 0;
  let injecting = false;

  // Hot reloads (reinstall, disable/enable) can mount this plugin twice; two
  // live instances would double-post and fight over the cursor. Keep one per
  // member (the hub URL may legitimately change under us, so it is not part of
  // the key) and shut the older one down.
  const stateKey = Symbol.for(`dsh-room-bridge:${member}`);
  const stopThis = () => {
    stopped = true;
    if (timer) clearInterval(timer);
    saveCursor();
    log('stopped');
  };
  const previousStop = globalThis[stateKey];
  if (typeof previousStop === 'function') {
    try {
      previousStop();
      log('closed previous bridge instance for the same hub');
    } catch (error) {
      log(`closing previous instance failed: ${error.message}`);
    }
  }
  globalThis[stateKey] = stopThis;

  let lastMissingLogAt = 0;
  const injectBatch = async (events) => {
    let agent = cachedAgent && cachedAgent.session?.id === (config.sessionId || '').trim() ? cachedAgent : null;
    if (!agent) agent = liveAgent(ctx, config, log);
    if (!agent && (config.sessionId || '').trim()) {
      // A pinned session can be momentarily missing while the app restores it.
      await new Promise((resolve) => setTimeout(resolve, 500));
      agent = liveAgent(ctx, config, log);
      // Option B: keep one dedicated conversation alive for the room, so a
      // wake-up after an app restart never lands in somebody else's session.
      if (!agent) agent = await ensureRoomAgent(ctx, config, log);
    }
    if (!agent) {
      // Keep this quiet-ish: one line a minute is enough to explain a stall.
      const now = Date.now();
      if (now - lastMissingLogAt > 60000) {
        lastMissingLogAt = now;
        const pinned = (config.sessionId || '').trim();
        log(
          pinned
            ? `inject waiting: pinned session ${pinned} is not open (open it once; the bridge will then keep using it)`
            : 'inject skipped: no live human session',
        );
      }
      return false;
    }
    const now = Date.now();
    if (now - lastInjectAt < minGapMs) {
      log(`inject deferred: gap ${now - lastInjectAt}ms < ${minGapMs}ms`);
      return false;
    }
    const lines = events.slice(0, MAX_BATCH).map((m) => {
      const base = `${m.from} (seq ${m.seq}, msg ${m.msg}): ${m.text}`;
      if (!Array.isArray(m.files) || !m.files.length) return base;
      const pics = m.files
        .map((f) => `    [图片] ${f.name} · ${f.mime} · ${f.file} · sha256:${String(f.sha256 || '').slice(0, 12)}`)
        .join('\n');
      return `${base}\n${pics}`;
    });
    const hasPics = events.slice(0, MAX_BATCH).some((m) => Array.isArray(m.files) && m.files.length);
    const sessionLabel = (config.sessionId || '').trim() || (agent.session?.id ?? agent.id ?? '?');
    const text = [
      `[room ${member} · session ${sessionLabel}] 群里来了新消息，需要你接话：`,
      '',
      ...lines,
      '',
      hasPics
        ? '带 [图片] 的可以先 room_fetch({file:"<file 名字>"}) 下载，再用 read_image 看，然后 room_say 回话。'
        : '',
      hasPics ? '回复照旧：room_say({text, reply:"<msg>"})。' : '直接调用 room_say 把回复发到群里：room 用房间名，reply 填上面那条消息的 msg。不要只在会话里解释。',
    ].filter((l) => l !== '').join('\n');
    const message = await buildUserMessage(text, log);
    try {
      agent.followup(message);
      lastInjectAt = Date.now();
      log(`injected ${Math.min(events.length, MAX_BATCH)} message(s) into ${agent.session?.id ?? agent.id ?? '?'}`);
      return true;
    } catch (error) {
      log(`inject failed: ${error.message}`);
      return false;
    }
  };

  let failures = 0;
  let rediscovering = false;
  let lastSweepAt = 0;

  // The hub may have moved (new Wi-Fi, new DHCP lease). One failed poll is
  // noise; two in a row is a real "I cannot reach it" and worth a sweep — but
  // no more than one sweep a minute, or a flapping link would turn into a
  // socket storm (that is exactly how we exhausted the phone's descriptors).
  const rediscover = async () => {
    if (rediscovering) return;
    if (Date.now() - lastSweepAt < 60_000) return;
    rediscovering = true;
    lastSweepAt = Date.now();
    try {
      const hit = await resolveHub({
        configured: base,
        candidates: extraUrls,
        token,
        dataDir,
        port: hubPort,
        log,
        checkMemo: false,
      });
      if (hit) {
        base = hit.url;
        log(`hub re-resolved: ${hit.url} (via ${hit.via})`);
      } else {
        log('hub re-resolve failed: nothing answered');
      }
    } catch (error) {
      log(`hub re-resolve failed: ${error.message}`);
    } finally {
      rediscovering = false;
    }
  };

  const tick = async () => {
    if (stopped || injecting) return;
    injecting = true;
    try {
      await ready;
      const body = await askNext(base, token, member, cursor, log);
      failures = 0;
      const next = Number(body.cursor) || cursor;
      if (next <= cursor) {
        cursor = Math.max(cursor, Number(body.seq) || cursor);
        saveCursor();
        return;
      }
      const events = [];
      // /next returns one candidate; walk forward to collect a short burst.
      let probe = cursor;
      for (let i = 0; i < MAX_BATCH; i++) {
        const step = i === 0 ? body : await askNext(base, token, member, probe, log);
        if (!step || !step.speak || !step.message) {
          probe = Number(step?.cursor) || probe;
          break;
        }
        if (onlyAddressed && !(step.message.to || []).includes(member)) {
          probe = step.message.seq;
          continue;
        }
        if (step.needClaim) {
          const won = await claim(base, token, member, step.message.seq, log);
          if (!won) {
            probe = step.message.seq;
            continue;
          }
        }
        events.push(step.message);
        probe = step.message.seq;
      }
      if (events.length) {
        const ok = await injectBatch(events);
        if (!ok) return; // retry the same window next tick
      }
      cursor = Math.max(cursor, probe);
      saveCursor();
    } catch (error) {
      failures += 1;
      log(`tick failed (${failures}): ${error.message}`);
      if (failures >= 2) void rediscover();
    } finally {
      injecting = false;
    }
  };

  timer = setInterval(() => { void tick(); }, pollMs);
  if (typeof timer.unref === 'function') timer.unref();
  void tick();

  ctx.on('dispose', () => {
    stopThis();
    if (globalThis[stateKey] === stopThis) delete globalThis[stateKey];
    log('disposed');
  });
}