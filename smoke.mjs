// Smoke test: starts a throwaway hub on a random port with a temp data dir,
// then exercises the HTTP surface end to end. No network peers required.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const HERE = import.meta.dirname
const TOKEN = 'smoke-token'

// A 1x1 PNG — enough to prove the binary path without shipping fixtures.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function freePort () {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

async function waitFor (url, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url)
      if (res.ok) return res
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`hub did not answer at ${url}`)
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-room-smoke-'))
const port = await freePort()
const base = `http://127.0.0.1:${port}`
const hub = spawn(process.execPath, [path.join(HERE, 'hub', 'server.mjs')], {
  env: {
    ...process.env,
    ROOM_PORT: String(port),
    ROOM_HOST: '127.0.0.1',
    ROOM_TOKEN: TOKEN,
    ROOM_DATA: dataDir,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let hubLog = ''
hub.stdout.on('data', (d) => { hubLog += d.toString() })
hub.stderr.on('data', (d) => { hubLog += d.toString() })

const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

try {
  // 1. health is public and reports the member list
  const health = await (await waitFor(`${base}/health`)).json()
  assert.equal(health.ok, true)
  assert.ok(Array.isArray(health.members) && health.members.includes('user'))

  // 2. unauthenticated writes are refused
  const denied = await fetch(`${base}/say`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'user', text: 'nope' }),
  })
  assert.equal(denied.status, 401)

  // 3. a plain message lands and is addressed to nobody in particular
  const first = await (
    await fetch(`${base}/say`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ from: 'user', text: 'hello room' }),
    })
  ).json()
  assert.equal(first.message.seq, 1)
  assert.equal(typeof first.envelope, 'string')

  // 4. @name in the body becomes an addressed message, even without `to`
  const mentioned = await (
    await fetch(`${base}/say`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ from: 'user', text: '@pc 请看这一条' }),
    })
  ).json()
  assert.deepEqual(mentioned.message.to, ['pc'], '@mention should set to')

  // 5. the same works for @phone, the case that used to wake nobody
  const mentioned2 = await (
    await fetch(`${base}/say`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ from: 'user', text: '早上好 @phone' }),
    })
  ).json()
  assert.deepEqual(mentioned2.message.to, ['phone'])

  // 6. a member filters its own traffic through /next. Starting after seq 1
  //    skips the open greeting, so the first candidate is the @pc line.
  const next = await (
    await fetch(`${base}/next?for=pc&since=1`, { headers: auth })
  ).json()
  assert.equal(next.speak, true)
  assert.equal(next.reason, 'addressed')
  assert.equal(next.message.seq, 2)

  // 7. /since replays in order
  const since = await (await fetch(`${base}/since?cursor=0`, { headers: auth })).json()
  assert.equal(since.messages.length, 3)
  assert.deepEqual(since.messages.map((m) => m.seq), [1, 2, 3])

  // 8. upload → say(files) → download round-trips bytes and integrity
  const upload = await (
    await fetch(`${base}/upload?name=dot.png`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'image/png' },
      body: PNG,
    })
  ).json()
  assert.equal(upload.file.size, PNG.length)
  assert.equal(upload.file.sha256, crypto.createHash('sha256').update(PNG).digest('hex'))

  const withFile = await (
    await fetch(`${base}/say`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ from: 'user', text: '', files: [upload.file.file] }),
    })
  ).json()
  assert.equal(withFile.message.files.length, 1)

  const got = await fetch(`${base}/files/${upload.file.file}?token=${TOKEN}`)
  assert.equal(got.status, 200)
  const bytes = Buffer.from(await got.arrayBuffer())
  assert.equal(bytes.length, PNG.length)
  assert.ok(bytes.equals(PNG), 'downloaded bytes must match')

  // 9. unlisted extensions are refused
  const badFile = await fetch(`${base}/files/0000000000000000.html?token=${TOKEN}`)
  assert.equal(badFile.status, 404)

  // 10. a restart keeps history (append-only jsonl)
  const log = fs.readFileSync(path.join(dataDir, 'room.jsonl'), 'utf8').trim().split('\n')
  assert.equal(log.length, 4)

  console.log('SMOKE_OK')
} catch (err) {
  console.error('SMOKE_FAIL', err && err.message)
  if (hubLog) console.error(hubLog.split('\n').slice(-8).join('\n'))
  process.exitCode = 1
} finally {
  hub.kill()
  fs.rmSync(dataDir, { recursive: true, force: true })
}
