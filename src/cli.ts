#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { BusClient } from "./busClient.ts";
import { startDaemon } from "./daemon.ts";
import { ensureDaemon, readDaemonInfo } from "./ensure.ts";
import { hookStdout } from "./hook.ts";
import { daemonInfoPath, dbPath, switchboardHome, wakeLogPath } from "./paths.ts";
import { repoKey } from "./repo.ts";
import { runShim } from "./shim.ts";
import { ensureToken, readToken } from "./token.ts";
import { DEFAULT_PORT, type ClientHello } from "./types.ts";
import { gridPlan, init } from "./init.ts";
import { spawnWake } from "./wake.ts";

const command = process.argv[2];

try {
  switch (command) {
    case "serve":
      await serve();
      break;
    case "mcp":
      await runShim();
      break;
    case "who":
      await who();
      break;
    case "publish":
      await publish();
      break;
    case "inbox":
      await inbox();
      break;
    case "ask":
      await ask();
      break;
    case "reply":
      await reply();
      break;
    case "agent":
      await agent();
      break;
    case "hook":
      await hook();
      break;
    case "token":
      process.stdout.write(`${readToken()}\n`);
      break;
    case "init":
      await init();
      break;
    case "--resume":
    case "-c":
    case "--continue":
      await openGrid(true);
      break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      usage();
      break;
    default:
      usage();
      process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`switchboard: ${message}\n`);
  process.exitCode = 1;
}

function usage(): void {
  process.stdout.write(`switchboard — local agent message bus

  serve                 Start the localhost daemon
  mcp                   Stdio MCP shim (what harnesses spawn)
  who                   List agents in this repo
  publish               Publish a message
  inbox                 Print messages since your cursor
  ask                   Ask one agent (may wake a headless CLI)
  reply                 Reply to an ask
  agent add             Register an agent and its wake policy
  hook                  Print hook JSON for a turn already in progress
  token                 Print the machine token path's contents
  init                  Install the Zellij grid and the ~/.zshrc launcher
  --resume, -c          Attach the grid, or continue each harness's latest session

An idle agent is not inside a hook. ask wakes it by injecting into a bound
Codex or Muse session, or by starting that harness headless when it is offline
and wake is on. A broadcast does not start a session.

One agent claims the orchestrator role (Cursor, in the grid). It assigns work
with ask. Others reply, or report a result that was not an ask. Reports are
delivered only to the orchestrator.
`);
}

function switchboardSessionLine(): string | null {
  let out = "";
  try {
    out = execFileSync("zellij", ["list-sessions", "--no-formatting"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    const stdout =
      error && typeof error === "object" && "stdout" in error ? String(error.stdout ?? "") : "";
    out = stdout;
  }
  return out.split("\n").find((line) => line.startsWith("switchboard ")) ?? null;
}

function runZellij(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("zellij", args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code) process.exitCode = code;
      resolve();
    });
  });
}

async function openGrid(resume: boolean): Promise<void> {
  const plan = gridPlan(resume, switchboardSessionLine(), path.join(homedir(), ".config/zellij/layouts"));
  if (plan.action === "start" && plan.deleteFirst) {
    execFileSync("zellij", ["delete-session", plan.session], { stdio: "ignore" });
  }
  const args =
    plan.action === "attach"
      ? ["attach", plan.session]
      : ["--session", plan.session, "--new-session-with-layout", plan.layout];
  await runZellij(args);
}

async function serve(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      home: { type: "string" },
      port: { type: "string" },
    },
  });
  if (values.home) process.env.SWITCHBOARD_HOME = values.home;
  const home = switchboardHome();
  const port = values.port ? Number(values.port) : DEFAULT_PORT;
  const token = ensureToken(home);
  const logFile = wakeLogPath(home);
  let handle;
  try {
    handle = await startDaemon({
      port,
      dbFile: dbPath(home),
      token,
      logFile,
      spawnWake: spawnWake(logFile),
    });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : "";
    if (code === "EADDRINUSE") {
      const info = readDaemonInfo(home);
      process.stdout.write(
        info ? `switchboard already running at ${info.url}\n` : "switchboard already running\n",
      );
      return;
    }
    throw error;
  }
  const info = {
    port: handle.port,
    pid: process.pid,
    url: handle.url,
    startedAt: Date.now(),
  };
  writeFileSync(daemonInfoPath(home), `${JSON.stringify(info)}\n`);
  process.stdout.write(`switchboard listening on ${handle.url}\n`);
  const stop = () => {
    void handle.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise(() => {});
}

async function who(): Promise<void> {
  const client = await connectCli();
  try {
    const frame = await client.request({ type: "who" });
    if (frame.type !== "who") throw new Error("unexpected response");
    if (frame.agents.length === 0) {
      process.stdout.write("nobody registered in this repo\n");
      return;
    }
    for (const agent of frame.agents) {
      const state = agent.online ? "online" : "offline";
      const wake = agent.wake ? "wake" : "no-wake";
      const session = agent.sessionId ? ` session=${agent.sessionId}` : "";
      process.stdout.write(
        `${agent.name}\t${agent.harness}\t${state}\t${wake}${session}\t${agent.role}\t${agent.status}\n`,
      );
    }
  } finally {
    client.close();
  }
}

async function publish(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      topic: { type: "string", default: "repo" },
      message: { type: "string" },
      to: { type: "string" },
    },
  });
  if (!values.message) throw new Error("publish requires --message");
  const client = await connectCli();
  try {
    const frame = await client.request({
      type: "publish",
      topic: values.topic ?? "repo",
      body: values.message,
      to: values.to,
    });
    if (frame.type !== "published") throw new Error("unexpected response");
    process.stdout.write(`id=${frame.id} seq=${frame.seq}\n${frame.wake.mode}: ${frame.wake.detail}\n`);
  } finally {
    client.close();
  }
}

async function inbox(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: { since: { type: "string" }, topic: { type: "string" } },
  });
  const client = await connectCli();
  try {
    const frame = await client.request({
      type: "inbox",
      since: values.since ? Number(values.since) : undefined,
      topic: values.topic,
    });
    if (frame.type !== "inbox") throw new Error("unexpected response");
    if (frame.messages.length === 0) {
      process.stdout.write("inbox empty\n");
      return;
    }
    for (const message of frame.messages) {
      process.stdout.write(
        `#${message.seq} ${message.fromName} ${message.topic} ${message.id}\n${message.body}\n\n`,
      );
    }
  } finally {
    client.close();
  }
}

async function ask(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      to: { type: "string" },
      message: { type: "string" },
      topic: { type: "string" },
    },
  });
  if (!values.to || !values.message) throw new Error("ask requires --to and --message");
  const client = await connectCli();
  try {
    const frame = await client.request({
      type: "ask",
      to: values.to,
      body: values.message,
      topic: values.topic,
    });
    if (frame.type !== "published") throw new Error("unexpected response");
    process.stdout.write(
      `id=${frame.id} correlation=${frame.correlationId ?? ""}\n${frame.wake.mode}: ${frame.wake.detail}\n`,
    );
  } finally {
    client.close();
  }
}

async function reply(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      correlation: { type: "string" },
      message: { type: "string" },
    },
  });
  if (!values.correlation || !values.message) {
    throw new Error("reply requires --correlation and --message");
  }
  const client = await connectCli();
  try {
    const frame = await client.request({
      type: "reply",
      correlationId: values.correlation,
      body: values.message,
    });
    if (frame.type !== "published") throw new Error("unexpected response");
    process.stdout.write(`id=${frame.id}\n${frame.wake.mode}: ${frame.wake.detail}\n`);
  } finally {
    client.close();
  }
}

async function agent(): Promise<void> {
  const sub = process.argv[3];
  if (sub !== "add") throw new Error("usage: switchboard agent add --name <name> --harness <harness> [--session <id>] [--wake | --no-wake]");
  const { values } = parseArgs({
    args: process.argv.slice(4),
    allowNegative: true,
    options: {
      name: { type: "string" },
      harness: { type: "string" },
      session: { type: "string" },
      cwd: { type: "string" },
      wake: { type: "boolean", default: true },
    },
  });
  if (!values.name || !values.harness) throw new Error("agent add requires --name and --harness");
  const cwd = values.cwd || process.cwd();
  const client = await connectCli(cwd);
  try {
    const frame = await client.request({
      type: "register",
      name: values.name,
      harness: values.harness,
      cwd,
      sessionId: values.session,
      wake: values.wake ?? true,
    });
    if (frame.type !== "registered") throw new Error("unexpected response");
    process.stdout.write(`registered ${frame.name}\n`);
  } finally {
    client.close();
  }
}

async function hook(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      harness: { type: "string" },
      event: { type: "string" },
      name: { type: "string" },
    },
  });
  const harness = values.harness || process.env.SWITCHBOARD_HARNESS || "";
  const event = values.event || "";
  if (!harness || !event) throw new Error("hook requires --harness and --event");
  const home = switchboardHome();
  const info = readDaemonInfo(home);
  if (!info) return;
  let client: BusClient;
  try {
    client = await connectCli(process.cwd(), values.name || harness);
  } catch {
    return;
  }
  try {
    const frame = await client.request({ type: "inbox" });
    if (frame.type !== "inbox") return;
    process.stdout.write(hookStdout(harness, event, frame.messages));
  } finally {
    client.close();
  }
}

async function connectCli(cwd = process.cwd(), name = "cli"): Promise<BusClient> {
  const { url, token } = await ensureDaemon();
  const hello: ClientHello = {
    type: "hello",
    token,
    name,
    harness: "cli",
    repoKey: repoKey(cwd),
    cwd,
    wake: false,
  };
  const client = new BusClient();
  await client.connect(url, hello);
  return client;
}
