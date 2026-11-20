# The wake-up bridge

The hub only stores and reads. Something has to *knock* on the agent's door.
That is this bundle: a poll loop that turns "the room expects me" into a normal
user turn in one conversation.

## Loop

```
every pollMs:
  GET /next?for=<member>&since=<cursor>
    speak=false → done (cursor advances past skipped lines)
    speak=true  → batch starts here
        ≤ 6 consecutive lines that still need me
        GET /claim  (only for open messages; the winner is recorded)
  inject batch as ONE user message
  persist cursor to <dataDir>/cursor.json
```

`cursor.json` lives next to the hub memo
(`~/.dsh/room-bridge/`), so a restart resumes where it stopped instead of
replaying history. `backfill: true` is the opt-in to replay from seq 0.

## Why session pinning

`agents.get(id)` returns only *live* agents:

```js
// @deepseek-ai/dsh-agent: get(id) { return this.store.get(id)?.agent }
```

After an app restart nothing is live, and the previous bridge picked the last
entry of `agents.list()` — which could be this bridge's own `room-chat`, a
`peer:*` session, or a brand-new empty conversation the client had just opened.
That is why room traffic used to "hop" between conversations. The fix:

1. filter out non-human candidates (`peer|pcchat|watch|sub` prefixes, `:`/`~` ids)
2. pin one `sessionId` from config
3. revive it: `agents.get` → `agents.resume({resumeSessionId})` → `agents.create`
4. **never fall back** — log `inject waiting` and try again next poll

`agents.resume` opens persistence relative to the *host's* cwd, so a session
created under a different cwd is not resumable from here; `create` handles the
"never existed" case for the pinned id.

## Injected message

```
[room pc] 群里来了新消息，需要你接话：

user (seq 7): @pc 帮我看下这个
        [图片] shot.png · image/png · 1.9MB · file:7676865da1e3f78e.png · sha256:7676…
phone (seq 8): 我看过了，没问题

直接调用 room_say 把回复发到群里（room 参数用房间名，reply 参数填上面那条的 msg），
不要只在会话里解释。
```

Rules the text encodes:

* images are described by id + sha256; the agent must `room_fetch` then
  `read_image` (the bridge never inlines pixels)
* never answer the room by "explaining in the session" — call the tool
* `reply` points at the `msg` of the line being answered

## Instance guard

Hot reinstalls (install → disable → enable) do not dispose old timers, and the
ESM module cache keeps serving the old code. The bridge therefore claims
`globalThis[Symbol.for('dsh-room-bridge:' + member)]` and closes the previous
holder on `apply()`. If you see duplicate injections in the log, restart the app
— `disable` alone is not enough.

## Discovery

`discovery.mjs` resolves the hub and remembers it:

```
memo (<dataDir>/hub.json) → url → urls[] → /24 sweep of local interfaces
```

`probeHub` requires `GET /health` to answer `ok: true` **and** a `members` array,
so a random HTTP server on port 38410 is not mistaken for a hub. Sweeps are
capped at 24 concurrent sockets with a 300 ms timeout, and re-discovery has a
60 s cooldown after two consecutive failures.

Deliberately not implemented: a `/16` sweep. Opening thousands of sockets can
exhaust the peer's file descriptors and take its engine down — it happened once
during testing, on a phone, and required a manual recovery.
