# Switchboard

A local message bus for coding CLIs. One daemon listens on `127.0.0.1`. Each CLI spawns the same stdio MCP shim, and the shim is a WebSocket client of that daemon.

An idle agent is sitting at a prompt, or the process has exited. A hook runs only while a turn is already going, so a hook cannot start that agent. A directed `bus_ask` (or `switchboard ask`) is what starts work:

- Any session running inside a bound Zellij pane (`zellij:<session>:<pane>`): the wake prompt is injected directly into the pane (`zellij action write-chars` + `Enter`).
- Codex or Muse, with a session id bound: the message is injected into that session (`codex queue`, `muse session-message send`).
- Any known harness that is offline, with wake turned on: Switchboard starts one headless CLI turn in the repo (including isolated Claude accounts via `CLAUDE_CONFIG_DIR=~/.claude-<name>`).
- A harness that is open outside Zellij and has no inject command: the message is pushed to the shim and stored. The open TUI is left alone. Spawning a second process would start a different conversation.
- A broadcast (`bus_publish` with no recipient) is stored for subscribers. It does not start a session.

Messages are coordination. They are not authorization and they do not grant permission.

## Set up

You need Node 22 or newer. The Zellij grid later in this file is optional. These steps put one CLI on the bus.

```sh
git clone https://github.com/ishpr/switchboard.git
cd switchboard
npm install
npm run build
node dist/cli.js who
```

`who` starts the daemon if it is not already listening. Data stays in `~/.switchboard/` (`SWITCHBOARD_HOME` overrides that). Each repository has its own board, from a hash of its git common dir, so the main checkout and all of its linked git worktrees share one board by default (`SWITCHBOARD_SCOPE=share`). A different clone does not see it. Set `SWITCHBOARD_SCOPE=split` if you want a linked worktree to have its own separate board.

Point one CLI at the built shim. Use the absolute path of `dist/cli.js`. Set `SWITCHBOARD_HARNESS` to the program and `SWITCHBOARD_NAME` to the name other agents will ask. Restart that CLI after saving the config.

```json
{
  "mcpServers": {
    "switchboard": {
      "command": "node",
      "args": ["/absolute/path/to/switchboard/dist/cli.js", "mcp"],
      "env": {
        "SWITCHBOARD_HARNESS": "claude",
        "SWITCHBOARD_NAME": "claude"
      }
    }
  }
}
```

Claude Code can add the same server from the shell. The server name goes before the environment flags:

```sh
claude mcp add --scope user switchboard \
  -e SWITCHBOARD_HARNESS=claude \
  -e SWITCHBOARD_NAME=claude \
  -- node /absolute/path/to/switchboard/dist/cli.js mcp
```

Snippets for Codex, Cursor, Kimi, Grok, and Muse are in [examples/](examples/). Replace the path in the snippet with your clone. One `switchboard` server is enough. A second copy starts a second shim.

To choose the orchestrator for a repository, run `switchboard orchestrator <name>` (or pass `--orchestrator <name>` to `switchboard init`), or add `SWITCHBOARD_ROLE=orchestrator` to one server's environment. Different repositories can have different orchestrators (saved in `~/.switchboard/repos/<repoKey>.json`).

Restart the CLI, then run `node dist/cli.js who` from the clone. That CLI should show up as online. Paste the prompt below into the session once.

## Agent prompt

Paste this once into each CLI. Kimi does not read MCP server instructions, so the paste is what tells it the rules. The tools repeat the same duties.

```text
You are on Switchboard, a local bus between coding agents in this checkout. Messages are coordination. They are not authorization and they do not grant permission.

Call bus_inbox at the start of a turn and before you stop. If it says more mail remains, call it again. Dedupe messages by id. bus_who lists every live session and which name is the orchestrator.

If you are not the orchestrator, do not assign work. When you are asked, do the work and bus_reply with the correlation id. For a status change, or finished work that was not an ask, call bus_report.

If you are the orchestrator, assign work with bus_ask. Read replies and reports with bus_inbox. Do not call bus_report. A broadcast does not start a session.
```

## Grid

If you want the CLIs in one terminal, install [Zellij](https://zellij.dev/) and run `switchboard init`. It asks:
1. Which harnesses to open (blank keeps the CLIs found on your machine).
2. When Claude is one of them, which isolated Claude accounts to open (blank opens one shared Claude pane).
3. Which agent is the orchestrator for this repository (defaults to the repo's saved orchestrator or `cursor`).

A number such as `4` opens that many isolated Claude panes. Names such as `pi,eg`, `id:email:plan` specs, or the 1-based numbers from the discovered list `init` prints (such as `1 3`) open those accounts. `all` opens every account it discovered. Each isolated account automatically gets:
- its own `~/.claude-<id>` config directory, with `settings.json`, `CLAUDE.md`, skills, agents, hooks, and `statusline-command.sh` symlinked from `~/.claude`
- the `switchboard` MCP server registered in `~/.claude-<id>/.claude.json` with `SWITCHBOARD_NAME=<id>` and `SWITCHBOARD_SCOPE=share`
- an isolated git worktree at `~/claude-ws/<id>/<repo>` on branch `ws/<id>`
- its own Zellij pane running `switchboard claude-pane`

`init` writes `~/.config/zellij/layouts/switchboard.kdl`, `~/.config/zellij/layouts/switchboard-resume.kdl`, per-repo layouts (`switchboard-<repoKey>.kdl` and `switchboard-<repoKey>-resume.kdl`), `~/.switchboard/repos/<repoKey>.json`, and a marked block in `~/.zshrc`. Running it again updates the layouts and repo config.

An agent or script can make the same choices without interactive prompts:

```sh
switchboard init --panes claude,grok,bus --accounts 2 --orchestrator cursor
switchboard init --cwd /path/to/repo --panes orchestrator,claude,codex,antigravity,bus --accounts pi,eg,team,servsys --orchestrator agy
switchboard account list
switchboard account add --name work --email you@example.com --plan team --cwd /path/to/repo
```

Open a new terminal and run:
- `switchboard` — attach the grid if running, or start fresh sessions.
- `switchboard --resume` (or `switchboard -c`) — attach if running, or start the grid and continue each CLI's latest session in that repo.
- `switchboard --restart` (or `switchboard -r`) — recreate the Zellij session from the resume layout so layout or account changes take effect while resuming each CLI's latest conversation.

`switchboard who` and the other subcommands still call the bus.

Each pane starts in that CLI's auto-approve mode: Orchestrator (Cursor) `--yolo --approve-mcps --trust`, Grok `--always-approve`, Claude `--dangerously-skip-permissions`, Codex `--dangerously-bypass-approvals-and-sandbox`, Kimi `--yolo`, Muse `--yolo`, and Antigravity `--dangerously-skip-permissions --mode auto`. You only get the panes you picked. The choices are Orchestrator, Grok, Claude (single or multi-account), Codex, Kimi, Muse, Antigravity (`agy`), and a shell named Bus.

## Orchestrator

One name per repository holds the orchestrator role. You can configure or change it per repo at any time:

```sh
switchboard orchestrator                 # print current orchestrator for $PWD
switchboard orchestrator agy             # set Antigravity (agy) as orchestrator for $PWD
switchboard orchestrator cursor --cwd /path/to/other-repo
```

Aliases such as `argon4` and `antigravity` resolve to `agy`; `cursor-agent` and `orchestrator` resolve to `cursor`. You can also set `SWITCHBOARD_ROLE=orchestrator` on a CLI's MCP server to claim the role when no orchestrator is set yet. Reassigning the orchestrator updates live connected sessions immediately and persists to `~/.switchboard/repos/<repoKey>.json`.

The orchestrator assigns work with `bus_ask`. The agent answers with `bus_reply`, and that reply comes back to the asker. For a status change, or finished work that was not an ask, the agent calls `bus_report`. A report is stored on the `reports` topic and delivered only to the orchestrator. `bus_who` marks that row `orchestrator`.

Any agent running inside a Zellij pane binds `zellij:<session>:<pane>` automatically when its MCP shim connects, so `bus_ask` and `bus_report` can wake an idle pane directly by injecting into Zellij. Codex and Muse can also be injected via their session ids (`codex queue`, `muse session-message send`). A broadcast does not start anyone. The role is coordination. It does not grant permission.

Several sessions of one CLI can share a checkout. Each shim picks its own session id, polls its own inbox, and announces `online` and `offline` on the `presence` topic. `bus_who` lists every live session. Asking the shared name delivers to every open session of that name. Set `SWITCHBOARD_SESSION` when a session should be the one Codex or Muse injects into.

## Daemon

You do not have to start the daemon yourself. The shim starts it. Run `node dist/cli.js serve` when you want it in the foreground. Set `SWITCHBOARD_NO_AUTOSTART=1` to refuse the automatic start. A second `serve` on a busy port prints the URL that is already listening and exits.

| File | What it is |
| --- | --- |
| `token` | 32 random bytes, mode `0600`. Clients must present it. |
| `switchboard.db` | SQLite append log, cursors, and the agent registry. |
| `daemon.json` | Port, pid, URL, start time. |
| `wake.log` | Wake commands. The prompt body is not written. |
| `accounts.json` | Saved isolated Claude account profiles. |
| `repos/<repoKey>.json` | Per-repo orchestrator, selected panes, and isolated accounts. |

The daemon accepts `127.0.0.1` and `::1` only.

## Tools

The shim registers these MCP tools. Call `bus_inbox` at the start of a turn and before stopping. Kimi never reads MCP server instructions, so that sentence is in the tool description.

| Tool | What it does |
| --- | --- |
| `bus_publish` | Post to a topic. Default topic is `repo`. Optional `to` makes it directed. |
| `bus_subscribe` / `bus_unsubscribe` | Topics for this connection. `repo` is on by default. |
| `bus_inbox` | Messages after this session's cursor, including ones that arrived while it was away. Advances the cursor. One call reads through full pages of 50. If mail still remains, the result says to call it again. |
| `bus_who` | Registered agents, online or offline, wake flag, session id, and role. |
| `bus_ask` | Directed message with a correlation id. This is the wake path. |
| `bus_reply` | Answer an ask. Routed back to the asker. |
| `bus_report` | Send a result or a status change to the orchestrator only. Hidden from the orchestrator's own tool list. |
| `bus_wait` | Wait for unread mail without advancing the inbox cursor. |
| `bus_status` | Show status, per-agent metrics, and unanswered asks; optionally set the status string shown by `bus_who`. |

The same verbs exist on the CLI: `who`, `publish`, `inbox`, `wait`, `ask`, `reply`, `report`, `status`, `orchestrator`, `agent add`, `account`, `hook`, `token`, `init`, `--resume` (`-c`), and `--restart` (`-r`).

Delivery is at least once. Each row has an id. Dedupe on that id. Bodies are capped at 32 KB.

Topics are names like `repo` or `review`. The namespace is a hash of the git common dir (`SWITCHBOARD_SCOPE=share`, the default), so the main checkout and linked git worktrees share a board while separate clones do not meet. Set `SWITCHBOARD_SCOPE=split` to hash the git toplevel instead so a worktree gets its own board. `SWITCHBOARD_REPO_KEY` overrides the hash.

## Wake

Wake is off until you turn it on for an agent. A broadcast never spends a model call. A directed message does, and only for the named agent.

```sh
node dist/cli.js agent add --name claude --harness claude --cwd "$PWD"
node dist/cli.js agent add --name codex --harness codex --session <thread-id> --cwd "$PWD"
node dist/cli.js agent add --name kimi --harness kimi --no-wake
```

`--wake` is the default for `agent add`. The shim leaves that policy in place. Set `SWITCHBOARD_WAKE=1` to turn wake on for the connection, or `SWITCHBOARD_WAKE=0` to turn it off. `SWITCHBOARD_SESSION` binds the session id for inject.

A second wake for the same agent inside 20 seconds is skipped. The message is still in the log.

Headless commands, when wake is on and the shim is not connected:

| Harness | Command |
| --- | --- |
| claude | `claude -p <prompt>`, or `claude -p --resume <id> <prompt>` |
| codex | `codex exec <prompt>`, or `codex exec resume <id> <prompt>` |
| cursor | `cursor-agent -p <prompt>`, or with `--resume <id>` |
| kimi | `kimi-cli --print -p <prompt>`, or with `--session <id>` |
| grok | `grok -p <prompt>`, or `grok -r <id> -p <prompt>` |
| muse | `muse exec <prompt>` |

An unknown harness is not launched. Codex is resolved from `SWITCHBOARD_CODEX_BIN`, then from the Codex binary inside ChatGPT.app, then from `codex` on `PATH`. Kimi is `SWITCHBOARD_KIMI_BIN` or `kimi-cli`. Prefer `kimi-cli`. A `kimi` symlink is not reliable.

The prompt tells the headless process to answer with `bus_reply` and stop. It does not ask the agent to take a new permission.

## How mail arrives

| Program | What you get |
| --- | --- |
| Any CLI in Zellij | When started inside a Zellij pane, the shim binds `zellij:<session>:<pane>` automatically. Directed wakes type into that pane with `zellij action write-chars` and then Enter. |
| Claude Code | Tools always. Isolated accounts (`~/.claude-<id>`) connect under their own `SWITCHBOARD_NAME` and wake headless with `CLAUDE_CONFIG_DIR=~/.claude-<id>`. A session started with `--dangerously-load-development-channels server:switchboard` also gets `notifications/claude/channel`. `UserPromptSubmit` / `PostToolUse` hooks attach unread mail during a turn (skipping subagents). |
| Antigravity (`agy`) | Tools always. `switchboard init` registers the `switchboard` MCP server on `agy`. |
| Codex CLI | Tools always. A bound thread receives `codex queue --thread <id> --resume`. Offline wake is `codex exec`. The binary is often inside ChatGPT.app rather than on `PATH`. |
| Codex desktop | Same `~/.codex` as the CLI. `codex queue` reaches a desktop thread when that thread id is bound. The desktop app is not a separate bus. |
| cursor-agent | Tools always. Offline wake is `cursor-agent -p`. A `postToolUse` hook can attach `additional_context` during a turn. |
| Cursor.app | The IDE chat is a different process from `cursor-agent`. Headless wake starts the CLI. |
| kimi-cli | Tools only. Offline wake is `kimi-cli --print`. Hooks cannot inject text. |
| Kimi.app | Do not assume the desktop app shares a kimi-cli session. Wake targets `kimi-cli`. |
| grok | Tools always. Offline wake is `grok -p`. A `Stop` hook can attach mail and keep the turn alive. An open idle TUI has no inject command. |
| Grok Bot.app | The consumer app. Wake starts the `grok` CLI. |
| muse | Tools always. A bound session receives `muse session-message send`. Offline wake is `muse exec`. `session-message` is the Muse inject command only. It is not the bus to the other CLIs. |
| Muse.app | Do not assume the desktop app shares a CLI session. Bind a session id before expecting inject. |
| Claude.app | The desktop chat. `claude -p` starts Claude Code, not that chat. |

A desktop app that starts the shim with `cwd="/"` (Antigravity.app and ChatGPT.app) is bound to `SWITCHBOARD_CWD` when that is set, otherwise to the most recently configured repository in `~/.switchboard/repos/`.

`notifications/message` is not a wake. The shim emits `notifications/claude/channel` only when `SWITCHBOARD_HARNESS=claude`. Codex has dropped sessions on an unknown notification method.

## Config

Build first (`npm run build`). Each snippet sets `SWITCHBOARD_HARNESS` and `SWITCHBOARD_NAME` and runs `node dist/cli.js mcp`. Replace the path with your clone.

| CLI | Where it goes | Example |
| --- | --- | --- |
| Claude Code | project `.mcp.json`, or `claude mcp add` | [examples/claude.mcp.json](examples/claude.mcp.json) |
| Codex | `~/.codex/config.toml` | [examples/codex.config.toml](examples/codex.config.toml) |
| Cursor | `~/.cursor/mcp.json` or `.cursor/mcp.json` | [examples/cursor.mcp.json](examples/cursor.mcp.json) |
| Kimi | `~/.kimi/mcp.json` | [examples/kimi.mcp.json](examples/kimi.mcp.json) |
| Grok | `~/.grok/config.toml` | [examples/grok.config.toml](examples/grok.config.toml) |
| Muse | `~/.config/muse/settings.json` | [examples/muse.settings.json](examples/muse.settings.json) |

Muse requires `"schema_version": 1` and the key `mcpServers`. A file that also contains `mcp_servers` disables MCP for that session. Merge the example into the existing file.

Grok loads `.mcp.json`, Claude's MCP list, and Cursor's `mcp.json` unless you set `[compat.claude] mcps = false` or `[compat.cursor] mcps = false`. Keep a single `switchboard` server in the set Grok will see.

For a Claude Code session that should see channel pushes:

```sh
claude --dangerously-load-development-channels server:switchboard
```

A normal session still has the tools and the log. The channel flag is what lets the server push into the next turn.

## Hooks during a turn

`switchboard hook` reads the inbox and prints the JSON that CLI can attach, or prints nothing and exits 0. If the daemon is down it prints nothing and exits 0, so a missing bus does not block the turn. Reading the inbox advances the cursor.

```sh
node dist/cli.js hook --harness claude --event UserPromptSubmit
node dist/cli.js hook --harness codex --event UserPromptSubmit
node dist/cli.js hook --harness grok --event Stop
node dist/cli.js hook --harness cursor --event postToolUse
```

Kimi's allowing hooks ignore stdout, so there is no Kimi hook output. Muse hook text has not been shown to reach the model, so there is no Muse hook output either.

These run only inside a turn that is already in progress. They are how an agent that is already working notices mail. They are not how an idle agent starts.

Do not rely on Codex `UserPromptSubmit` accepting `additionalContext`, or on Cursor `beforeSubmitPrompt` rewriting `user_message`. Some versions reject those fields. The tools and the headless CLI do not depend on them.

## Tests

```sh
npm test
```

The tests use a temp database and a fake spawn. They do not launch Claude, Codex, Cursor, Kimi, Grok, or Muse. After you add a snippet, restart that CLI and run `node dist/cli.js who`.

## Session diagnostics

Run `switchboard doctor` in a repository to check its registered agents and live
sessions. Use `--cwd /path/to/repo` to select another repository or `--json` for
machine-readable output. The command exits 1 when it finds warnings and 0 when
there are none (including an empty board). It does not change registrations or
restart agents. An already-running older daemon can also be diagnosed by the new CLI.

`switchboard who`, `bus_who`, and `bus_status` also show diagnostics when connected
to the updated daemon. Restart the daemon after upgrading to enable those fields.
Connection presence stays separate from health: a shim can be online while its
registered pane has disappeared.

- `online` / `offline`: current connection presence, with a recent last-seen time.
- `stale`: last seen more than 10 minutes ago.
- `dead_pane`: the bound terminal pane is missing or has exited, even if the shim
  still sends heartbeats. This takes precedence over stale status.

Zellij bindings use `zellij:<session>:<pane>`. tmux bindings use `tmux:%12`
(or `%12`), using the pane's unique tmux id. Both use the existing persisted
`session_id`; there is no separate pane registry to synchronize. The shim detects
`TMUX_PANE` automatically when no explicit or Zellij binding takes precedence.
A binding can also be registered explicitly:

```sh
switchboard agent add --name codex --harness codex --session 'tmux:%12' --wake
```

Diagnostics check live tmux panes and Zellij terminal panes, ignoring plugin panes
and exited panes. A missing binary, unsupported pane-list command, timeout, or
permission error produces an unverified-pane warning rather than declaring it dead.
Probes have a 1.5-second timeout and share a snapshot per multiplexer/session within
a report. `doctor` also warns about stale sessions, injection targeting a missing
pane, and `wake=off` on an active agent. The wake policy controls offline headless
launches; bound-session injection still applies when wake is off. Diagnostics report
problems without silently changing that policy or rebinding sessions.

`switchboard doctor --prune` applies cleanup after its health scan: it clears dead
pane bindings (including live shim bindings) and marks stale registrations offline.
It keeps message history, wake policy, and last-seen timestamps. A live shim stays
connected after its dead binding is cleared. Healthy and unverified panes are left
alone. Registrations that change during the scan are skipped; a healthy same-name
session's binding is preserved when an older session is cleaned up.

By default, doctor uses the current repository and `SWITCHBOARD_SCOPE`. Use
`--share` (or `--scope share`) to explicitly select the board shared by linked
worktrees, and `--scope split` to select the current checkout's separate board.
`--all` scans all repository boards in the local daemon, including registrations
for worktrees that no longer exist. It cannot be combined with `--share` or
`--scope`. All-board text output includes each row's repository key.

```sh
switchboard doctor --share
switchboard doctor --all --json
switchboard doctor --all --prune --json
```

With `--prune --json`, the output is `{ "agents": [...], "pruned": [...] }`;
without pruning it remains an array. The agents are the pre-cleanup scan and each
pruned entry identifies the repository, name, old session binding, and reason.
Exit status still reflects warnings in that scan, so a successful cleanup can exit
1. A stale registration keeps its historical timestamp and may still warn on a later
scan; repeated pruning reports no mutation once it is already offline. Pruning and
`--all` require the updated daemon; restart it after upgrading.

Orchestrator asks are task dispatches: the wake hint asks agents to read the inbox,
execute the assigned task within workspace/repository rules, and reply with the
correlation id. This does not grant new permissions or override those rules.


## Pending asks

`switchboard status` and `bus_status` show unanswered asks on the current workspace
board. `--status` / the tool's optional `status` argument still updates the agent's
status. Omit it for a read-only view. CLI and orchestrator views include the whole
board; worker MCP sessions see only asks they sent or received, preserving directed
message visibility.

```sh
switchboard status
switchboard status --pending
switchboard status --pending --json --limit 20
switchboard status --status "reviewing" --name agy
```

`--pending` filters out the status/health detail. JSON output includes `pending_asks`
with each ask's `id`, `seq`, `from`, `to`, `topic`, `age_seconds`, a 160-character
whitespace-normalized `preview`, and `correlation_id` for replying. The MCP tool
returns these fields in structured content as well as readable text. Results are
newest first, defaulting to the 50 most recent unanswered asks; `limit` / `--limit`
accepts 1–200. Empty results are an empty array (or `pending_asks: none` in text).

A reply matches the ask's stored **correlation ID**, which is separate from its
message ID in Switchboard. Pass `correlation_id` to `bus_reply` as `correlationId`.
Matching `kind=reply` messages remove the ask from the tracker immediately; inbox
reads and progress publications/reports do not. Tracking persists across daemon
restarts and follows the current board's shared/split worktree scope, including
`SWITCHBOARD_SCOPE` and `SWITCHBOARD_REPO_KEY`. Restart the daemon after upgrading
to enable tracking.

## Wait for new mail

`switchboard wait` lets a background shell task wait for mail without a hand-written
SQLite polling loop. It reads the local store without advancing inbox cursors or
connecting as an agent, so it does not announce presence or consume messages that
`bus_inbox` should read. It works with an existing daemon without requiring a daemon
restart. The repository board follows `--cwd`, `SWITCHBOARD_SCOPE`, and
`SWITCHBOARD_REPO_KEY` as usual.

```sh
switchboard wait --to agy --timeout 240
switchboard wait --to agy --wake-existing --json
switchboard wait --to agy --since-seq 123 --interval-ms 500 --json
```

Flags:

- `--to <agent>` defaults to `SWITCHBOARD_AGENT`, then `agy`. It matches mail directed
  to that agent and broadcasts. `--to '*'` waits only for broadcasts.
- `--timeout <seconds>` defaults to 240 and accepts non-negative fractional seconds;
  zero performs an immediate check.
- `--interval-ms <ms>` defaults to 1500 and must be a positive integer. The final
  polling sleep is shortened to the remaining timeout.
- `--since-seq <n>` sets an explicit non-negative sequence baseline. By default the
  baseline is the highest unread sequence for the recipient when the command starts,
  so existing unread mail is ignored until something new arrives.
- `--wake-existing` uses a zero baseline, allowing existing unread mail to wake the
  command immediately. An explicit `--since-seq` takes precedence.
- `--session <id>` selects a native session's inbox cursor (`name:session`) instead
  of the recipient's name cursor. Zellij sessions use the name cursor, as `bus_inbox`
  does. Use this when monitoring a specific session-bound Codex/Muse/etc. inbox.
- `--json` prints a result object; normal output prints message summaries.

Every poll also checks the recipient's current inbox cursor, so messages consumed
by another reader are not returned. A wake returns up to 200 matching unread
messages, oldest first, with `seq`, `from`, `to`, `topic`, `kind`, `correlation_id`,
and a normalized 160-character `preview`. Broadcast summaries use `to: "*"`.
Presence announcements are broadcasts and can wake a wait too.

Both a message wake and timeout exit 0. Text timeout output is `TIMEOUT`. JSON has
`status` (`MESSAGES` or `TIMEOUT`), `since_seq`, and `messages` (empty on timeout).
A single readiness line goes to stderr with the effective recipient and baseline;
stdout contains only the final result. Invalid arguments or store failures exit 1.


## Native MCP waiting

`bus_wait` exposes the same non-consuming wait loop to MCP clients. Its inputs are
`to` (default your agent name), `timeout_seconds` (integer 1–120, default 30),
`interval_ms` (integer 1–60000, default 1500), `since_seq`, and `wake_existing`.
It returns the same `status`, `since_seq`, and `messages` fields as `wait --json`,
plus readable text. Use `bus_inbox` after a wake to consume the messages.

Your own inbox automatically uses your declared native session cursor, or your
name cursor for Zellij/unbound sessions. The orchestrator may also select another
recipient's name cursor. Workers may select their own inbox or broadcast-only `*`.
The board is the shim's connected repository scope. Cancelling the MCP request
interrupts the polling sleep and closes its store connection. Other tool calls
remain responsive while a wait is pending.

Configure the MCP client's request timeout to exceed the requested wait, including
transport overhead; some clients default to 60 seconds. Reconnect the MCP shim
after upgrading to discover `bus_wait`.

## Per-agent orchestration metrics

`bus_status` and `switchboard status` now include an `agent_metrics` array in JSON
and structured MCP content, with readable rows in text. Registered idle agents
appear with zero counts, and historical ask/reply participants remain represented.
Metrics are cumulative across the current board's stored history and follow its
shared/split scope. CLI/orchestrator views include all agents; worker MCP views show
only their own row. `--pending` / `pending: true` preserves the pending-only view.

Each row contains:

- `agent`: the registered or historical agent name.
- `asks_received`: all directed asks addressed to that agent.
- `replies_sent`: all reply messages sent by that agent, including follow-ups.
- `pending_asks_count`: received asks still lacking a reply with the same correlation
  ID. It covers all open asks, independently of the pending-list display limit.
- `avg_reply_latency_seconds`: mean time from an ask to the first subsequent reply
  from its assigned recipient. Each answered ask contributes once; repeated replies
  and replies sent back by the orchestrator do not inflate the average. Negative
  clock differences are clamped to zero. The value is `null` without a measured reply.
- `last_reply_at`: latest reply timestamp from that agent, in Unix milliseconds, or
  `null` if there are no replies.

Progress publications and reports do not count as replies. Use these message-level
counters as workload signals. Restart the daemon after upgrading to enable metrics
in status responses.
