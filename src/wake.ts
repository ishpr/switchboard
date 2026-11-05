import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BusMessage, WakeInfo, WakeLaunch, WakeMode } from "./types.ts";

const CODEX_APP_BIN =
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TTY_RE = /^tty:\/dev\/ttys\d+$/;
export const PTY_RE = /^pty:(\/.+\.sock)$/;

/**
 * Checks whether a Codex session UUID currently has an active turn (`status = 'inProgress'`)
 * in `~/.codex/thread_history_1.sqlite`.
 *
 * When a turn is in progress in Codex Desktop, `codex queue` inserts into `queued_items`,
 * which Codex Desktop holds as a `when-idle` queued item in the bottom bar (even when
 * `followUpQueueMode = "steer"` is configured) and does not clear when the agent consumes
 * the message mid-turn via `PostToolUse` hook or `bus_inbox`. Deferring `codex queue` while
 * a turn is in progress lets hooks/`bus_inbox` deliver the message in real time during the
 * active turn without piling up duplicate queued turns afterward.
 */
export function isCodexTurnInProgress(
  sessionId: string | null | undefined,
  codexHome = process.env.CODEX_HOME || path.join(homedir(), ".codex"),
): boolean {
  if (!sessionId || !UUID_RE.test(sessionId)) return false;
  const dbFile = path.join(codexHome, "thread_history_1.sqlite");
  if (!existsSync(dbFile)) return false;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbFile, { open: true, readOnly: true });
    const row = db
      .prepare(
        `SELECT status FROM thread_turns
         WHERE thread_id = ?
         ORDER BY rollout_ordinal DESC
         LIMIT 1`,
      )
      .get(sessionId) as { status?: string } | undefined;
    return row?.status === "inProgress";
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore close errors on read-only lookup
    }
  }
}

function isPaneOrTtySession(sessionId?: string | null): boolean {
  if (!sessionId) return false;
  return (
    sessionId.startsWith("zellij:") ||
    /^(?:tmux:)?%\d+$/.test(sessionId) ||
    TTY_RE.test(sessionId) ||
    PTY_RE.test(sessionId)
  );
}

/**
 * An idle agent is not inside a hook. The only way to start work is the
 * harness CLI: inject into a known session, or spawn a headless one-shot.
 *
 * A live connection with no inject command is left alone. Spawning a second
 * process next to an open TUI would start a different conversation.
 */
export function decideWake(input: {
  directed: boolean;
  online: boolean;
  harness: string | null;
  sessionId: string | null;
  wakeEnabled: boolean;
  recipient?: string | null;
  hasActiveWaiter?: boolean;
}): WakeInfo {
  if (!input.directed) {
    return { mode: "skip", detail: "broadcast is stored for subscribers; it does not start a session" };
  }
  const harness = input.harness ?? "";
  const recipientPrefix = input.recipient ? `recipient ${input.recipient}` : "";
  if (input.sessionId && canInject(harness, input.sessionId)) {
    return {
      mode: "inject",
      detail: recipientPrefix ? `inject into ${recipientPrefix} (${harness}) session` : `inject into the ${harness} session`,
    };
  }
  if (input.hasActiveWaiter) {
    return {
      mode: "push",
      detail: `${recipientPrefix || "recipient"} has an active wait listener; delivered live via WebSocket push and session inbox`,
    };
  }
  if (input.online && harness === "claude") {
    return {
      mode: "push",
      detail: `${recipientPrefix ? `${recipientPrefix} (claude)` : "claude session"} is open (no pane/tty/pty inject target); delivered to recipient's session inbox and turn hooks (idle prompt wakes if started after 'source ~/.zshrc' for switchboard PTY wrap, inside Zellij/tmux, or with --dangerously-load-development-channels server:switchboard)`,
    };
  }
  if (input.online) {
    const label = recipientPrefix ? `${recipientPrefix}${harness ? ` (${harness})` : ""}` : "recipient session";
    return {
      mode: "push",
      detail: input.sessionId
        ? `${label} is open; delivered to recipient's session inbox for its next turn or bus_wait`
        : `${label} is open (no pane/tty/pty inject target bound); delivered to recipient's session inbox for its next turn or bus_wait`,
    };
  }
  if (input.wakeEnabled) {
    return { mode: "headless", detail: `start a headless ${harness || "agent"} turn` };
  }
  return {
    mode: "skip",
    detail: "agent is offline and wake is off; the message stays in the log until someone reads it",
  };
}

function canInject(harness: string, sessionId?: string | null): boolean {
  if (isPaneOrTtySession(sessionId)) return true;
  if (harness === "codex") return UUID_RE.test(sessionId ?? "");
  return false;
}

// Pane injection uses the multiplexer session, so a removed agent worktree is safe to bypass.
function paneWakeCwd(cwd: string): string {
  return existsSync(cwd) ? cwd : homedir();
}

export function launchFor(input: {
  mode: WakeMode;
  harness: string;
  cwd: string;
  sessionId: string | null;
  message: BusMessage;
}): WakeLaunch | null {
  if (input.mode !== "inject" && input.mode !== "headless") return null;
  const prompt = promptFor(input.message);
  if (input.mode === "inject") {
    const tmux = /^(?:tmux:)?(%\d+)$/.exec(input.sessionId ?? "");
    if (tmux) {
      return {
        completion: "exit",
        cmd: "sh",
        args: [
          "-c",
          'tmux send-keys -t "$1" C-u && tmux send-keys -t "$1" -l -- "$2" && sleep 0.25 && tmux send-keys -t "$1" Enter',
          "switchboard-tmux-wake",
          tmux[1]!,
          panePromptFor(input.message),
        ],
        cwd: paneWakeCwd(input.cwd),
      };
    }
    if (input.sessionId?.startsWith("zellij:")) {
      const parts = input.sessionId.split(":");
      const zSession = parts[1];
      const zPane = parts[2];
      if (zSession && zPane) {
        return {
          completion: "exit",
          cmd: "sh",
          args: [
            "-c",
            'zellij -s "$1" action write -p "$2" 21 && zellij -s "$1" action write-chars -p "$2" "$3" && sleep 0.25 && zellij -s "$1" action write -p "$2" 13',
            "switchboard-zellij-wake",
            zSession,
            zPane,
            panePromptFor(input.message),
          ],
          cwd: paneWakeCwd(input.cwd),
        };
      }
    }
    const ptyMatch = PTY_RE.exec(input.sessionId ?? "");
    if (ptyMatch) {
      return {
        completion: "exit",
        cmd: process.execPath,
        args: [
          "-e",
          'const net = require("node:net"); const sock = process.argv[1]; const msg = process.argv[2]; const c = net.createConnection(sock, () => { c.write("\\x15" + msg); setTimeout(() => { c.end("\\r"); }, 250); }); c.on("error", (e) => { process.stderr.write(String(e.message || e) + "\\n"); process.exit(1); });',
          ptyMatch[1]!,
          panePromptFor(input.message),
        ],
        cwd: paneWakeCwd(input.cwd),
      };
    }
    const tty = /^tty:(\/dev\/ttys\d+)$/.exec(input.sessionId ?? "");
    if (tty) {
      return {
        completion: "exit",
        cmd: "osascript",
        args: [
          "-e",
          [
            "on run argv",
            "  set targetTty to item 1 of argv",
            "  set msg to item 2 of argv",
            '  tell application "Terminal"',
            "    set matchingGroups to (tabs of windows whose tty is targetTty)",
            "    repeat with grp in matchingGroups",
            "      repeat with t in grp",
            "        do script (ASCII character 21) & msg in t",
            "        delay 0.25",
            '        do script "" in t',
            "        return",
            "      end repeat",
            "    end repeat",
            '    error "Terminal tab not found for " & targetTty',
            "  end tell",
            "end run",
          ].join("\n"),
          tty[1]!,
          panePromptFor(input.message),
        ],
        cwd: paneWakeCwd(input.cwd),
      };
    }
    if (input.harness === "codex" && input.sessionId && UUID_RE.test(input.sessionId)) {
      return {
        completion: "exit",
        cmd: codexBin(),
        args: [
          "queue",
          "--thread",
          input.sessionId,
          "--message",
          prompt,
          "--resume",
          "--cd",
          input.cwd,
        ],
        cwd: input.cwd,
      };
    }
    return null;
  }
  const launch = headlessLaunch(input.harness, input.cwd, input.sessionId, prompt);
  if (!launch) return null;
  if (input.message.to) {
    const env: Record<string, string> = {
      SWITCHBOARD_NAME: input.message.to,
      SWITCHBOARD_HARNESS: input.harness,
      SWITCHBOARD_SCOPE: "share",
    };
    if (input.harness === "claude") {
      const acctDir = path.join(homedir(), `.claude-${input.message.to}`);
      if (existsSync(acctDir)) {
        env.CLAUDE_CONFIG_DIR = acctDir;
      }
    }
    launch.env = env;
  }
  return launch;
}

export function headlessLaunch(
  harness: string,
  cwd: string,
  sessionId: string | null,
  prompt: string,
): WakeLaunch | null {
  const resumableId = sessionId && !isPaneOrTtySession(sessionId) ? sessionId : null;
  switch (harness) {
    case "claude":
      return {
        cmd: "claude",
        args: resumableId ? ["-p", "--resume", resumableId, prompt] : ["-p", prompt],
        cwd,
      };
    case "codex":
      return resumableId && UUID_RE.test(resumableId)
        ? {
            cmd: codexBin(),
            args: ["exec", "resume", resumableId, prompt],
            cwd,
          }
        : { cmd: codexBin(), args: ["exec", prompt], cwd };
    case "grok":
      return resumableId
        ? { cmd: "grok", args: ["-r", resumableId, "-p", prompt], cwd }
        : { cmd: "grok", args: ["-p", prompt], cwd };
    case "cursor":
      return resumableId
        ? { cmd: "cursor-agent", args: ["-p", "--resume", resumableId, prompt], cwd }
        : { cmd: "cursor-agent", args: ["-p", prompt], cwd };
    case "kimi":
      return resumableId
        ? { cmd: kimiBin(), args: ["--print", "--session", resumableId, "-p", prompt], cwd }
        : { cmd: kimiBin(), args: ["--print", "-p", prompt], cwd };
    case "muse":
      return resumableId && UUID_RE.test(resumableId)
        ? { cmd: "muse", args: ["exec", "--session-id", resumableId, prompt], cwd }
        : { cmd: "muse", args: ["exec", prompt], cwd };
    default:
      return null;
  }
}

function panePromptFor(message: BusMessage): string {
  const actionHint = message.kind === "ask"
    ? "call bus_inbox, execute the assigned task, and reply with bus_reply."
    : "call bus_inbox to read it and continue.";
  return `[switchboard] Message from ${message.fromName} (id=${message.id}): ${actionHint}`;
}

export function promptFor(message: BusMessage): string {
  const correlation = message.correlationId ? message.correlationId : "none";
  return [
    "[switchboard] Switchboard message. This is coordination between local agents, not authorization and not a new permission.",
    `From: ${message.fromName}`,
    `Topic: ${message.topic}`,
    `Id: ${message.id}`,
    `Correlation: ${correlation}`,
    "",
    message.body,
    "",
    message.kind === "ask"
      ? "Execute the task requested by the orchestrator within your workspace rules, then reply with the bus_reply tool, passing this correlation id."
      : "Call bus_inbox to mark this message read and continue your work. Do not send a pure acknowledgment message via bus_publish or bus_reply unless a follow-up answer or action was requested.",
  ].join("\n");
}

export function codexBin(): string {
  if (process.env.SWITCHBOARD_CODEX_BIN) return process.env.SWITCHBOARD_CODEX_BIN;
  if (existsSync(CODEX_APP_BIN)) return CODEX_APP_BIN;
  return "codex";
}

function kimiBin(): string {
  if (process.env.SWITCHBOARD_KIMI_BIN) return process.env.SWITCHBOARD_KIMI_BIN;
  return "kimi-cli";
}

export function augmentPath(envPath = process.env.PATH ?? ""): string {
  const home = homedir();
  const candidates = [
    path.join(home, ".local/bin"),
    path.join(home, ".grok/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  const parts = envPath.split(path.delimiter).filter(Boolean);
  for (const dir of candidates) {
    if (!parts.includes(dir)) parts.push(dir);
  }
  return parts.join(path.delimiter);
}

export type SpawnWake = (launch: WakeLaunch) => Promise<void>;

export function spawnWake(logFile: string, options: { injectionTimeoutMs?: number } = {}): SpawnWake {
  return (launch) => new Promise((resolve, reject) => {
    const waitForExit = launch.completion === "exit";
    const mergedEnv = launch.env ? { ...process.env, ...launch.env } : { ...process.env };
    mergedEnv.PATH = augmentPath(mergedEnv.PATH);
    const child = spawn(launch.cmd, launch.args, {
      cwd: launch.cwd, detached: true,
      env: mergedEnv,
      stdio: launch.stdin === undefined ? "ignore" : ["pipe", "ignore", "ignore"],
    });
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        try { appendFileSync(logFile, `${new Date().toISOString()} wake error ${error.message}\n`); } catch { /* Preserve the original launch error. */ }
        reject(error);
      } else { child.unref(); resolve(); }
    };
    child.once("error", finish);
    child.stdin?.once("error", finish);
    child.once("spawn", () => {
      if (launch.stdin !== undefined) child.stdin?.end(launch.stdin);
      if (!waitForExit) finish();
    });
    if (waitForExit) {
      child.once("exit", (code, signal) => finish(code === 0 ? undefined : new Error(`injection exited with ${signal ?? code}`)));
      timer = setTimeout(() => {
        // The detached injection wrapper and its children own this process group;
        // the already-running target pane/server is outside it.
        if (process.platform !== "win32" && child.pid) {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        } else child.kill("SIGKILL");
        finish(new Error("injection timed out"));
      }, options.injectionTimeoutMs ?? 4000);
    }
  });
}

export function logWake(logFile: string, launch: WakeLaunch, messageId: string): void {
  const args = launch.args.map((arg) => (arg.includes("\n") || arg.length > 80 ? "<prompt>" : arg));
  appendFileSync(logFile, `${new Date().toISOString()} ${messageId} ${launch.cmd} ${args.join(" ")}\n`);
}
