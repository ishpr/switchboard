import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { BusClient } from "../src/busClient.ts";
import { startDaemon } from "../src/daemon.ts";
import { formatAgentMetrics } from "../src/status.ts";
import { Store } from "../src/store.ts";
import { ensureToken } from "../src/token.ts";
import type { BusMessage } from "../src/types.ts";

let nextId = 0;
function insert(store: Store, extra: Partial<BusMessage> = {}) {
  return store.insert({ repo: "board", id: `metric-${nextId++}`, topic: "work", fromId: "a", fromName: "agy",
    body: "task", ts: 1000, kind: "ask", correlationId: "correlation-a", to: "eg", ...extra });
}

function seed(store: Store) {
  for (const name of ["grok", "servsys", "pi", "eg", "team", "codex", "muse"]) {
    store.upsertAgent({ repo: "board", name, harness: "grok", cwd: "/work", sessionId: null, wake: false, status: "idle" });
  }
  insert(store);
  insert(store, { kind: "reply", fromName: "eg", to: "agy", ts: 4000 });
  insert(store, { kind: "reply", fromName: "eg", to: "agy", ts: 6000 });
  insert(store, { kind: "reply", fromName: "agy", to: "eg", ts: 7000 });
  insert(store, { correlationId: "correlation-b", ts: 10000 });
  insert(store, { kind: "reply", correlationId: "correlation-b", fromName: "eg", to: "agy", ts: 11000 });
  insert(store, { correlationId: "pending-eg", ts: 20000 });
  insert(store, { correlationId: "pending-muse", to: "muse", ts: 20000 });
  insert(store, { kind: "pub", fromName: "muse", to: "agy", topic: "reports", ts: 30000 });
  insert(store, { repo: "other", kind: "reply", fromName: "muse", to: "agy", ts: 40000 });
}

test("metrics include idle lanes, pending work, all replies, and first assigned replies for latency", () => {
  const store = new Store(":memory:");
  try {
    seed(store);
    const metrics = store.agentMetrics("board");
    assert.deepEqual(metrics.find((m) => m.agent === "eg"), { agent: "eg", asks_received: 3, replies_sent: 3,
      pending_asks_count: 1, avg_reply_latency_seconds: 2, last_reply_at: 11000 });
    assert.deepEqual(metrics.find((m) => m.agent === "muse"), { agent: "muse", asks_received: 1, replies_sent: 0,
      pending_asks_count: 1, avg_reply_latency_seconds: null, last_reply_at: null });
    assert.deepEqual(metrics.find((m) => m.agent === "pi"), { agent: "pi", asks_received: 0, replies_sent: 0,
      pending_asks_count: 0, avg_reply_latency_seconds: null, last_reply_at: null });
    assert.equal(metrics.find((m) => m.agent === "agy")!.replies_sent, 1);
    assert.equal(metrics.length, 8);
    assert.deepEqual(store.agentMetrics("board", "eg"), [metrics.find((m) => m.agent === "eg")]);
    assert.match(formatAgentMetrics(metrics), /agent=eg asks_received=3 replies_sent=3 pending_asks_count=1 avg_reply_latency_seconds=2 last_reply_at=11000/);
    assert.equal(formatAgentMetrics([]), "agent_metrics: none");
  } finally { store.close(); }
});

test("metrics match correlation IDs, ignore other boards and unassigned replies for latency, and count beyond the pending list limit", () => {
  const store = new Store(":memory:");
  try {
    for (let i = 0; i < 60; i++) insert(store, { correlationId: `pending-${i}` });
    assert.equal(store.pendingAsks("board", 1).length, 1);
    assert.equal(store.agentMetrics("board").find((m) => m.agent === "eg")!.pending_asks_count, 60);
    insert(store, { repo: "other", kind: "reply", correlationId: "pending-0" });
    assert.equal(store.agentMetrics("board").find((m) => m.agent === "eg")!.pending_asks_count, 60);
    insert(store, { kind: "reply", correlationId: "pending-0", fromName: "agy", to: "eg", ts: 2000 });
    const eg = store.agentMetrics("board").find((m) => m.agent === "eg")!;
    assert.equal(eg.pending_asks_count, 60);
    assert.equal(eg.avg_reply_latency_seconds, null);
    insert(store, { kind: "reply", correlationId: "pending-1", fromName: "eg", to: "agy", ts: 500 });
    assert.equal(store.agentMetrics("board").find((m) => m.agent === "eg")!.avg_reply_latency_seconds, 0);
    insert(store, { kind: "ask", to: "*", correlationId: "broadcast" });
    assert.equal(store.agentMetrics("board").some((m) => m.agent === "*"), false);
  } finally { store.close(); }
});

test("status wire and CLI return metrics while pending-only output remains filtered", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "metrics-cli-"));
  const token = ensureToken(home);
  const file = path.join(home, "switchboard.db");
  const store = new Store(file);
  seed(store);
  const daemon = await startDaemon({ port: 0, dbFile: file, token, paneProbe: async () => true });
  const worker = new BusClient();
  try {
    writeFileSync(path.join(home, "daemon.json"), JSON.stringify({ port: daemon.port, url: daemon.url }));
    await worker.connect(daemon.url, { type: "hello", token, name: "eg", harness: "grok", repoKey: "board", cwd: "/work" });
    const status = await worker.request({ type: "status" });
    assert.equal(status.type, "ok");
    if (status.type === "ok") assert.deepEqual(status.agent_metrics!.map((m) => m.agent), ["eg"]);
    const exec = promisify(execFile);
    const args = ["--experimental-strip-types", path.resolve("src/cli.ts"), "status"];
    const options = { env: { ...process.env, SWITCHBOARD_HOME: home, SWITCHBOARD_REPO_KEY: "board" } };
    const json = await exec(process.execPath, [...args, "--json"], options);
    const report = JSON.parse(json.stdout);
    assert.equal(report.agent_metrics.length, 8);
    assert.equal(report.agent_metrics.find((m: { agent: string }) => m.agent === "eg").avg_reply_latency_seconds, 2);
    const text = await exec(process.execPath, args, options);
    assert.match(text.stdout, /agent_metrics:/);
    assert.match(text.stdout, /agent=eg asks_received=3 replies_sent=3/);
    const filtered = await exec(process.execPath, [...args, "--pending", "--json"], options);
    assert.deepEqual(Object.keys(JSON.parse(filtered.stdout)), ["pending_asks"]);
  } finally {
    worker.close(); await daemon.close(); store.close(); rmSync(home, { recursive: true, force: true });
  }
});
