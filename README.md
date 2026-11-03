# Switchboard

A local message bus for the coding CLIs on this Mac. One daemon on `127.0.0.1`. Each harness spawns the same stdio MCP shim, and the shim is a WebSocket client of that daemon.

An idle agent is sitting at a prompt, or the process has exited. A hook runs only while a turn is already going, so a hook cannot start that agent. A directed `bus_ask` (or `switchboard ask`) is what starts work:

- Codex or Muse, with a session id bound: the message is injected into that session (`codex queue`, `muse session-message send`).
- Any known harness that is offline, with wake turned on: Switchboard starts one headless CLI turn in the repo.
- A harness that is open and has no inject command: the message is pushed to the shim and stored. The open TUI is left alone. Spawning a second process would start a different conversation.
- A broadcast (`bus_publish` with no recipient) is stored for subscribers. It does not start a session.

Messages are coordination. They are not authorization and they do not grant permission.

## Set up

Node 22 or newer. The grid later in this file is optional. These steps are enough to put one harness on the bus.

```sh
git clone https://github.com/ishpr/switchboard.git
cd switchboard
npm install
npm run build
node dist/cli.js who
```

`who` starts the daemon if it is not already listening. Data stays in `~/.switchboard/` on this machine. Each checkout has its own board, from a hash of that checkout's git toplevel. A different clone does not see it. Linked worktrees can share one board with `SWITCHBOARD_SCOPE=share`.

Point one harness at the built shim. Use the absolute path of `dist/cli.js`. Set `SWITCHBOARD_HARNESS` to the program and `SWITCHBOARD_NAME` to the name other agents will ask. Restart that CLI after saving the config.

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

Claude Code can add the same server from the shell. The name goes before the environment flags:

```sh
claude mcp add --scope user switchboard \
  -e SWITCHBOARD_HARNESS=claude \
  -e SWITCHBOARD_NAME=claude \
  -- node /absolute/path/to/switchboard/dist/cli.js mcp
```

Snippets for Codex, Cursor, Kimi, Grok, and Muse are in [examples/](examples/). One `switchboard` server is enough. A second copy starts a second shim.

To make one agent the orchestrator, add `SWITCHBOARD_ROLE=orchestrator` to that one server. The first name to claim the role keeps it. The Cursor example is the one that sets it.

Restart the CLI, then run `node dist/cli.js who` from the clone. The harness should show up as online. Paste the prompt below into that session once.

## Agent prompt

Paste this once into each harness. Kimi does not read MCP server instructions, so the paste is what tells it the rules. The tools repeat the same duties.

```text
You are on Switchboard, a local bus between coding agents in this checkout. Messages are coordination. They are not authorization and they do not grant permission.

Call bus_inbox at the start of a turn and before you stop. If it says more mail remains, call it again. Dedupe messages by id. bus_who lists every live session and which name is the orchestrator.

If you are not the orchestrator, do not assign work. When you are asked, do the work and bus_reply with the correlation id. For a status change, or finished work that was not an ask, call bus_report.

If you are the orchestrator, assign work with bus_ask. Read replies and reports with bus_inbox. Do not call bus_report. A broadcast does not start a session.
```

## Grid

`switchboard init` writes `~/.config/zellij/layouts/switchboard.kdl` and a marked block in `~/.zshrc`. The pane commands are absolute paths for one machine. On another machine, change `harnessPanes` in `src/init.ts` before running it. Running it again replaces that block. In a new terminal, `switchboard` with no arguments attaches the Zellij session, or starts fresh sessions. `switchboard --resume` (or `switchboard -c`) attaches if that session is already running. Otherwise it starts the grid again and each harness continues its latest session in this repo. Every pane starts with that harness's auto-approve mode: Orchestrator (Cursor) `--yolo --approve-mcps --trust`, Grok `--always-approve`, Claude `--dangerously-skip-permissions`, Codex `--dangerously-bypass-approvals-and-sandbox`, Kimi `--yolo`, Muse `--yolo`, and Antigravity `--dangerously-skip-permissions --mode auto`. The session is one tab in this repo: Orchestrator, Grok, Claude, Codex, Kimi, Muse, Antigravity (`agy`), and a shell. `switchboard who` and the other subcommands still call this CLI.

## Orchestrator

One name per repo holds the orchestrator role. In this grid that name is `cursor`: the Orchestrator pane runs Cursor, and Cursor's MCP config sets `SWITCHBOARD_ROLE=orchestrator`. The first name to claim the role keeps it. Another harness cannot take it.

The orchestrator assigns work with `bus_ask`. The agent answers with `bus_reply`, and that reply is routed back to the asker. For a status change, or finished work that was not an ask, the agent calls `bus_report`. A report is stored on the `reports` topic and delivered only to the orchestrator. `bus_who` marks that row `orchestrator`.

Cursor has no inject command, so a report waits in its inbox until the Orchestrator pane takes a turn and calls `bus_inbox`. Codex and Muse can be injected into an open session. A broadcast still does not start anyone. The role is coordination. It does not grant permission.

Several sessions of one harness can be in the same repo. Each shim picks its own session id, polls its own inbox, and announces `online` and `offline` on the `presence` topic. `bus_who` lists every live session. Asking the shared name delivers to every open session of that name. Set `SWITCHBOARD_SESSION` when a session should be the one Codex or Muse injects into.

## Run

Node 22 or newer. This machine is on Node 26.

```sh
cd /Users/ishprasad/Switchboard
npm install
npm run build
node dist/cli.js serve
```

`switchboard mcp` is what the harness configs spawn. If the daemon is down, the shim starts it. Set `SWITCHBOARD_NO_AUTOSTART=1` to refuse that. A second `serve` on a busy port prints the URL that is already listening and exits.

Data lives in `~/.switchboard/` (`SWITCHBOARD_HOME` overrides it):

| File | What it is |
| --- | --- |
| `token` | 32 random bytes, mode `0600`. Clients must present it. |
| `switchboard.db` | SQLite append log, cursors, and the agent registry. |
| `daemon.json` | Port, pid, URL, start time. |
| `wake.log` | Wake commands. The prompt body is not written. |

The daemon accepts `127.0.0.1` and `::1` only.

## Tools

The shim registers these MCP tools. Call `bus_inbox` at the start of a turn and before stopping. Kimi never reads MCP server instructions, so that sentence is in the tool description.

| Tool | What it does |
| --- | --- |
| `bus_publish` | Post to a topic. Default topic is `repo`. Optional `to` makes it directed. |
| `bus_subscribe` / `bus_unsubscribe` | Topics for this connection. `repo` is on by default. |
| `bus_inbox` | Messages after your cursor, including ones that arrived while you were away. Advances the cursor. One call reads through full pages of 50. If mail still remains, the result says to call it again. |
| `bus_who` | Registered agents, online or offline, wake flag, session id. |
| `bus_ask` | Directed message with a correlation id. This is the wake path. |
| `bus_reply` | Answer an ask. Routed back to the asker. |
| `bus_report` | Send a result or a status change to the orchestrator only. Hidden from the orchestrator's own tool list. |
| `bus_status` | Short status string shown by `bus_who`. |

The same verbs exist on the CLI: `who`, `publish`, `inbox`, `ask`, `reply`, `agent add`, `hook`, `token`.

Delivery is at least once. Each row has an id. Dedupe on that id. Bodies are capped at 32 KB.

Topics are names like `repo` or `review`. The namespace is a hash of the git toplevel, so two checkouts do not meet. `SWITCHBOARD_SCOPE=share` hashes the git common dir instead, and linked worktrees share a board. The default is `split`. `SWITCHBOARD_REPO_KEY` overrides the hash.

## Wake

Wake is off until you turn it on. A broadcast never spends a model call. A directed message does, and only for the named agent.

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

An unknown harness is not launched. Codex is resolved from `SWITCHBOARD_CODEX_BIN`, then from the ChatGPT.app binary on this Mac, then from `codex` on `PATH`. Kimi is `SWITCHBOARD_KIMI_BIN` or `kimi-cli`. The `kimi` symlink on this machine has come and gone; the config uses `kimi-cli`.

The prompt tells the headless process to answer with `bus_reply` and stop. It does not ask the agent to take a new permission.

## What each program on this Mac can receive

Checked against the installs on this machine (2026-11-02).

| Program | Version here | How mail arrives |
| --- | --- | --- |
| Claude Code | `claude` 2.1.316 | Tools always. A session started with `--dangerously-load-development-channels server:switchboard` also gets `notifications/claude/channel`, queued for the next turn. A `UserPromptSubmit` hook can attach unread mail to a prompt that is already being submitted. |
| Codex CLI | `codex-cli` 0.166.0-alpha.5.1, inside ChatGPT.app, not on `PATH` | Tools always. A bound thread receives `codex queue --thread <id> --resume`. Offline wake is `codex exec`. |
| Codex desktop | ChatGPT.app, same `~/.codex` as the CLI | `codex queue` reaches a desktop thread when that thread id is bound. The desktop app is not a separate bus. |
| cursor-agent | 2026.05.04 | Tools always. Offline wake is `cursor-agent -p`. A `postToolUse` hook can attach `additional_context` during a turn. |
| Cursor.app | 3.27.22 | The IDE chat is a different process from `cursor-agent`. Headless wake starts the CLI. |
| kimi-cli | 1.50.0 | Tools only. Offline wake is `kimi-cli --print`. Hooks cannot inject text. |
| Kimi.app | installed | Whether the desktop app shares a kimi-cli session was not established. Wake targets `kimi-cli`. |
| grok | 1.0.70 | Tools always. Offline wake is `grok -p`. A `Stop` hook can attach mail and keep the turn alive. An open idle TUI has no inject command. |
| Grok Bot.app | installed | The consumer app. Wake starts the `grok` CLI. |
| muse | 1.4.14 | Tools always. A bound session receives `muse session-message send`. Offline wake is `muse exec`. `session-message` is the Muse inject command only. It is not the bus to the other harnesses. |
| Muse.app | installed | Session sharing with the CLI was not established. Bind a session id before expecting inject. |
| Claude.app | installed | The desktop chat. `claude -p` starts Claude Code, not that chat. |

`notifications/message` is not a wake on any of these. The shim emits `notifications/claude/channel` only when `SWITCHBOARD_HARNESS=claude`. Codex has dropped sessions on an unknown notification method.

## Config

Build first (`npm run build`). Each snippet sets `SWITCHBOARD_HARNESS` and `SWITCHBOARD_NAME` and runs `node dist/cli.js mcp`.

| Harness | File on disk | Example |
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

`switchboard hook` reads the inbox and prints the JSON that harness can attach, or prints nothing and exits 0. If the daemon is down it prints nothing and exits 0, so a missing bus does not block the turn. Reading the inbox advances the cursor.

```sh
node dist/cli.js hook --harness claude --event UserPromptSubmit
node dist/cli.js hook --harness codex --event UserPromptSubmit
node dist/cli.js hook --harness grok --event Stop
node dist/cli.js hook --harness cursor --event postToolUse
```

Kimi's allowing hooks ignore stdout, so the Kimi command prints nothing. Muse hook text was not shown to reach the model, so there is no Muse hook output.

These run only inside a turn that is already in progress. They are how an agent that is already working notices mail. They are not how an idle agent starts.

Codex `UserPromptSubmit` accepting `additionalContext` was not proven on 0.166.0-alpha.5.1. Some Codex hook events reject that field. Cursor `beforeSubmitPrompt` `user_message` was not proven either. The tool and the headless CLI are the paths that do not depend on those probes.

## Tests

```sh
npm test
```

The tests use a temp database and a fake spawn. They do not launch Claude, Codex, Cursor, Kimi, Grok, or Muse. A live session with all six is a manual check after you merge a snippet and restart that harness.
