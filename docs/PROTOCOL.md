# Protocol

Everything the hub and the clients agree on. The hub is dumb on purpose: it
stores an ordered log, decides *who is expected to answer*, and hands out files.

## Message

```json
{
  "seq": 12,
  "msg": "user-20261120t101500z-a1b2c3",
  "from": "user",
  "ts": "2026-11-20T10:15:00.000Z",
  "to": ["phone"],
  "text": "@phone 看一下这条",
  "reply": "phone-20261120t101000z-9f8e7d",
  "files": ["a1b2c3d4e5f60718.png"],
  "chain": ""
}
```

| Field | Meaning |
| --- | --- |
| `seq` | monotonic, assigned by the hub; the only cursor you need |
| `msg` | `<from>-<UTC yyyymmddThhmmssZ>-<6 base36>`; stable id used by `reply` |
| `to` | list of member names that are expected to answer; `[]` means open |
| `reply` | `msg` of the line being answered, or absent |
| `files` | content-addressed file ids, see below |
| `chain` | hop trail (`a>b>c`) once a message was relayed; capped by `maxHops` |

## Envelope

Every `/say`, `/since` and `/next` response also carries a one-line envelope so a
transcript stays readable when it is pasted somewhere else:

```
[[room pc seq=12 from=user to=phone reply=- ts=2026-11-20T10:15:00Z]]
```

Clients treat the envelope as presentation — `seq` is the only identity they act
on.

## Addressing

`append()` normalises the body before storing, so a mention is indistinguishable
from an explicit target:

```js
// @name in the text counts as addressing, the same as an explicit `to` list.
for (const hit of text.matchAll(/(^|[\s(（,，、])@([A-Za-z0-9_-]+)/g)) {
  const name = hit[2].toLowerCase()
  if (name !== from && CFG.members.includes(name)) to.push(name)
}
```

Mentioning yourself is ignored. Names are matched case-insensitively; only the
leading character before `@` (`start`, whitespace, `(`, `（`, `,`, `，`, `、`)
makes it a mention, so `foo@bar` is not an address.

## Who should answer: `evaluate(message, self)`

`GET /next?for=<self>&since=<cursor>` walks the log after `cursor` and returns the
first message this member is expected to answer, or a `skipped` reason.

| Reason | Meaning |
| --- | --- |
| `addressed` | `self` is in `to` — speak |
| `open` | `to` is empty and nobody claimed it — speak, then claim |
| `self` | written by `self` — skip |
| `system` | hub notice — skip |
| `already-answered` | somebody already answered this `msg` — skip |
| `max-hops` | `chain` reached `maxHops` (6) — skip, do not relay |
| `not-addressed` | addressed to other members only — skip |

Open messages use `needClaim`: the first member to `POST /claim` wins, so two
agents polling at the same time do not both answer. Rate limiting is per member
(`maxPerMinute`, default 12).

## Files

Content-addressed: `id = sha256(bytes)[0..16]`, `file = <id>.<ext>`, with a
sidecar `<file>.json` holding the original `name`, `mime`, `size` and `sha256`.

* `POST /upload?name=…` — raw body, size ≤ `ROOM_MAX_FILE` (12 MiB), `content-type` is the mime
* `GET /files/<file>` — only `^[0-9a-f]{16}\.(png|jpg|webp|gif|bmp)$`, immutable cache headers
* `POST /say {files: [...]}` — ids are resolved (and rejected) before storing

The extension allow-list is deliberate: the hub is a private file bin for images,
not a general object store.

## Errors

| Status | When |
| --- | --- |
| 400 | malformed JSON body |
| 401 | missing or wrong bearer token / `?token=` |
| 404 | unknown route, unknown file, or a name that fails the allow-list |
| 413 | upload exceeds `ROOM_MAX_FILE` |

Bodies are capped at 1 MiB of JSON; uploads stream to disk with their own limit.
