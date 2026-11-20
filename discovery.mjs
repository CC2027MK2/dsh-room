// discovery.mjs 閳?find the room hub again when the configured URL goes stale.
//
// A hub address is a DHCP address: the moment the desktop joins another Wi-Fi
// (or the phone joins the office LAN) the hard-coded URL is wrong and the bridge
// goes silent. Everything here has one job: given the URL we were told about,
// come back with *a* URL that answers /health with this hub's token.
//
// Order of preference:
//   1. the URL we already know (config or the memo written last time)
//   2. any extra candidates from config
//   3. a /24 sweep of the local interfaces on the hub port
//
// The result is memoised in <dataDir>/hub.json so a restart does not have to
// sweep again.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_PORT = 38410;
const PROBE_TIMEOUT_MS = 1200;
const SCAN_TIMEOUT_MS = 300;
const SCAN_CONCURRENCY = 24;

const trim = (url) => String(url || '').replace(/\/+$/, '');
const MS = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

export async function probeHub (url, token, timeoutMs = PROBE_TIMEOUT_MS) {
  const target = trim(url);
  if (!target) return null;
  try {
    const res = await fetch(`${target}/health`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = await res.json();
    // The hub is the only thing on this port that answers with ok+seq.
    if (!body || body.ok !== true || !Array.isArray(body.members)) return null;
    return { url: target, seq: Number(body.seq) || 0, members: body.members };
  } catch {
    return null;
  }
}

function localSubnets (port) {
  const out = new Set();
  const interfaces = os.networkInterfaces();
  for (const list of Object.values(interfaces)) {
    for (const entry of list || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const parts = entry.address.split('.');
      if (parts.length !== 4) continue;
      out.add(parts.slice(0, 3).join('.'));
    }
  }
  return [...out];
}

async function sweep (prefix, token, port, log) {
  const hosts = [];
  for (let i = 1; i <= 254; i++) hosts.push(i);
  let found = null;
  let index = 0;

  const worker = async () => {
    while (!found) {
      const i = index++;
      if (i >= hosts.length) return;
      const url = `http://${prefix}.${hosts[i]}:${port}`;
      const hit = await probeHub(url, token, SCAN_TIMEOUT_MS);
      if (hit && !found) {
        found = hit;
        log(`discovery: found hub at ${hit.url}`);
      }
    }
  };

  await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
  return found;
}

export async function discoverHub ({ token, port = DEFAULT_PORT, log = () => {} } = {}) {
  const prefixes = localSubnets();
  log(`discovery: sweeping ${prefixes.map((p) => `${p}.0/24`).join(', ') || '(no IPv4 interface)'}:${port}`);
  for (const prefix of prefixes) {
    const hit = await sweep(prefix, token, port, log);
    if (hit) return hit;
  }
  // Deliberately no /16 sweep: thousands of short-lived sockets exhausted the
  // phone's file descriptors and took the whole engine down. A hub on another
  // /24 has to be pinned in config (url or candidates) 閳?that is the honest
  // boundary of "same LAN" discovery.
  return null;
}

function readMemo (dataDir) {
  try {
    const memo = JSON.parse(fs.readFileSync(path.join(dataDir, 'hub.json'), 'utf8'));
    return memo && typeof memo.url === 'string' ? memo : null;
  } catch {
    return null;
  }
}

function writeMemo (dataDir, hit) {
  try {
    fs.writeFileSync(path.join(dataDir, 'hub.json'), JSON.stringify({ url: hit.url, seq: hit.seq, at: new Date().toISOString() }));
  } catch { /* a missing memo only costs one sweep next time */ }
}

/**
 * Resolve the hub. Returns { url, seq, members, via } or null.
 * `via` is 'memo' | 'configured' | 'candidate' | 'scan' 閳?handy in the log.
 */
export async function resolveHub ({
  configured = '',
  candidates = [],
  token = '',
  dataDir = '',
  port = DEFAULT_PORT,
  log = () => {},
  checkMemo = true,
} = {}) {
  const tried = new Set();

  const attempt = async (url, via) => {
    const clean = trim(url);
    if (!clean || tried.has(clean)) return null;
    tried.add(clean);
    const hit = await probeHub(clean, token);
    return hit ? { ...hit, via } : null;
  };

  if (checkMemo && dataDir) {
    const memo = readMemo(dataDir);
    if (memo) {
      const hit = await attempt(memo.url, 'memo');
      if (hit) return hit;
      log(`discovery: memo ${trim(memo.url)} is stale`);
    }
  }

  const direct = await attempt(configured, 'configured');
  if (direct) {
    if (dataDir) writeMemo(dataDir, direct);
    return direct;
  }
  if (configured) log(`discovery: configured ${trim(configured)} did not answer`);

  for (const candidate of candidates) {
    const hit = await attempt(candidate, 'candidate');
    if (hit) {
      if (dataDir) writeMemo(dataDir, hit);
      return hit;
    }
  }

  const scanned = await discoverHub({ token, port, log });
  if (scanned) {
    if (dataDir) writeMemo(dataDir, scanned);
    return { ...scanned, via: 'scan' };
  }

  log('discovery: no hub answered');
  return null;
}
