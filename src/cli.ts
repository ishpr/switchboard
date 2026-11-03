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
import { BUILD, buildWarning, formatBuild } from "./build.ts";
import { createPaneProbe, formatDiagnostics, sessionDiagnostics } from "./health.ts";
import { Store } from "./store.ts";
import { formatWaitResult, waitForMessages } from "./wait.ts";
import { formatAgentMetrics, formatPendingAsks } from "./status.ts";
import { BusClient } from "./busClient.ts";
import { startDaemon } from "./daemon.ts";
import { ensureDaemon, readDaemonInfo } from "./ensure.ts";
import { hookStdout, shouldSkipHookForPrompt, supportsHookOutput } from "./hook.ts";
import { daemonInfoPath, dbPath, switchboardHome, wakeLogPath } from "./paths.ts";
import { repoKey, type RepoScope } from "./repo.ts";
import { runShim } from "./shim.ts";
import { ensureToken, readToken } from "./token.ts";
import { DEFAULT_PORT, HEARTBEAT_MS, NAME_RE, type ClientHello, type InviteMode, type ReplyState } from "./types.ts";
import { GRID_SESSION, gridPlan, gridSessionName, init, resolveOrchestratorName, writeRepoConfig } from "./init.ts";
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
    case "doctor":
      await who(true);
      break;
    case "who":
      await who();
      break;
    case "publish":
      await publish();
      break;
    case "wait":
      await waitCmd();
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
    case "state":
      await stateCmd();
      break;
    case "orchestrator":
      await orchestratorCmd();
      break;
    case "agent":
      await agent();
      break;
    case "register":
      await registerCmd();
      break;
    case "invite":
      await inviteCmd();
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
  doctor                Diagnose sessions [--prune] [--all | --share | --scope share|split] [--json]
  who                   List agents in this repo
  publish               Publish a message
  inbox                 Print messages since your cursor
  wait                  Wait for new unread messages [--to agent] [--timeout seconds] [--wake-existing] [--json]
  ask                   Ask one agent (may wake a headless CLI)
  reply                 Reply to an ask
  report                Report a result or status to the repo's orchestrator
  status                Show status and pending asks [--pending] [--json] [--limit 1..200] [--status text]
  state                 Read or write shared per-repo key-value state (get | set | list | delete)
  orchestrator          Get or set the orchestrator for this repo
  invite                Invite agent harnesses onto this repo board [--mode terminal|headless]
  register              Register or bind an agent session on this repo board
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

function switchboardSessionLine(session = GRID_SESSION): string | null {
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
  return out.split("\n").find((line) => line.startsWith(`${session} `)) ?? null;
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
  const plan = gridPlan(
    resume,
    switchboardSessionLine(gridSessionName(targetCwd)),
    path.join(homedir(), ".config/zellij/layouts"),
    {
      cwd: targetCwd,
      restart,
    },
  );
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
    build: BUILD,
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

async function who(doctor = false): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      cwd: { type: "string" },
      json: { type: "boolean", default: false },
      ...(doctor ? {
        prune: { type: "boolean" as const, default: false },
        all: { type: "boolean" as const, default: false },
        share: { type: "boolean" as const, default: false },
        scope: { type: "string" as const },
        metadata: { type: "boolean" as const, default: false },
      } : {}),
    },
  });
  if (values.scope && values.scope !== "share" && values.scope !== "split") throw new Error("--scope must be share or split");
  if (values.share && values.scope === "split") throw new Error("--share conflicts with --scope split");
  if (values.all && (values.share || values.scope)) throw new Error("--all cannot be combined with --share or --scope");
  const scope = values.share ? "share" : values.scope as RepoScope | undefined;
  const client = await connectCli(values.cwd || process.cwd(), "cli", undefined, scope);
  try {
    const extended = doctor && (values.prune || values.all);
    const frame = await client.request(extended
      ? { type: "doctor", all: values.all === true, prune: values.prune === true }
      : { type: "who" });
    if (frame.type !== "who" && frame.type !== "doctor") throw new Error("unexpected response");
    const pruned = frame.type === "doctor" ? frame.pruned : [];
    // A newer CLI can diagnose records returned by an already-running older daemon.
    if (doctor) {
      const probe = createPaneProbe();
      await Promise.all(frame.agents.map(async (agent) => {
        agent.diagnostics ??= await sessionDiagnostics(agent, probe);
      }));
    }
    const versionWarning = doctor ? buildWarning(BUILD, frame.daemon) : null;
    if (doctor && (versionWarning || frame.agents.some((agent) => agent.diagnostics?.warnings.length))) process.exitCode = 1;
    if (values.json) {
      process.stdout.write(`${JSON.stringify(values.metadata ? { daemon: frame.daemon ?? null, client: BUILD, warnings: versionWarning ? [versionWarning] : [], agents: frame.agents, pruned } : values.prune ? { agents: frame.agents, pruned } : frame.agents)}\n`);
      return;
    }
    if (doctor) {
      process.stdout.write(`${formatBuild("daemon", frame.daemon)}\n${formatBuild("client", BUILD)}\n`);
      if (versionWarning) process.stdout.write(`WARNING: ${versionWarning}\n`);
    }
    if (frame.agents.length === 0) {
      process.stdout.write(values.all ? "nobody registered on any board\n" : "nobody registered in this repo\n");
      if (values.prune) process.stdout.write("pruned 0 agent(s)\n");
      return;
    }
    for (const agent of frame.agents) {
      const state = agent.online ? "online" : "offline";
      const wake = agent.wake ? "wake" : "no-wake";
      const session = `${agent.sessionId ? ` session=${agent.sessionId}` : ""}${agent.wakeSessionId && agent.wakeSessionId !== agent.sessionId ? ` wake_session=${agent.wakeSessionId}` : ""} connections=${agent.connectionCount ?? (agent.online ? 1 : 0)}`;
      const git = agent.branch || agent.head ? ` git=${agent.branch ?? "detached"}@${agent.head ?? "unknown"}` : "";
      process.stdout.write(
        `${values.all ? `${agent.repo}\t` : ""}${agent.name}\t${agent.harness}\t${state}\t${wake}${session}${git}\t${agent.role}\t${agent.status}\t${formatDiagnostics(agent.diagnostics)}\n`,
      );
    }
    if (values.prune) {
      process.stdout.write(`pruned ${pruned.length} agent(s)\n`);
      for (const agent of pruned) process.stdout.write(`pruned ${agent.repo} ${agent.name} session=${agent.sessionId ?? "none"} reason=${agent.reason}\n`);
    }
  } finally {
    client.close();
  }
}

async function waitCmd(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      to: { type: "string" },
      cwd: { type: "string" },
      timeout: { type: "string", default: "240" },
      "interval-ms": { type: "string", default: "1500" },
      "since-seq": { type: "string" },
      "wake-existing": { type: "boolean", default: false },
      topic: { type: "string" },
      session: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  const to = values.to ?? process.env.SWITCHBOARD_AGENT ?? "agy";
  const cwd = values.cwd || process.cwd();
  const repo = repoKey(cwd);
  const timeoutMs = Number(values.timeout) * 1000;
  const intervalMs = Number(values["interval-ms"]);
  const sinceSeq = values["since-seq"] === undefined ? undefined : Number(values["since-seq"]);
  const cursorKey = values.session && !values.session.startsWith("zellij:") ? `${to}:${values.session}` : to;
  const home = switchboardHome();
  const store = new Store(dbPath(home));
  const waitListeners = new Set<() => void>();
  let waitClient: BusClient | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  try {
    if (timeoutMs > 0 && to !== "*" && NAME_RE.test(to)) {
      const daemonInfo = readDaemonInfo(home);
      if (process.env.SWITCHBOARD_URL || daemonInfo) {
        try {
          const resolveEndpoint = async () =>
            process.env.SWITCHBOARD_URL
              ? { url: process.env.SWITCHBOARD_URL, token: readToken(home) }
              : await ensureDaemon(home);
          const endpoint = await resolveEndpoint();
          const storedAgent = store.getAgent(repo, to);
          const harness = process.env.SWITCHBOARD_HARNESS || storedAgent?.harness || "wait";
          waitClient = new BusClient();
          waitClient.endpointResolver = resolveEndpoint;
          waitClient.onMessage = () => {
            for (const wake of waitListeners) wake();
          };
          await waitClient.connect(endpoint.url, {
            type: "hello",
            token: endpoint.token,
            name: to,
            harness,
            repoKey: repo,
            cwd,
            sessionId: values.session,
            boundSession: Boolean(values.session),
            waitOnly: true,
          });
          if (values.topic && values.topic !== "repo" && values.topic !== "presence") {
            await waitClient.request({ type: "subscribe", topics: [values.topic] });
          }
          heartbeat = setInterval(() => {
            waitClient?.send({ type: "heartbeat" });
          }, HEARTBEAT_MS);
          heartbeat.unref?.();
        } catch {
          waitClient?.close();
          waitClient = null;
        }
      }
    }
    const result = await waitForMessages(store, {
      repo, to, timeoutMs, intervalMs, sinceSeq,
      wakeExisting: values["wake-existing"], cursorKey, topic: values.topic,
    }, {
      onReady: (baseline) => process.stderr.write(`waiting to=${to} since_seq=${baseline} timeout_seconds=${timeoutMs / 1000}\n`),
      subscribeWake: waitClient
        ? (wake) => {
            waitListeners.add(wake);
            return () => waitListeners.delete(wake);
          }
        : undefined,
    });
    process.stdout.write(`${values.json ? JSON.stringify(result) : formatWaitResult(result)}\n`);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    waitClient?.close();
    store.close();
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
      supersedes: { type: "string" },
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
      supersedes: values.supersedes,
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
      state: { type: "string" },
      name: { type: "string" },
      cwd: { type: "string" },
    },
  });
  if (!values.correlation || !values.message) {
    throw new Error("reply requires --correlation and --message");
  }
  const state = values.state as ReplyState | undefined;
  if (state !== undefined && state !== "done" && state !== "progress" && state !== "blocked") {
    throw new Error("--state must be done, progress, or blocked");
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
      state,
    });
    if (frame.type !== "published") throw new Error("unexpected response");
    process.stdout.write(`id=${frame.id}\n${frame.wake.mode}: ${frame.wake.detail}\n`);
  } finally {
    client.close();
  }
}

async function stateCmd(): Promise<void> {
  const action = process.argv[3];
  if (action !== "get" && action !== "set" && action !== "list" && action !== "delete") {
    throw new Error("usage: switchboard state <get|set|list|delete> [--key <k>] [--value <v>] [--prefix <p>] [--if-rev <n>] [--json]");
  }
  const { values } = parseArgs({
    args: process.argv.slice(4),
    options: {
      key: { type: "string" },
      value: { type: "string" },
      prefix: { type: "string" },
      "if-rev": { type: "string" },
      name: { type: "string" },
      cwd: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  const ifRev = values["if-rev"] === undefined ? undefined : Number(values["if-rev"]);
  if (ifRev !== undefined && (!Number.isSafeInteger(ifRev) || ifRev < 0)) {
    throw new Error("--if-rev must be a non-negative integer");
  }
  const client = await connectCli(
    values.cwd || process.cwd(),
    values.name || process.env.SWITCHBOARD_NAME || "cli",
  );
  try {
    const frame = await client.request({
      type: "state",
      action,
      key: values.key,
      value: values.value,
      prefix: values.prefix,
      ifRev,
    });
    if (frame.type !== "state") throw new Error("unexpected response");
    if (frame.conflict) {
      if (values.json) process.stdout.write(`${JSON.stringify(frame)}\n`);
      else process.stderr.write(`${frame.detail || "state revision conflict"}\n`);
      process.exitCode = 1;
      return;
    }
    if (values.json) {
      process.stdout.write(`${JSON.stringify(action === "list" ? frame.entries ?? [] : frame.entry ?? null)}\n`);
      return;
    }
    if (action === "list") {
      const entries = frame.entries ?? [];
      if (entries.length === 0) {
        process.stdout.write("state empty\n");
        return;
      }
      for (const e of entries) {
        process.stdout.write(`${e.key}\trev=${e.rev}\tupdated_by=${e.updatedBy}\tts=${e.ts}\n${e.value}\n\n`);
      }
      return;
    }
    if (action === "delete") {
      process.stdout.write(`${frame.deleted ? `deleted ${values.key}` : `not found ${values.key}`}\n`);
      return;
    }
    if (!frame.entry) {
      process.stdout.write(`not found ${values.key}\n`);
      return;
    }
    const e = frame.entry;
    process.stdout.write(`${e.key}\trev=${e.rev}\tupdated_by=${e.updatedBy}\tts=${e.ts}\n${e.value}\n`);
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
      pending: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      limit: { type: "string" },
    },
  });
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
    throw new Error("--limit must be an integer from 1 to 200");
  }
  const client = await connectCli(
    values.cwd || process.cwd(),
    values.name || process.env.SWITCHBOARD_NAME || "cli",
    values.role,
  );
  try {
    const frame = await client.request({
      type: "status",
      status: values.status,
      pending: values.pending,
      limit,
    });
    if (frame.type !== "ok") throw new Error("unexpected response");
    if (!frame.pending_asks) throw new Error("pending-ask tracking unavailable; restart the daemon after upgrading");
    if (values.json) {
      process.stdout.write(`${JSON.stringify({ ...(values.pending ? {} : { detail: frame.detail, daemon: frame.daemon ?? null, client: BUILD, agent_metrics: frame.agent_metrics ?? [] }), pending_asks: frame.pending_asks })}\n`);
    } else {
      if (!values.pending) process.stdout.write(`${frame.detail}\n${formatBuild("daemon", frame.daemon)}\n${formatBuild("client", BUILD)}${buildWarning(BUILD, frame.daemon) ? `\nWARNING: ${buildWarning(BUILD, frame.daemon)}` : ""}\n`);
      process.stdout.write(`${formatPendingAsks(frame.pending_asks)}\n`);
      if (!values.pending) process.stdout.write(`${formatAgentMetrics(frame.agent_metrics ?? [])}\n`);
    }
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
  if (sub !== "add") throw new Error("usage: switchboard agent add --name <name> --harness <harness> [--session <id>] [--wake-session <id>] [--wake | --no-wake]");
  const { values } = parseArgs({
    args: process.argv.slice(4),
    allowNegative: true,
    options: {
      name: { type: "string" },
      harness: { type: "string" },
      session: { type: "string" },
      "wake-session": { type: "string" },
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
      wakeSessionId: values["wake-session"],
      wake: values.wake ?? true,
    });
    if (frame.type !== "registered") throw new Error("unexpected response");
    process.stdout.write(`registered ${frame.name}\n`);
  } finally {
    client.close();
  }
}

async function registerCmd(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    allowNegative: true,
    options: {
      name: { type: "string" },
      harness: { type: "string" },
      session: { type: "string" },
      "wake-session": { type: "string" },
      cwd: { type: "string" },
      wake: { type: "boolean", default: true },
    },
  });
  const name = values.name || process.env.SWITCHBOARD_NAME;
  const harness = values.harness || process.env.SWITCHBOARD_HARNESS || name;
  if (!name || !harness) {
    throw new Error(
      "usage: switchboard register --name <name> [--harness <harness>] [--session <id>] [--wake-session <id>] [--cwd <dir>]",
    );
  }
  const cwd = values.cwd ? path.resolve(values.cwd) : process.cwd();
  const client = await connectCli(cwd, name);
  try {
    const frame = await client.request({
      type: "register",
      name,
      harness,
      cwd,
      sessionId: values.session,
      wakeSessionId: values["wake-session"],
      wake: values.wake ?? true,
    });
    if (frame.type !== "registered") throw new Error("unexpected response");
    process.stdout.write(
      `registered ${frame.name}${frame.agent?.sessionId ? ` session=${frame.agent.sessionId}` : ""}${frame.agent?.wakeSessionId ? ` wake_session=${frame.agent.wakeSessionId}` : ""}\n`,
    );
  } finally {
    client.close();
  }
}

async function inviteCmd(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(3),
    allowPositionals: true,
    options: {
      mode: { type: "string" },
      orchestrator: { type: "string" },
      cwd: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  const agents = positionals.flatMap((item) => item.split(",")).map((s) => s.trim()).filter(Boolean);
  if (agents.length === 0) {
    throw new Error(
      "usage: switchboard invite <agent...> [--mode terminal|headless] [--orchestrator <name>] [--cwd <dir>] [--json]",
    );
  }
  const mode = (values.mode ?? "terminal") as InviteMode;
  if (mode !== "terminal" && mode !== "headless") {
    throw new Error("invite --mode must be terminal or headless");
  }
  const cwd = values.cwd ? path.resolve(values.cwd) : process.cwd();
  const client = await connectCli(cwd);
  try {
    const frame = await client.request({
      type: "invite",
      agents,
      mode,
      orchestrator: values.orchestrator,
    });
    if (frame.type !== "invited") throw new Error("unexpected response");
    if (values.orchestrator) {
      writeRepoConfig(cwd, { orchestrator: frame.orchestrator ?? values.orchestrator });
    }
    if (values.json) {
      process.stdout.write(`${JSON.stringify(frame, null, 2)}\n`);
      return;
    }
    process.stdout.write(`repo=${frame.repoKey} cwd=${frame.cwd} orchestrator=${frame.orchestrator ?? "none"}\n`);
    for (const item of frame.invited) {
      process.stdout.write(
        `${item.name}\t${item.harness}\t${item.action}\twake=${item.wakeMode}${item.wakeSessionId ? ` wake_session=${item.wakeSessionId}` : ""}\t${item.detail}\n`,
      );
    }
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
  if (!supportsHookOutput(harness, event) || shouldSkipHookForPrompt(event, stdinJson)) return;
  const home = switchboardHome();
  const info = readDaemonInfo(home);
  if (!info) return;
  const callerName =
    values.name ||
    process.env.SWITCHBOARD_NAME ||
    inferClaudeAgentName() ||
    harness;
  const stdinCwd = stdinJson && typeof stdinJson.cwd === "string" ? stdinJson.cwd : "";
  const stdinSessionId =
    stdinJson && typeof stdinJson.session_id === "string" && stdinJson.session_id.trim()
      ? stdinJson.session_id.trim()
      : undefined;
  const cwd = values.cwd || stdinCwd || process.cwd();
  if (!cwd || cwd === "/") return;
  let client: BusClient;
  try {
    client = await connectCli(cwd, callerName, undefined, undefined, stdinSessionId);
  } catch {
    return;
  }
  const nonAckingHook =
    event === "SessionStart" ||
    stdinJson?.source === "compact" ||
    stdinJson?.trigger === "compact";
  try {
    const frame = await client.request({
      type: "inbox",
      ...(nonAckingHook ? { ack: false } : {}),
    });
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
  scope?: RepoScope,
  sessionId?: string,
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
    repoKey: repoKey(cwd, scope),
    cwd,
    ...(role ? { role } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
  const client = new BusClient();
  await client.connect(url, hello);
  return client;
}
