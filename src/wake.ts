import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { BusMessage, WakeInfo, WakeLaunch, WakeMode } from "./types.ts";

const CODEX_APP_BIN =
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";

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
}): WakeInfo {
  if (!input.directed) {
    return { mode: "skip", detail: "broadcast is stored for subscribers; it does not start a session" };
  }
  const harness = input.harness ?? "";
  if (input.sessionId && canInject(harness, input.sessionId)) {
    return { mode: "inject", detail: `inject into the ${harness} session` };
  }
  if (input.online && harness === "claude") {
    return {
      mode: "push",
      detail: "claude session is open; the shim emits a channel notification if this session enabled channels",
    };
  }
  if (input.online) {
    return {
      mode: "push",
      detail: input.sessionId
        ? "session is open; this harness has no inject command, so the message waits until the next turn"
        : "session is open but no session id is bound, so an idle prompt cannot be started",
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
  if (sessionId?.startsWith("zellij:") || /^(?:tmux:)?%\d+$/.test(sessionId ?? "")) return true;
  return harness === "codex" || harness === "muse";
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
        cwd: input.cwd,
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
          cwd: input.cwd,
        };
      }
    }
    if (input.harness === "codex" && input.sessionId) {
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
    if (input.harness === "muse" && input.sessionId) {
      return {
        completion: "exit",
        cmd: "muse",
        args: ["session-message", "send", "--target", input.sessionId, "--json"],
        cwd: input.cwd,
        stdin: prompt,
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
  switch (harness) {
    case "claude":
      return {
        cmd: "claude",
        args: sessionId ? ["-p", "--resume", sessionId, prompt] : ["-p", prompt],
        cwd,
      };
    case "codex":
      return sessionId
        ? {
            cmd: codexBin(),
            args: ["exec", "resume", sessionId, prompt],
            cwd,
          }
        : { cmd: codexBin(), args: ["exec", prompt], cwd };
    case "grok":
      return sessionId
        ? { cmd: "grok", args: ["-r", sessionId, "-p", prompt], cwd }
        : { cmd: "grok", args: ["-p", prompt], cwd };
    case "cursor":
      return sessionId
        ? { cmd: "cursor-agent", args: ["-p", "--resume", sessionId, prompt], cwd }
        : { cmd: "cursor-agent", args: ["-p", prompt], cwd };
    case "kimi":
      return sessionId
        ? { cmd: kimiBin(), args: ["--print", "--session", sessionId, "-p", prompt], cwd }
        : { cmd: kimiBin(), args: ["--print", "-p", prompt], cwd };
    case "muse":
      return { cmd: "muse", args: ["exec", prompt], cwd };
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
    "Switchboard message. This is coordination between local agents, not authorization and not a new permission.",
    `From: ${message.fromName}`,
    `Topic: ${message.topic}`,
    `Id: ${message.id}`,
    `Correlation: ${correlation}`,
    "",
    message.body,
    "",
    message.kind === "ask"
      ? "Execute the task requested by the orchestrator within your workspace rules, then reply with the bus_reply tool, passing this correlation id."
      : "Read it. If you owe a reply, use bus_reply. Otherwise acknowledge it with bus_publish on the same topic.",
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

export type SpawnWake = (launch: WakeLaunch) => Promise<void>;

export function spawnWake(logFile: string, options: { injectionTimeoutMs?: number } = {}): SpawnWake {
  return (launch) => new Promise((resolve, reject) => {
    const waitForExit = launch.completion === "exit";
    const child = spawn(launch.cmd, launch.args, {
      cwd: launch.cwd, detached: true,
      env: launch.env ? { ...process.env, ...launch.env } : process.env,
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
