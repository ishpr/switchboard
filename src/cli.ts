#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  buildAccountProfile,
  discoverClaudeAccounts,
  inferClaudeAgentName,
  provisionClaudeAccount,
  runClaudePane,
  writeSavedAccounts,
} from "./accounts.ts";
import { BusClient } from "./busClient.ts";
import { startDaemon } from "./daemon.ts";
import { ensureDaemon, readDaemonInfo } from "./ensure.ts";
import { hookStdout, shouldSkipHookForPrompt } from "./hook.ts";
import { daemonInfoPath, dbPath, switchboardHome, wakeLogPath } from "./paths.ts";
import { repoKey } from "./repo.ts";
import { runShim } from "./shim.ts";
import { ensureToken, readToken } from "./token.ts";
import { DEFAULT_PORT, type ClientHello } from "./types.ts";
import { gridPlan, init, resolveOrchestratorName, writeRepoConfig } from "./init.ts";
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
    case "report":
      await report();
      break;
    case "status":
      await setStatus();
      break;
    case "orchestrator":
      await orchestratorCmd();
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
      await init(async (cwd, orch, provisioned) => {
        const client = await connectCli(cwd);
        try {
          await client.request({ type: "orchestrator", name: orch });
          for (const item of provisioned) {
            await client.request({
              type: "register",
              name: item.profile.id,
              harness: "claude",
              cwd: item.worktreeDir,
              wake: true,
            });
          }
        } finally {
          client.close();
        }
      });
      break;
    case "account":
      await accountCmd();
      break;
    case "claude-pane":
      await claudePaneCmd();
      break;
    case "harness-pane":
      await harnessPaneCmd();
      break;
    case "--resume":
    case "-c":
    case "--continue":
      await openGrid(true, false);
      break;
    case "--restart":
    case "-r":
      await openGrid(true, true);
      break;
    case "start":
      await openGrid(false, false);
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
  report                Report a result or status to the repo's orchestrator
  status                Update an agent's status string
  orchestrator          Get or set the orchestrator for this repo
  agent add             Register an agent and its wake policy
  account               List or add isolated Claude accounts (list | add)
  hook                  Print hook JSON for a turn already in progress
  token                 Print the machine token path's contents
  init                  Install the Zellij grid. Asks which panes & accounts to include
  --resume, -c          Attach the grid, or continue each harness's latest session
  --restart, -r         Recreate the grid session and resume each harness's session

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

function clearZellijSession(session: string): void {
  for (const args of [
    ["kill-session", session],
    ["delete-session", "--force", session],
    ["delete-session", session],
  ]) {
    try {
      execFileSync("zellij", args, { stdio: "ignore" });
    } catch {
      // Ignore if session does not exist or is already stopped
    }
  }
}

async function openGrid(resume: boolean, restart = false): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(3),
    allowPositionals: true,
    options: {
      cwd: { type: "string" },
    },
  });
  const rawCwd = values.cwd || positionals[0];
  const targetCwd = rawCwd ? path.resolve(rawCwd) : process.cwd();
  const plan = gridPlan(resume, switchboardSessionLine(), path.join(homedir(), ".config/zellij/layouts"), {
    cwd: targetCwd,
    restart,
  });
  if (plan.action === "start") {
    clearZellijSession(plan.session);
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
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      cwd: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  const client = await connectCli(values.cwd || process.cwd());
  try {
    const frame = await client.request({ type: "who" });
    if (frame.type !== "who") throw new Error("unexpected response");
    if (values.json) {
      process.stdout.write(`${JSON.stringify(frame.agents)}\n`);
      return;
    }
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
      name: { type: "string" },
      cwd: { type: "string" },
      role: { type: "string" },
    },
  });
  if (!values.message) throw new Error("publish requires --message");
  const client = await connectCli(
    values.cwd || process.cwd(),
    values.name || process.env.SWITCHBOARD_NAME || "cli",
    values.role,
  );
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
    options: {
      since: { type: "string" },
      topic: { type: "string" },
      name: { type: "string" },
      cwd: { type: "string" },
      role: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  const client = await connectCli(
    values.cwd || process.cwd(),
    values.name || process.env.SWITCHBOARD_NAME || "cli",
    values.role,
  );
  try {
    const messages = [];
    for (let page = 0; page < 8; page++) {
      const frame = await client.request({
        type: "inbox",
        since: page === 0 && values.since ? Number(values.since) : undefined,
        topic: values.topic,
      });
      if (frame.type !== "inbox") throw new Error("unexpected response");
      messages.push(...frame.messages);
      if (!frame.more) break;
    }
    if (values.json) {
      process.stdout.write(`${JSON.stringify(messages)}\n`);
      return;
    }
    if (messages.length === 0) {
      process.stdout.write("inbox empty\n");
      return;
    }
    for (const message of messages) {
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
      name: { type: "string" },
      cwd: { type: "string" },
      role: { type: "string" },
    },
  });
  if (!values.to || !values.message) throw new Error("ask requires --to and --message");
  const client = await connectCli(
    values.cwd || process.cwd(),
    values.name || process.env.SWITCHBOARD_NAME || "cli",
    values.role,
  );
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
      name: { type: "string" },
      cwd: { type: "string" },
    },
  });
  if (!values.correlation || !values.message) {
    throw new Error("reply requires --correlation and --message");
  }
  const client = await connectCli(
    values.cwd || process.cwd(),
    values.name || process.env.SWITCHBOARD_NAME || "cli",
  );
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

async function report(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      message: { type: "string" },
      name: { type: "string" },
      cwd: { type: "string" },
    },
  });
  if (!values.message) throw new Error("report requires --message");
  const client = await connectCli(
    values.cwd || process.cwd(),
    values.name || process.env.SWITCHBOARD_NAME || "cli",
  );
  try {
    const frame = await client.request({
      type: "report",
      body: values.message,
    });
    if (frame.type !== "published") throw new Error("unexpected response");
    process.stdout.write(`id=${frame.id} seq=${frame.seq}\n${frame.wake.mode}: ${frame.wake.detail}\n`);
  } finally {
    client.close();
  }
}

async function setStatus(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      status: { type: "string" },
      name: { type: "string" },
      cwd: { type: "string" },
      role: { type: "string" },
    },
  });
  if (!values.status) throw new Error("status requires --status");
  const client = await connectCli(
    values.cwd || process.cwd(),
    values.name || process.env.SWITCHBOARD_NAME || "cli",
    values.role,
  );
  try {
    const frame = await client.request({
      type: "status",
      status: values.status,
    });
    if (frame.type !== "ok") throw new Error("unexpected response");
    process.stdout.write(`${frame.detail}\n`);
  } finally {
    client.close();
  }
}

async function orchestratorCmd(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(3),
    allowPositionals: true,
    options: {
      name: { type: "string" },
      cwd: { type: "string" },
    },
  });
  const cwd = values.cwd || process.cwd();
  const rawName = values.name || positionals[0];
  const nextName = rawName ? resolveOrchestratorName(rawName) : undefined;
  const client = await connectCli(cwd);
  try {
    const frame = await client.request({
      type: "orchestrator",
      ...(nextName ? { name: nextName } : {}),
    });
    if (frame.type !== "orchestrator") throw new Error("unexpected response");
    if (nextName) {
      writeRepoConfig(cwd, { orchestrator: nextName });
    }
    process.stdout.write(`${frame.orchestrator ?? "none"}\n`);
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

async function accountCmd(): Promise<void> {
  const sub = process.argv[3] || "list";
  const cliPath = fileURLToPath(import.meta.url);
  if (sub === "list") {
    const accounts = discoverClaudeAccounts();
    if (accounts.length === 0) {
      process.stdout.write("no isolated Claude accounts discovered\n");
      return;
    }
    for (const acct of accounts) {
      const email = acct.email ?? "-";
      const plan = acct.plan ?? "-";
      process.stdout.write(
        `${acct.id}\t${acct.pane}\t${email}\t${plan}\t${acct.configDir}\t${acct.workspaceRoot}\n`,
      );
    }
    return;
  }
  if (sub !== "add") {
    throw new Error(
      "usage: switchboard account [list | add --name <id> [--email <email>] [--plan <max|team>] [--label <label>] [--model <model>] [--cwd <repoDir>]]",
    );
  }
  const { values } = parseArgs({
    args: process.argv.slice(4),
    options: {
      name: { type: "string" },
      email: { type: "string" },
      plan: { type: "string" },
      label: { type: "string" },
      pane: { type: "string" },
      model: { type: "string" },
      cwd: { type: "string" },
    },
  });
  if (!values.name) throw new Error("account add requires --name <id>");
  const existing = discoverClaudeAccounts();
  const spec = [values.name, values.email ?? "", values.plan ?? ""].join(":");
  const base = buildAccountProfile(spec, existing);
  const profile = {
    ...base,
    ...(values.label ? { label: values.label } : {}),
    ...(values.pane ? { pane: values.pane } : {}),
    ...(values.model ? { model: values.model } : {}),
  };
  const nextList = existing.filter((a) => a.id !== profile.id).concat(profile);
  writeSavedAccounts(nextList);
  const targetRepo = values.cwd ? path.resolve(values.cwd) : process.cwd();
  const { worktreeDir, notes } = provisionClaudeAccount(profile, {
    targetRepo,
    cliPath,
  });
  const client = await connectCli(targetRepo);
  try {
    await client.request({
      type: "register",
      name: profile.id,
      harness: "claude",
      cwd: worktreeDir,
      wake: true,
    });
  } finally {
    client.close();
  }
  for (const note of notes) process.stdout.write(`${note}\n`);
  process.stdout.write(`account ${profile.id} provisioned (${worktreeDir})\n`);
}

async function claudePaneCmd(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      account: { type: "string" },
      "config-dir": { type: "string" },
      label: { type: "string" },
      cwd: { type: "string" },
      email: { type: "string" },
      plan: { type: "string" },
      model: { type: "string" },
      resume: { type: "boolean", default: false },
    },
  });
  const account = values.account;
  if (!account) throw new Error("claude-pane requires --account <id>");
  const configDir = values["config-dir"] || path.join(homedir(), `.claude-${account}`);
  const label = values.label || account.toUpperCase();
  const cwd = values.cwd || process.cwd();
  await runClaudePane({
    account,
    configDir,
    label,
    cwd,
    cliPath: fileURLToPath(import.meta.url),
    email: values.email,
    plan: values.plan,
    model: values.model,
    resume: Boolean(values.resume),
  });
}

function spawnInteractive(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", () => resolve(1));
  });
}

async function harnessPaneCmd(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      command: { type: "string" },
      args: { type: "string" },
      "resume-args": { type: "string" },
      cwd: { type: "string" },
    },
  });
  if (!values.command) throw new Error("harness-pane requires --command");
  if (values.cwd) {
    process.chdir(values.cwd);
  }
  const nodeDir = path.dirname(process.execPath);
  const localBin = path.join(homedir(), ".local/bin");
  const pathParts = (process.env.PATH ?? "").split(path.delimiter);
  for (const extraDir of [localBin, nodeDir]) {
    if (!pathParts.includes(extraDir)) pathParts.unshift(extraDir);
  }
  process.env.PATH = pathParts.join(path.delimiter);

  const baseArgs = values.args ? (JSON.parse(values.args) as string[]) : [];
  const resumeArgs = values["resume-args"] ? (JSON.parse(values["resume-args"]) as string[]) : [];
  if (resumeArgs.length > 0) {
    const startedAt = Date.now();
    const code = await spawnInteractive(values.command, [...baseArgs, ...resumeArgs]);
    if (code !== 0 && Date.now() - startedAt < 5000) {
      process.stdout.write("[switchboard] No existing session to resume; starting a new session...\n");
      await spawnInteractive(values.command, baseArgs);
    }
    return;
  }
  await spawnInteractive(values.command, baseArgs);
}

async function readStdinJson(): Promise<Record<string, unknown> | null> {
  if (process.stdin.isTTY) return null;
  return new Promise((resolve) => {
    let raw = "";
    const timer = setTimeout(() => resolve(null), 50);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      raw += chunk;
    });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      if (!raw.trim()) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        resolve(null);
      }
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

async function hook(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      harness: { type: "string" },
      event: { type: "string" },
      name: { type: "string" },
      cwd: { type: "string" },
    },
  });
  const stdinJson = await readStdinJson();
  if (stdinJson && typeof stdinJson.agent_id === "string" && stdinJson.agent_id.length > 0) {
    return;
  }
  const harness = values.harness || process.env.SWITCHBOARD_HARNESS || "";
  const stdinEvent = stdinJson && typeof stdinJson.hook_event_name === "string" ? stdinJson.hook_event_name : "";
  const event = values.event || stdinEvent || "";
  if (!harness || !event) throw new Error("hook requires --harness and --event");
  if (shouldSkipHookForPrompt(event, stdinJson)) return;
  const home = switchboardHome();
  const info = readDaemonInfo(home);
  if (!info) return;
  const callerName =
    values.name ||
    process.env.SWITCHBOARD_NAME ||
    inferClaudeAgentName() ||
    harness;
  const stdinCwd = stdinJson && typeof stdinJson.cwd === "string" ? stdinJson.cwd : "";
  const cwd = values.cwd || stdinCwd || process.cwd();
  let client: BusClient;
  try {
    client = await connectCli(cwd, callerName);
  } catch {
    return;
  }
  try {
    const frame = await client.request({ type: "inbox" });
    if (frame.type !== "inbox") return;
    const filtered = frame.messages.filter(
      (m) => m.topic !== "presence" && m.fromName !== callerName,
    );
    const stopHookActive = Boolean(stdinJson && stdinJson.stop_hook_active === true);
    process.stdout.write(
      hookStdout(harness, event, filtered, frame.pendingAsk ?? null, stopHookActive),
    );
  } finally {
    client.close();
  }
}

async function connectCli(
  cwd = process.cwd(),
  name = "cli",
  roleArg?: string,
): Promise<BusClient> {
  const { url, token } = await ensureDaemon();
  const role = roleArg === "orchestrator" || process.env.SWITCHBOARD_ROLE === "orchestrator"
    ? ("orchestrator" as const)
    : undefined;
  const hello: ClientHello = {
    type: "hello",
    token,
    name,
    harness: "cli",
    repoKey: repoKey(cwd),
    cwd,
    ...(role ? { role } : {}),
  };
  const client = new BusClient();
  await client.connect(url, hello);
  return client;
}
