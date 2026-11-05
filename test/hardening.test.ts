import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import WebSocket, { WebSocketServer } from "ws";
import { BUILD, buildWarning } from "../src/build.ts";
import { BusClient } from "../src/busClient.ts";
import { startDaemon, type DaemonOptions } from "../src/daemon.ts";
import { hookStdout, supportsHookOutput } from "../src/hook.ts";
import { inboxCursorKey, Store } from "../src/store.ts";
import { ensureToken } from "../src/token.ts";
import type { BusMessage, ClientHello, ServerFrame } from "../src/types.ts";
import { waitForMessages } from "../src/wait.ts";
import { launchFor, spawnWake } from "../src/wake.ts";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function fixture(options: Partial<DaemonOptions> = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "sb-hardening-"));
  const token = ensureToken(home);
  const dbFile = path.join(home, "switchboard.db");
  const store = new Store(dbFile);
  const daemon = await startDaemon({ port: 0, dbFile, token, paneProbe: async () => true, presenceDebounceMs: 30, ...options });
  writeFileSync(path.join(home, "daemon.json"), JSON.stringify({ port: daemon.port, url: daemon.url }));
  const clients: BusClient[] = [];
  return {
    home, token, store, daemon,
    async join(name: string, extra: Partial<ClientHello> = {}, timeout = 5000) {
      const client = new BusClient({ requestTimeoutMs: timeout }); clients.push(client);
      await client.connect(daemon.url, { type: "hello", token, name, harness: "grok", repoKey: "board", cwd: home, wake: false, ...extra });
      return client;
    },
    async close() { clients.forEach((client) => client.close()); await daemon.close(); store.close(); rmSync(home, { recursive: true, force: true }); },
  };
}

test("async invalid input returns errors and leaves the daemon and other clients usable", async () => {
  const fx = await fixture();
  try {
    const a = await fx.join("a");
    const b = await fx.join("b");
    await assert.rejects(a.request({ type: "reply", correlationId: "unknown", body: "x" }), /no ask/);
    await assert.rejects(a.request({ type: "publish", topic: "bad topic", body: "x" }), /bad topic/);
    await assert.rejects(a.request({ type: "ask", to: "a", body: "x" }), /someone else/);
    await assert.rejects(a.request({ type: "publish", topic: "repo", body: "" }), /empty message/);
    await assert.rejects(a.request({ type: "publish", topic: "repo", to: "", body: "accidental-broadcast" }), /bad name/);
    assert.equal(fx.store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE body = ?").get("accidental-broadcast")!.n, 0);
    assert.equal((await b.request({ type: "who" })).type, "who");
    assert.equal((await a.request({ type: "publish", topic: "repo", body: "still alive" })).type, "published");
  } finally { await fx.close(); }
});

test("request IDs preserve response ownership when a later request completes first", async () => {
  const entered = gate<void>(); const delayed = gate<boolean>();
  const fx = await fixture({ paneProbe: async () => { entered.resolve(); return delayed.promise; } });
  try {
    const a = await fx.join("a");
    await fx.join("pane", { sessionId: "tmux:%1", boundSession: true });
    const slow = a.request({ type: "who" });
    await entered.promise;
    assert.equal((await a.request({ type: "orchestrator" })).type, "orchestrator");
    delayed.resolve(true);
    assert.equal((await slow).type, "who");
  } finally { delayed.resolve(true); await fx.close(); }
});

test("a timed-out tagged response is ignored without poisoning the next request", async () => {
  const entered = gate<void>(); const delayed = gate<boolean>();
  const fx = await fixture({ paneProbe: async () => { entered.resolve(); return delayed.promise; } });
  try {
    const a = await fx.join("a", {}, 150);
    await fx.join("pane", { sessionId: "tmux:%1", boundSession: true });
    const slow = a.request({ type: "who" });
    const rejected = assert.rejects(slow, /bus timeout/);
    await entered.promise; await rejected;
    assert.equal((await a.request({ type: "orchestrator" })).type, "orchestrator");
    delayed.resolve(true);
    assert.equal((await a.request({ type: "status", pending: true })).type, "ok");
    assert.equal((await a.request({ type: "who" })).type, "who");
  } finally { delayed.resolve(true); await fx.close(); }
});

test("new daemon serializes untagged legacy clients", async () => {
  const entered = gate<void>(); const delayed = gate<boolean>();
  const fx = await fixture({ paneProbe: async () => { entered.resolve(); return delayed.promise; } });
  const raw = new WebSocket(fx.daemon.url);
  try {
    await new Promise<void>((resolve) => raw.once("open", resolve));
    const responses: ServerFrame[] = [];
    raw.on("message", (data) => { const frame = JSON.parse(data.toString()); if (frame.type !== "message") responses.push(frame); });
    raw.send(JSON.stringify({ type: "hello", token: fx.token, name: "legacy", harness: "cli", cwd: fx.home, repoKey: "board" }));
    await new Promise<void>((resolve) => raw.once("message", () => resolve()));
    await fx.join("pane", { sessionId: "tmux:%1", boundSession: true });
    raw.send(JSON.stringify({ type: "who" }));
    await entered.promise;
    raw.send(JSON.stringify({ type: "orchestrator" }));
    assert.equal(responses.length, 1);
    delayed.resolve(true);
    while (responses.length < 3) await pause(1);
    assert.deepEqual(responses.map((frame) => frame.type), ["welcome", "who", "orchestrator"]);
    assert.equal(responses.some((frame) => frame.reqId), false);
  } finally { raw.close(); delayed.resolve(true); await fx.close(); }
});

test("new client safely serializes legacy daemons and reconnects after an untagged timeout", async () => {
  const http = createServer(); const wss = new WebSocketServer({ server: http });
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let hellos = 0;
  wss.on("connection", (socket) => socket.on("message", (raw) => {
    const frame = JSON.parse(raw.toString());
    const send = (response: object) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(response)); };
    if (frame.type === "hello") { hellos++; send({ type: "welcome", agentId: "legacy", repoKey: "board", cursor: 0, role: "worker", orchestrator: null }); }
    else if (frame.type === "who" || frame.type === "status") {
      const timer = setTimeout(() => { timers.delete(timer); send(frame.type === "who" ? { type: "who", agents: [] } : { type: "ok", detail: "late" }); }, frame.type === "who" ? 10 : 350);
      timers.add(timer);
    } else send({ type: "orchestrator", orchestrator: "agy" });
  }));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const addr = http.address(); if (!addr || typeof addr === "string") throw new Error("no port");
  const client = new BusClient({ requestTimeoutMs: 150 });
  try {
    await client.connect(`ws://127.0.0.1:${addr.port}`, { type: "hello", token: "x", name: "a", harness: "grok", repoKey: "board", cwd: "/work" });
    const [first, second] = await Promise.all([client.request({ type: "who" }), client.request({ type: "orchestrator" })]);
    assert.equal(first.type, "who"); assert.equal(second.type, "orchestrator");
    await assert.rejects(client.request({ type: "status" }), /bus timeout/);
    assert.equal((await client.request({ type: "orchestrator" })).type, "orchestrator");
    assert.equal(hellos, 2);
  } finally {
    client.close(); for (const timer of timers) clearTimeout(timer);
    wss.clients.forEach((socket) => socket.terminate());
    await new Promise<void>((resolve) => wss.close(() => http.close(() => resolve())));
  }
});

test("directed repo/dm/reports messages never reach unrelated subscribers or report readers", async () => {
  const fx = await fixture();
  try {
    const agy = await fx.join("agy", { role: "orchestrator" });
    const eg = await fx.join("eg"); const observer = await fx.join("observer");
    const leaked: BusMessage[] = []; observer.onMessage = ({ message }) => { if (message.topic !== "presence") leaked.push(message); };
    await observer.request({ type: "subscribe", topics: ["dm", "reports"] });
    await agy.request({ type: "publish", topic: "repo", to: "eg", body: "private repo" });
    await agy.request({ type: "ask", to: "eg", body: "private dm" });
    await eg.request({ type: "report", body: "private report" });
    await observer.request({ type: "who" });
    assert.deepEqual(leaked, []);
    const reports = await observer.request({ type: "inbox", topic: "reports" });
    if (reports.type !== "inbox") throw new Error("wrong response");
    assert.deepEqual(reports.messages, []);
    await agy.request({ type: "publish", topic: "repo", to: "*", body: "public" });
    await observer.request({ type: "who" });
    assert.deepEqual(leaked.map((message) => message.body), ["public"]);
  } finally { await fx.close(); }
});

test("topic cursors are independent and filtered reads cannot skip other unread work", async () => {
  const fx = await fixture();
  try {
    const a = await fx.join("a"); const b = await fx.join("b");
    await a.request({ type: "publish", topic: "dm", to: "b", body: "keep DM" });
    await a.request({ type: "publish", topic: "reports", to: "b", body: "report" });
    const filtered = await b.request({ type: "inbox", topic: "reports" });
    if (filtered.type !== "inbox") throw new Error("wrong response");
    assert.deepEqual(filtered.messages.map((message) => message.body), ["report"]);
    assert.equal(fx.store.cursor("board", "b"), 0);
    assert.ok(fx.store.cursor("board", inboxCursorKey("b", "reports")) > 0);
    const repeated = await b.request({ type: "inbox", topic: "reports" });
    if (repeated.type === "inbox") assert.deepEqual(repeated.messages, []);
    const normal = await b.request({ type: "inbox" });
    if (normal.type !== "inbox") throw new Error("wrong response");
    assert.ok(normal.messages.some((message) => message.body === "keep DM"));
    assert.equal(normal.messages.some((message) => message.topic === "presence"), false);
    const presence = await b.request({ type: "inbox", topic: "presence" });
    if (presence.type === "inbox") assert.ok(presence.messages.length > 0);
  } finally { await fx.close(); }
});

test("only assigned-recipient replies close obligations; progress, sender follow-ups and outsiders do not", async () => {
  const fx = await fixture();
  try {
    const agy = await fx.join("agy", { role: "orchestrator" }); const eg = await fx.join("eg"); const observer = await fx.join("observer");
    const ask = await agy.request({ type: "ask", to: "eg", body: "task" });
    if (ask.type !== "published") throw new Error("wrong response");
    fx.store.db.prepare("UPDATE messages SET ts = ? WHERE id = ?").run(Date.now() - 2 * 60 * 60_000, ask.id);
    await eg.request({ type: "inbox" });
    await eg.request({ type: "report", body: "still working" });
    await agy.request({ type: "reply", correlationId: ask.correlationId!, body: "please continue" });
    await assert.rejects(observer.request({ type: "reply", correlationId: ask.correlationId!, body: "fake" }), /participants/);
    assert.equal(fx.store.pendingAsks("board").length, 1);
    assert.equal(fx.store.agentMetrics("board", "eg")[0]!.pending_asks_count, 1);
    const pending = await eg.request({ type: "inbox" });
    if (pending.type !== "inbox") throw new Error("wrong response");
    assert.ok(pending.pendingAsk);
    assert.equal(JSON.parse(hookStdout("claude", "Stop", [], pending.pendingAsk)).decision, "block");
    await eg.request({ type: "reply", correlationId: ask.correlationId!, body: "done" });
    assert.deepEqual(fx.store.pendingAsks("board"), []);
    const completed = await eg.request({ type: "inbox" });
    if (completed.type === "inbox") assert.equal(completed.pendingAsk, null);
  } finally { await fx.close(); }
});

test("wake reservation prevents concurrent launches and rolls back on failed injection", async () => {
  const entered = gate<void>(); const launch = gate<void>(); let count = 0;
  const fx = await fixture({ spawnWake: async () => { count++; if (count === 1) { entered.resolve(); await launch.promise; } } });
  try {
    const a = await fx.join("a"); const b = await fx.join("b");
    await a.request({ type: "register", name: "offline", harness: "grok", cwd: fx.home, wake: true });
    const first = a.request({ type: "ask", to: "offline", body: "one" });
    await entered.promise;
    const second = await b.request({ type: "ask", to: "offline", body: "two" });
    assert.equal(count, 1);
    if (second.type === "published") assert.equal(second.wake.mode, "skip");
    launch.reject(new Error("fake injection failure"));
    const failed = await first;
    if (failed.type === "published") assert.match(failed.wake.detail, /wake failed/);
    const retry = await a.request({ type: "ask", to: "offline", body: "retry" });
    if (retry.type === "published") assert.equal(retry.wake.mode, "headless");
    assert.equal(count, 2);
  } finally { launch.resolve(); await fx.close(); }
});

test("short injection commands check exit status and timeout without running or killing a live pane", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "sb-injection-"));
  try {
    const spawn = spawnWake(path.join(home, "wake.log"), { injectionTimeoutMs: 1000 });
    const base = { cmd: process.execPath, cwd: home, completion: "exit" as const };
    await spawn({ ...base, args: ["-e", "process.exit(0)"] });
    await spawn({ ...base, stdin: "payload", args: ["-e", "process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"] });
    await assert.rejects(spawn({ ...base, args: ["-e", "process.exit(7)"] }), /exited with 7/);
    await assert.rejects(spawnWake(path.join(home, "wake.log"), { injectionTimeoutMs: 100 })({ ...base, args: ["-e", "setInterval(()=>{},1000)"] }), /timed out/);
    await spawn({ ...base, completion: "spawn", args: ["-e", "process.exit(7)"] });
    const message: BusMessage = { repo: "board", id: "x", seq: 1, fromId: "a", fromName: "agy", topic: "dm", body: "test", ts: 0, kind: "ask", correlationId: "c", to: "eg" };
    for (const sessionId of ["tmux:%12", "zellij:qa:5"]) assert.equal(launchFor({ mode: "inject", harness: "grok", cwd: home, sessionId, message })!.completion, "exit");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("unsupported hooks leave cursors untouched, supported hooks still attach and consume", async () => {
  const fx = await fixture();
  const cli = path.resolve("src/cli.ts");
  const run = (harness: string, event: string) => new Promise<string>((resolve, reject) => {
    const child = execFile(process.execPath, ["--experimental-strip-types", cli, "hook", "--harness", harness, "--event", event, "--name", "receiver"],
      { env: { ...process.env, SWITCHBOARD_HOME: fx.home, SWITCHBOARD_REPO_KEY: "board" } }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin!.end("{}");
  });
  try {
    const a = await fx.join("a"); await a.request({ type: "publish", topic: "dm", to: "receiver", body: "keep this" });
    for (const [harness, event] of [["kimi", "UserPromptSubmit"], ["grok", "PostToolUse"], ["cursor", "Stop"]]) {
      assert.equal(supportsHookOutput(harness!, event!), false);
      assert.equal(await run(harness!, event!), ""); assert.equal(fx.store.cursor("board", "receiver"), 0);
    }
    assert.match(await run("claude", "PostToolUse"), /keep this/);
    assert.ok(fx.store.cursor("board", "hook:receiver") > 0);
    assert.equal(fx.store.cursor("board", "receiver"), 0);
    assert.equal(await run("claude", "PostToolUse"), "");
    assert.equal(await run("claude", "Stop"), "");
    assert.ok(fx.store.cursor("board", "receiver") > 0);
  } finally { await fx.close(); }
});

test("presence is opt-in, duplicate connections coalesce, and brief reconnects do not flap", async () => {
  const fx = await fixture({ presenceDebounceMs: 50 });
  try {
    const observer = await fx.join("observer", { harness: "cli" });
    const first = await fx.join("codex", { sessionId: "zellij:qa:5", boundSession: true });
    const second = await fx.join("codex", { sessionId: "zellij:qa:5", boundSession: true });
    const who = await observer.request({ type: "who" });
    if (who.type !== "who") throw new Error("wrong response");
    const rows = who.agents.filter((row) => row.name === "codex");
    assert.equal(rows.length, 1); assert.equal(rows[0]!.connectionCount, 2);
    await first.request({ type: "status", status: "working" });
    second.send({ type: "heartbeat" });
    const updated = await observer.request({ type: "who" });
    if (updated.type === "who") assert.equal(updated.agents.find((agent) => agent.name === "codex")!.status, "working");
    assert.equal((await waitForMessages(fx.store, { repo: "board", to: "observer", wakeExisting: true, timeoutMs: 0 })).status, "TIMEOUT");
    assert.equal((await waitForMessages(fx.store, { repo: "board", to: "observer", topic: "presence", wakeExisting: true, timeoutMs: 0 })).messages.length, 1);
    const normal = await observer.request({ type: "inbox" }); if (normal.type === "inbox") assert.deepEqual(normal.messages, []);
    first.close(); await pause(15);
    second.close(); await pause(10);
    const reconnected = await fx.join("codex", { sessionId: "zellij:qa:5", boundSession: true });
    await pause(70);
    const during = fx.store.inbox("board", 0, { to: "observer", topic: "presence", limit: 200 });
    assert.deepEqual(during.map((message) => message.body.split(" ")[0]), ["online"]);
    reconnected.close(); await pause(90);
    const after = fx.store.inbox("board", 0, { to: "observer", topic: "presence", limit: 200 });
    assert.deepEqual(after.map((message) => message.body.split(" ")[0]), ["online", "offline"]);
  } finally { await fx.close(); }
});

test("unbound clients never replace registered wake metadata or masquerade as a pane", async () => {
  const fx = await fixture({ paneProbe: async () => false });
  try {
    const observer = await fx.join("observer", { harness: "cli" });
    await observer.request({ type: "register", name: "codex", harness: "codex", cwd: "/registered", sessionId: "zellij:qa:5", wake: true });
    await fx.join("codex", { harness: "desktop", cwd: "/other", wake: false });
    await fx.join("codex", { harness: "desktop", cwd: "/other", wake: false });
    const stored = fx.store.getAgent("board", "codex")!;
    assert.equal(stored.sessionId, "zellij:qa:5"); assert.equal(stored.harness, "codex"); assert.equal(stored.cwd, "/registered"); assert.equal(stored.wake, true);
    const who = await observer.request({ type: "who" });
    if (who.type !== "who") throw new Error("wrong response");
    const row = who.agents.find((agent) => agent.name === "codex")!;
    assert.equal(row.sessionId, null); assert.equal(row.wakeSessionId, "zellij:qa:5"); assert.equal(row.connectionCount, 2);
    assert.equal(row.diagnostics!.health, "dead_pane");
    const pruned = await observer.request({ type: "doctor", prune: true });
    if (pruned.type !== "doctor") throw new Error("wrong response");
    assert.equal(pruned.pruned[0]!.sessionId, "zellij:qa:5");
    assert.equal(fx.store.getAgent("board", "codex")!.sessionId, null);
    await fx.join("codex", { sessionId: "native-thread", boundSession: true });
    const distinct = await observer.request({ type: "who" });
    if (distinct.type === "who") assert.equal(distinct.agents.filter((agent) => agent.name === "codex").length, 2);
  } finally { await fx.close(); }
});

test("status and doctor expose build metadata and distinguish an out-of-date connected shim", async () => {
  const fx = await fixture();
  try {
    const a = await fx.join("a");
    await fx.join("old-shim", { wake: true, build: { ...BUILD, version: "0.1.0" } });
    const status = await a.request({ type: "status" });
    if (status.type !== "ok") throw new Error("wrong response");
    assert.equal(status.daemon!.version, "0.2.0"); assert.equal(status.daemon!.protocol_version, 2); assert.equal(status.daemon!.pid, process.pid);
    const exec = promisify(execFile);
    const args = ["--experimental-strip-types", path.resolve("src/cli.ts"), "doctor", "--metadata", "--json"];
    await assert.rejects(exec(process.execPath, args, { env: { ...process.env, SWITCHBOARD_HOME: fx.home, SWITCHBOARD_REPO_KEY: "board" } }), (error: any) => {
      const report = JSON.parse(error.stdout);
      assert.equal(report.daemon.version, "0.2.0"); assert.equal(report.client.protocol_version, 2);
      assert.match(report.agents.find((agent: { name: string }) => agent.name === "old-shim").diagnostics.warnings.join(), /build mismatch/);
      return true;
    });
    assert.match(buildWarning(BUILD)!, /metadata unavailable/);
    assert.equal(buildWarning(BUILD, BUILD), null);
  } finally { await fx.close(); }
});

test("seven lanes round-trip concurrent asks/replies with independently correlated status requests", async () => {
  const fx = await fixture();
  try {
    const agy = await fx.join("agy", { role: "orchestrator" });
    const names = ["grok", "servsys", "pi", "eg", "team", "codex", "muse"];
    const workers = await Promise.all(names.map((name) => fx.join(name)));
    const asks = await Promise.all(names.flatMap((name) => Array.from({ length: 50 }, (_, i) => agy.request({ type: "ask", to: name, body: `task ${i}` }))));
    assert.equal(asks.filter((frame) => frame.type === "published").length, 350);
    let delivered = 0;
    const all = await Promise.all(workers.map(async (worker) => {
      const received: BusMessage[] = [];
      let more = true;
      while (more) {
        const page = await worker.request({ type: "inbox" });
        if (page.type !== "inbox") throw new Error("wrong response");
        received.push(...page.messages.filter((message) => message.kind === "ask")); more = page.more;
      }
      assert.equal(received.length, 50); delivered += received.length;
      return Promise.all(received.map((message) => worker.request({ type: "reply", correlationId: message.correlationId!, body: "done" })));
    }));
    assert.equal(delivered, 350);
    assert.equal(all.flat().filter((frame) => frame.type === "published").length, 350);
    const [who, status, inbox] = await Promise.all([agy.request({ type: "who" }), agy.request({ type: "status" }), agy.request({ type: "inbox" })]);
    assert.equal(who.type, "who"); assert.equal(status.type, "ok"); assert.equal(inbox.type, "inbox");
    assert.deepEqual(fx.store.pendingAsks("board", 200), []);
    for (const row of fx.store.agentMetrics("board").filter((row) => names.includes(row.agent))) {
      assert.equal(row.asks_received, 50); assert.equal(row.replies_sent, 50); assert.equal(row.pending_asks_count, 0);
    }
  } finally { await fx.close(); }
});
