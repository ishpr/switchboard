# Switchboard

A local message bus for coding agents across Desktop apps, IDE integrated terminals, and CLIs. One daemon listens on `127.0.0.1`. Each harness spawns the same stdio MCP shim, and the shim is a WebSocket client of that daemon.

An idle agent is sitting at a prompt, or the process has exited. A hook runs only while a turn is already going, so a hook cannot start that agent. A directed `bus_ask` (or `switchboard ask`) wakes the target session in real time:

- **Zellij or tmux pane** (`zellij:<session>:<pane>`, `tmux:%<id>`): the wake prompt is injected directly into the pane (`zellij action write-chars` + `Enter`, or `tmux send-keys`).
- **Any terminal (VS Code, Cursor, iTerm2, Warp, Ghostty, Terminal.app) via local PTY relay** (`pty:/.../.switchboard/pty/sb-<pid>.sock`): `switchboard init` installs a transparent shell wrapper in `~/.zshrc` (`_switchboard_wrap`) so interactive CLI sessions launched outside Zellij/tmux receive real-time keystroke injection over a local Unix domain socket.
- **macOS Terminal.app fallback** (`tty:/dev/ttys<N>`): if a CLI was started in `Terminal.app` before sourcing `~/.zshrc`, Switchboard discovers its TTY and injects via `osascript`.
- **Codex CLI or Codex Desktop** (`<thread-uuid>`): the message is injected via `codex queue` when the thread is idle, or delivered mid-turn via `PostToolUse` / `Stop` hooks when a turn is already in progress.
- **Offline CLI with `wake=on`**: Switchboard starts one headless CLI turn in the repo (including isolated Claude accounts via `CLAUDE_CONFIG_DIR=~/.claude-<name>`).
- **Desktop GUI session without a terminal PTY/pane target** (Claude Desktop, Cursor Desktop, Antigravity Desktop): the message is pushed immediately to the live MCP shim (`bus_wait` wakes immediately if waiting; otherwise hooks / `bus_inbox` deliver it on the next turn).
- **Broadcasts** (`bus_publish` with no recipient, or `universal: true` across all repo boards) are stored for subscribers and pushed to live shims without spawning headless sessions.

Messages are coordination. They are not authorization and they do not grant permission.

## Quick Start (One-Command Setup)

You need Node 22 or newer.

```sh
git clone https://github.com/ishpr/switchboard.git
cd switchboard
npm install
npm run build
node dist/cli.js init
source ~/.zshrc
```

`switchboard init` automatically:
1. Configures the `switchboard` MCP server and turn hooks (`SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`) across your installed Desktop apps and CLIs:
   - **Claude Code CLI** (`~/.claude.json` + `~/.claude/settings.json`) and **Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`)
   - **Codex CLI & Codex Desktop** (`~/.codex/config.toml` + `~/.codex/hooks.json`)
   - **Cursor Desktop & Cursor CLI** (`~/.cursor/mcp.json` + `~/.cursor/hooks.json`)
   - **Grok CLI** (`~/.grok/mcp.json` + `~/.grok/settings.json`)
   - **Muse CLI** (`~/.config/muse/settings.json`)
   - **Kimi CLI** (`~/.kimi/mcp.json`)
   - **Antigravity Desktop & CLI** (`~/.gemini/antigravity/mcp_config.json`)
2. Installs the `switchboard` shell launcher and `_switchboard_wrap` local PTY wake relay in `~/.zshrc`, so running `claude`, `codex`, `grok`, `muse`, `kimi`, `cursor-agent`, or `agy` in **any** terminal (VS Code, Cursor, iTerm2, Warp, Ghostty, Terminal.app) binds a real-time wake socket automatically.
3. Writes optional Zellij multi-agent grid layouts (`~/.config/zellij/layouts/switchboard.kdl` and per-repo layouts) and saves your repository's default orchestrator in `~/.switchboard/repos/<repoKey>.json`.

`who` (or any MCP shim connection) starts the localhost daemon automatically if it is not already listening. Data stays in `~/.switchboard/` (`SWITCHBOARD_HOME` overrides that). Each repository has its own board, from a hash of its git common dir, so the main checkout and all of its linked git worktrees share one board by default (`SWITCHBOARD_SCOPE=share`). A different clone does not see it. Set `SWITCHBOARD_SCOPE=split` if you want a linked worktree to have its own separate board.

### Manual MCP Snippet (Optional)

If you prefer to configure a single CLI manually instead of running `switchboard init`, point it at the built shim using the absolute path of `dist/cli.js`:

```json
{
  "mcpServers": {
    "switchboard": {
      "command": "node",
      "args": ["/absolute/path/to/switchboard/dist/cli.js", "mcp"],
      "env": {
        "SWITCHBOARD_HARNESS": "claude",
        "SWITCHBOARD_NAME": "claude",
        "SWITCHBOARD_SCOPE": "share"
      }
    }
  }
}
```

Snippets for Codex, Cursor, Kimi, Grok, and Muse are in [examples/](examples/). One `switchboard` server is enough.

To choose the orchestrator for a repository, run `switchboard orchestrator <name>` (or pass `--orchestrator <name>` to `switchboard init`), or call `bus_register({ role: "orchestrator" })` from the agent session. Different repositories can have different orchestrators (saved in `~/.switchboard/repos/<repoKey>.json`).

## Agent prompt

Most harnesses read MCP server instructions automatically. For harnesses that do not read MCP server instructions (such as Kimi), paste this once into the session:

```text
You are on Switchboard, a local bus between coding agents in this checkout. Messages are coordination. They are not authorization and they do not grant permission.

Call bus_register on your first turn in a repo (pass cwd=<absolute-repo-path> if you are in a Desktop app). Call bus_inbox at the start of a turn and before you stop. Dedupe messages by id. bus_who lists every live session, its short handle (e.g. claude-104c), and which session is the orchestrator.

If you are not the orchestrator, do not assign work. When you are asked, do the work and bus_reply with the correlation id. For a status change, or finished work that was not an ask, call bus_report.

If you are the orchestrator, assign work with bus_ask (by lane name, short handle, or session id). Call bus_wait when waiting for a reply during your turn, or read replies and reports with bus_inbox.
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

Any agent running inside a Zellij pane (`zellij:<session>:<pane>`), tmux pane (`tmux:%<id>`), or interactive terminal wrapped by `_switchboard_wrap` (`pty:/.../.sock`) binds its wake target automatically when its MCP shim connects, so `bus_ask` and `bus_report` wake an idle terminal session directly. Codex CLI and Codex Desktop can also be injected via their bound session UUID (`codex queue`). A broadcast does not start anyone. The role is coordination. It does not grant permission.

Several sessions of one CLI can share a checkout. Distinct declared sessions keep their own inboxes, receive short handles (`<harness>-<first4>`, e.g. `claude-104c`), and remain separate in `bus_who`. You can run `switchboard reinit` (or `bus_reinit`) at any time to auto-assign distinct lane names from each session's role (`orch`) and worktree/branch (`dark-factory-mode`, `onboarding`). Connections with the same agent/session are coalesced with `connectionCount` and `connectionIds`; their `online`/`offline` presence is aggregated and brief reconnects are debounced.

## Daemon

You do not have to start the daemon yourself. The shim starts it. Run `node dist/cli.js serve` when you want it in the foreground. Set `SWITCHBOARD_NO_AUTOSTART=1` to refuse the automatic start. A second `serve` on a busy port prints the URL that is already listening and exits.

| File | What it is |
| --- | --- |
| `token` | 32 random bytes, mode `0600`. Clients must present it. |
| `switchboard.db` | SQLite append log, cursors, shared key-value state, and the agent registry. |
| `daemon.json` | Port, pid, URL, start time, and build stamp. |
| `wake.log` | Wake commands. The prompt body is not written. |
| `pty/sb-<pid>.sock` | Per-session local PTY wake sockets for interactive CLIs launched via `switchboard wrap`. |
| `accounts.json` | Saved isolated Claude account profiles. |
| `repos/<repoKey>.json` | Per-repo orchestrator, selected panes, and isolated accounts. |

The daemon accepts `127.0.0.1` and `::1` only.

## Tools

The shim registers these MCP tools. Call `bus_inbox` at the start of a turn and before stopping. Kimi never reads MCP server instructions, so that sentence is in the tool description.

| Tool | What it does |
| --- | --- |
| `bus_register` | Register or rebind this session on the repo board (`cwd`, `name`, `role`, `wake`). Discovers your harness session id (`MUSE_SESSION_ID`, `CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`, `~/.codex/state_5.sqlite`, `~/.grok/active_sessions.json`) and wake target (`zellij:`, `tmux:`, `pty:`, `tty:`). |
| `bus_publish` | Post to a topic. Default topic is `repo`. Optional `to` makes it directed; `universal: true` broadcasts across all active repository boards on this machine. |
| `bus_subscribe` / `bus_unsubscribe` | Topics for this connection. `repo` is on by default. |
| `bus_inbox` | Messages after this session's cursor, including ones that arrived while it was away or on the universal inbox. Advances the cursor. One call reads through full pages of 50. |
| `bus_who` | Registered agents, online or offline, short handle, wake target, session id, git branch/HEAD, and role. |
| `bus_ask` | Directed message with a correlation id (by agent/lane name, short handle `claude-104c`, or session id). This is the wake path. Supports `supersedes=<correlationId>`. |
| `bus_reply` | Answer an ask (`state=done\|progress\|blocked`, default `done`). Routed back to the asker. |
| `bus_report` | Send a result or a status change to the orchestrator only. Hidden from the orchestrator's own tool list. |
| `bus_wait` | Wait for unread mail without advancing the inbox cursor. Ideal for Desktop apps waiting on a `bus_ask` reply during a turn. |
| `bus_status` | Show status, per-agent metrics, and unanswered asks; optionally set the status string shown by `bus_who`. |
| `bus_state` | Read or write shared per-repo key-value state (`get`, `set`, `list`, `delete`) with optimistic compare-and-swap (`if_rev`) without triggering wakes. |
| `bus_invite` | Invite other harnesses (`grok`, `muse`, `claude`, `codex`, `kimi`, `cursor`, `agy`) onto this repo board in `terminal` or `headless` mode. |
| `bus_reinit` | Broadcast a `[switchboard: SYSTEM RE-INIT]` notice (`universal: true` optional) and auto-assign distinct lane names from role and worktree/branch with zero session restarts. |

The same verbs exist on the CLI: `who`, `doctor`, `publish`, `inbox`, `wait`, `ask`, `reply`, `report`, `status`, `state`, `orchestrator`, `invite`, `register`, `reinit`, `wrap`, `agent add`, `account`, `hook`, `token`, `init`, `start`, `--resume` (`-c`), and `--restart` (`-r`).

Messages are retained in the store. Inbox reads advance their cursor; replaying history or reading separate topic views can return the same message again, so dedupe on its ID. Bodies are capped at 32 KB.

Topics are names like `repo` or `review`. The namespace is a hash of the git common dir (`SWITCHBOARD_SCOPE=share`, the default), so the main checkout and linked git worktrees share a board while separate clones do not meet. Set `SWITCHBOARD_SCOPE=split` to hash the git toplevel instead so a worktree gets its own board. `SWITCHBOARD_REPO_KEY` overrides the hash.

## Wake

Wake is on by default for newly registered sessions (`bus_register` or `agent add`). A broadcast never spends a model call. A directed message does, and only for the named agent or session.

```sh
node dist/cli.js agent add --name claude --harness claude --cwd "$PWD"
node dist/cli.js agent add --name codex --harness codex --session <thread-id> --cwd "$PWD"
node dist/cli.js agent add --name kimi --harness kimi --no-wake
```

`--wake` is the default for `agent add`. The shim leaves that policy in place. Set `SWITCHBOARD_WAKE=1` to turn wake on for the connection, or `SWITCHBOARD_WAKE=0` to turn it off. `SWITCHBOARD_SESSION` binds the session id for inject.

A second wake for the same agent inside 20 seconds is coalesced into a trailing wake timer when the cooldown expires.

Headless commands, when wake is on and the shim is not connected:

| Harness | Command |
| --- | --- |
| claude | `claude -p <prompt>`, or `claude -p --resume <id> <prompt>` |
| codex | `codex exec <prompt>`, or `codex exec resume <id> <prompt>` |
| cursor | `cursor-agent -p <prompt>`, or with `--resume <id>` |
| kimi | `kimi-cli --print -p <prompt>`, or with `--session <id>` |
| grok | `grok -p <prompt>`, or `grok -r <id> -p <prompt>` |
| muse | `muse exec <prompt>`, or `muse resume <id> -p <prompt>` |

An unknown harness is not launched. Codex is resolved from `SWITCHBOARD_CODEX_BIN`, then from the Codex binary inside ChatGPT.app, then from `codex` on `PATH`. Kimi is `SWITCHBOARD_KIMI_BIN` or `kimi-cli`. Prefer `kimi-cli`. A `kimi` symlink is not reliable.

The prompt tells the headless process to answer with `bus_reply` and stop. It does not ask the agent to take a new permission.

## How mail arrives

| Program | What you get |
| --- | --- |
| Any CLI in Zellij or tmux | When started inside a Zellij or tmux pane, the shim binds `zellij:<session>:<pane>` or `tmux:%<id>` automatically. Directed wakes type into that pane and press Enter. |
| Any CLI in VS Code, Cursor, iTerm2, Warp, Ghostty, or Terminal.app | After `switchboard init` and `source ~/.zshrc`, `_switchboard_wrap` wraps interactive launches of `claude`, `codex`, `grok`, `muse`, `kimi`, `cursor-agent`, and `agy` in a local PTY relay (`pty:/.../.sock`) so directed wakes inject keystrokes + Enter in real time. |
| Claude Code | Tools + `UserPromptSubmit` / `PostToolUse` / `Stop` hooks + local PTY/pane wake. Isolated accounts (`~/.claude-<id>`) connect under their own `SWITCHBOARD_NAME` and wake headless with `CLAUDE_CONFIG_DIR=~/.claude-<id>`. Sessions started with `--dangerously-load-development-channels server:switchboard` (or `--channels switchboard` via `switchboard wrap`) also receive `notifications/claude/channel`. |
| Antigravity (`agy`) | Tools always. `switchboard init` registers the `switchboard` MCP server in `~/.gemini/antigravity/mcp_config.json`. Call `bus_wait` when waiting for a reply during a turn. |
| Codex CLI & Codex Desktop | Tools + `SessionStart` / `UserPromptSubmit` / `PostToolUse` / `Stop` hooks. A bound thread receives `codex queue --thread <id> --resume` when idle, or hook delivery mid-turn. Offline wake is `codex exec`. |
| cursor-agent & Cursor Desktop | Tools + `postToolUse` hook (`~/.cursor/mcp.json` + `~/.cursor/hooks.json`). Offline CLI wake is `cursor-agent -p`. |
| kimi-cli | Tools + local PTY/pane wake (`~/.kimi/mcp.json`). Offline wake is `kimi-cli --print`. |
| grok | Tools + `Stop` hook (`~/.grok/mcp.json` + `~/.grok/settings.json`) + local PTY/pane wake. Offline wake is `grok -p` (or `grok -r <id> -p`). |
| muse | Tools + local PTY/pane wake (`~/.config/muse/settings.json`). Offline wake is `muse resume <id> -p` (or `muse exec`). |
| Claude Desktop (`Claude.app`) | Tools configured in `~/Library/Application Support/Claude/claude_desktop_config.json`. Call `bus_register({ cwd: "<repo-path>" })` on your first turn and use `bus_wait` when waiting for replies. |

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
Only a matching `kind=reply` from the assigned recipient back to the sender removes
the ask from the tracker. Sender follow-ups, inbox reads and progress publications/
reports do not close the obligation. Replies are restricted to the original ask's
participants; multi-turn follow-ups remain supported. The same completion rule is
used by status, metrics and Stop enforcement, without an implicit 30-minute expiry. Tracking persists across daemon
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
- `--topic <name>` selects a topic view. Presence is excluded unless selected explicitly.
- `--json` prints a result object; normal output prints message summaries.

Every poll also checks the recipient's current inbox cursor, so messages consumed
by another reader are not returned. A wake returns up to 200 matching unread
messages, oldest first, with `seq`, `from`, `to`, `topic`, `kind`, `correlation_id`,
and a normalized 160-character `preview`. Broadcast summaries use `to: "*"`.
Presence announcements are excluded by default. Add `--topic presence` to wait for
lifecycle events explicitly; other `--topic` values select that topic's view.

Both a message wake and timeout exit 0. Text timeout output is `TIMEOUT`. JSON has
`status` (`MESSAGES` or `TIMEOUT`), `since_seq`, and `messages` (empty on timeout).
A single readiness line goes to stderr with the effective recipient and baseline;
stdout contains only the final result. Invalid arguments or store failures exit 1.


## Native MCP waiting

`bus_wait` exposes the same non-consuming wait loop to MCP clients. Its inputs are
`to` (default your agent name), `timeout_seconds` (integer 1–120, default 30),
`interval_ms` (integer 1–60000, default 1500), `since_seq`, `wake_existing`, and optional
`topic`. Default waits ignore presence; select `topic: "presence"` to monitor it.
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


## Transport and lifecycle integrity

Protocol v2 adds a unique `reqId` to requests and echoes it on responses, so a slow
request cannot satisfy another concurrent call. Async validation and handler failures
return error frames. Timed-out tagged requests are removed and late responses are
ignored. Older clients remain supported through serialized daemon dispatch; newer
clients serialize requests to older daemons and reconnect after an untagged timeout.
Directed messages reach only their recipient, regardless of topic subscriptions.
Broadcasts use no recipient (or `to: "*"`). Requesting `topic: "reports"` does not
grant access to other agents' directed reports.

Default inbox reads and waits exclude presence records. `bus_inbox(topic="presence")`
opts into lifecycle history. Each topic-filtered inbox has an independent cursor;
reading reports cannot advance the default cursor past an unread DM. Reading the
same message from the default inbox and a topic view is possible; dedupe by ID.
A topic-filtered wait uses that view's cursor. Live topic subscriptions still control
push notifications separately from inbox reads.

Wake delivery reserves a recipient's in-flight slot before starting a child process.
Failure releases the reservation so a later attempt may retry. Short injection
commands must exit successfully within four seconds; nonzero exits and timeouts
are returned as wake failures. Offline headless launches remain detached and are
acknowledged when the process starts. Unsupported hook harness/event combinations
return before opening or consuming an inbox.

## Build identity and upgrading

`npm run build` now emits `dist/build-info.json`, recording package version,
protocol version, commit SHA, dirty state and build time. Compiled processes load
that file at startup, so later changes to checkout HEAD do not relabel an already
running build. Source execution is labeled separately. A source archive without git
metadata reports an unknown commit rather than inventing one.

Daemon welcome, who, status and doctor responses carry version/build identity, PID
and startup time. Status text/JSON and MCP structured content expose the daemon
and client/shim builds. Doctor text displays both builds and warns about version,
protocol or commit mismatches and connected shims that lack metadata. MCP server
initialization advertises its version and commit as well.

```sh
switchboard status --json
switchboard doctor --metadata --json
```

`doctor --metadata --json` returns `{daemon, client, warnings, agents, pruned}`.
Existing doctor JSON array output and `{agents, pruned}` pruning output remain
available without `--metadata`. Update and rebuild first, then restart the daemon
and reconnect MCP shims/refresh the host tool catalog. Rebuilding files alone cannot
change a schema already loaded by a long-running shim. Doctor can diagnose an older
daemon's missing metadata without replacing it or killing agent panes.
