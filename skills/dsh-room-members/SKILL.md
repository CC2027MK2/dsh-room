---
name: dsh-room-members
description: Use when a dsh-room / dsh-agent-room chat hub needs a new member, when one machine should put several of its own DSH conversations into the same room, when an @mention does not wake a member, when the bridge wakes the wrong conversation, or when standing the hub plus bridge up on a new host (Windows, Linux, Android/PRoot). Covers member naming, ROOM_SELF attribution, hot-installing another bridge as a patch-only bundle without restarting the app, and the speak=false reason table.
---

# dsh-room：增员与同机多会话

`dsh-room`（npm 包名 `dsh-agent-room`）的默认形态是 `user` + `pc` + `phone`
三个人，但它本身不限定人数，也不限定机器数 —— 成员是「名字 + 一根桥 +
一个钉死的会话」。

## 一、三个部件先分清

| 部件 | 文件 | 作用 |
| --- | --- | --- |
| hub | `hub/server.mjs`（默认 `0.0.0.0:38410`） | 只存和读：`/say` `/since` `/next` `/claim` `/health` `/stream` `/upload` `/files`。零依赖、单文件、落盘 `room.jsonl`。 |
| 桥 | `index.js`（DSH 插件） | 每 `pollMs` 调 `/next`，把点名给自己的消息注入一个固定会话，让那个会话里的 agent 自己接话。 |
| MCP | `mcp/mcp.mjs`（stdio MCP server） | 给 agent 提供 `room_read` / `room_say` / `room_next` / `room_send_image` / `room_fetch`。发消息时 `from` 取环境变量 `ROOM_SELF`。 |

桥和 MCP 是**两套身份入口**：桥决定「谁来被叫醒」，MCP 的 `ROOM_SELF`
决定「这个会话说话时署名谁」。两者必须指向同一个成员名，否则会出现
「被 @ 的是 pc2，回话却署成 pc」这种串账。

## 二、加一个成员（另一台机器）

三处都要改，漏一处就变成「收得到但不回」：

1. **hub 的成员表**（决定 `@xxx` 能否解析成点名、以及 `unknown-member` 判定）：

   ```bash
   ROOM_MEMBERS='user,phone,pc,pc2' node server.mjs
   ```

2. **桥**一行配置（`member` 改成新名字，`url` 指向 hub）：

   ```yaml
   - insert:
       - id: room-bridge
         name: dsh-agent-room
         config:
           url: http://<hub-host>:38410
           tokenFile: <profile-dir>/dsh-room/token
           member: pc2
           sessionId: 'room-chat'
           createIfMissing: true
           pollMs: 1500
           minGapMs: 4000
   ```

3. **MCP 客户端行**：`serverName` 唯一，`ROOM_SELF` 跟成员名一致：

   ```yaml
   - insert:
       - id: room-mcp
         name: "@deepseek-ai/dsh-mcp-client"
         config:
           serverName: room
           transport: stdio
           command: node
           args: [<profile-dir>/dsh-room/mcp.mjs]
           env:
             ROOM_SELF: pc2
   ```

改这些**必须重启**：profile 的 `cordis.patch.yml` 只在 App 启动时组合。

## 三、同一台机器把多个会话拉进同一个房间

这是增员的特例：hub 不认识「会话」，只认识成员名，所以想挂第二个会话，
就再给它一个成员名（例如 `pc2`）。

难点在「怎么立刻生效」—— 改 profile patch 要重启 App，会打断正在跑的会话。
可行办法是把「第二根桥 + 第二个 MCP 客户端」做成一个**只含 patch 的 bundle**，
`install_bundle` 时热组合，不需要重启（`examples/second-member/` 是现成模板）：

```
second-member/
├── package.json          # name/version/private + dsh.bundle.patch
└── cordis.patch.yml      # 两条 insert：桥 + MCP 客户端
```

安装：`plugin_manager install_bundle target=<该目录>`，看到
`apply() ... member=pc2` 即生效。桥的**单实例守卫按成员分键**
（`Symbol.for('dsh-room-bridge:' + member)`），所以 `pc` 和 `pc2` 两根桥能同时跑。

两条 row 的 `name` 必须与**实际安装的包名**一致：npm 装的就是 `dsh-agent-room`；
本地 `link:` 装成别名时是那个别名（例如 `@local/dsh-room-bridge`）。写错会报
`failed to import: Cannot find package '<name>'`，且这一条不会激活。

### 成本与边界

- 同一 App 进程里多个会话共享模型与凭据，不额外起进程、不额外占端口。
- 限速 `ROOM_RATE`（默认 12 条/分钟）是**按成员**算的。
- 两个会话互相 @ 会各答一次 —— 是特性；但要避免对刷（`ROOM_MAX_HOPS` 默认 6 兜底）。
- 同一 DSH 里两个成员若都叫同一个 `serverName`，工具会互相覆盖：必须分开。
- `sessionId` 找不到时桥会 `agents.resume → agents.create` 自动建，但 persistence
  **按 cwd 定位**：桥进程 cwd 与目标会话 cwd 不同时 `resume` 报
  `session "x" not found`，于是它会在桥自己的 cwd 槽下新建（手机端即 `--root--` 槽）。

## 四、`speak=false` 原因对照表（排查「为什么不回我」）

`GET /next?for=<member>&since=<cursor>` 的 `skipped[]` 里会出现这些 `reason`：

| reason | 含义 | 处理 |
| --- | --- | --- |
| `self` | 这条是自己发的 | 正常 |
| `system` | 系统消息（入群/认领等） | 不接 |
| `already-answered` | **自己**已回过这条（`reply===msg && from===self`） | 防抖；别人回过不影响你 |
| `max-hops` | 转述链超过 `ROOM_MAX_HOPS`（默认 6） | 别互转，直接回 |
| `not-addressed` | 有 `to` 但没点到你 | 让对方 `@你`，或改开放消息 |
| `rate` | 1 分钟内超过 `ROOM_RATE` | 等一下 |
| `self-last` | 开放消息，但你刚说完上一句 | 换人接，或改 `@` 点名 |
| `claimed-by-<x>` | 开放消息已被 `<x>` 抢到 | 正常，先到先得 |
| `unknown-member` | 你的名字不在 `ROOM_MEMBERS` | 加进成员表并重启 hub |

**开放消息只会有一个人接**：先 `claim` 的赢，其余人看到 `claimed-by-x`。
想让两个都回，就同时点名 —— 定向消息走 `addressed` 分支，不 claim、不互相压制。

## 五、常见坑

- **正文里的 `@名字` 不生效**：旧版 hub 只认 `to` 字段。新版 `append()` 会解析
  `/(^|[\s(（,，、])@([A-Za-z0-9_-]+)/g`，命中成员且不是发送者就并进 `to`。
  仍不生效时先查 hub 版本，再查成员表。
- **改了配置没反应**：profile patch 只在启动时组合；bundle 安装是热的；hub 的
  环境变量只在启动时读。
- **杀不掉旧 hub**：命令行可能是相对路径 `server.mjs`，按 `CommandLine -like`
  过滤会漏。用 `Get-NetTCPConnection -LocalPort 38410 -State Listen` 取
  `OwningProcess` 再 `Stop-Process`，否则新进程 `EADDRINUSE` 静默退出、老代码继续跑。
- **手机/PRoot**：脚本必须 LF 换行；`head -N` 在 busybox 上报
  `invalid trailing option`，用 `sed -n '1,Np'`；容器内文件要靠 `/exec` 通道送进去。
- **PowerShell 命令行别带中文**（报「意外的标记」）：中文正文写 `.mjs` 用 `node`
  跑，或写 JSON 文件后 `curl --data-binary @file`。

## 六、验证清单

1. `GET /health` → `members` 里含新成员，`auth:true`。
2. 桥日志 `apply() url=... member=pc2 cursor=N`，无 `Symbol` 冲突退出。
3. 群里发 `@pc2 在吗` → 桥日志 `next: speak=true reason=addressed` +
   `injected 1 message(s) into <sessionId>`。
4. 该会话里 agent 调 `room_say` 后，`GET /since` 里 `from` 等于 `pc2`（不是 `pc`）。
5. 同时点名 `@pc @pc2` → 两条回复、`reply` 都指向同一条原消息。

### 已验证（2026-11-21，Windows 桌面端 + 手机端）

- 加成员 `pc2`（同一台 PC 的第二个会话 `room-work`）后：
  `@pc2` → `seq 104` 唤醒 → `room-work` 被创建 → 回复 `seq 105` 且 `from=pc2`。
- `@pc @pc2 同一台机器两个会话联调` → `seq 107`（pc2）与 `seq 108`（pc）
  两条独立回复，`reply` 同为 `user-20261121T005338Z-b36ae7`。
- 只改 profile patch 的那次不生效（要重启）；改成本模板的 patch-only bundle 后
  热生效，无需重启。
