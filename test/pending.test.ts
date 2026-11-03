import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BusClient } from "../src/busClient.ts";
import { startDaemon } from "../src/daemon.ts";
import { formatPendingAsks } from "../src/status.ts";
import { Store } from "../src/store.ts";
import { ensureToken } from "../src/token.ts";
import type { PendingAsk } from "../src/types.ts";

function insert(store: Store, overrides = {}) {
  return store.insert({ repo: "board", id: "ask-id", topic: "work", fromId: "a", fromName: "agy",
    body: "build\n  the feature", ts: 1000, kind: "ask", correlationId: "correlation-id", to: "eg", ...overrides });
}

test("pending asks use reply correlations, preserve workspace isolation, and format bounded previews", () => {
  const store = new Store(":memory:");
  try {
    insert(store);
    assert.deepEqual(store.pendingAsks("board", 50, 4500), [{ id: "ask-id", correlation_id: "correlation-id", seq: 1,
      from: "agy", to: "eg", topic: "work", age_seconds: 3, preview: "build the feature" }]);
    insert(store, { id: "other-board-reply", repo: "other", kind: "reply" });
    insert(store, { id: "wrong-reply", kind: "reply", correlationId: "ask-id" });
    insert(store, { id: "progress", kind: "pub", fromName: "eg", topic: "reports" });
    assert.equal(store.pendingAsks("board").length, 1);
    insert(store, { id: "right-reply", kind: "reply" });
    assert.deepEqual(store.pendingAsks("board"), []);
    insert(store, { id: "long", correlationId: "long-correlation", body: "x".repeat(500), ts: Date.now() + 10000 });
    const pending = store.pendingAsks("board");
    assert.equal(pending[0]!.preview.length, 160);
    assert.equal(pending[0]!.age_seconds, 0);
    assert.match(formatPendingAsks(pending), /id=long correlation_id=long-correlation/);
    assert.equal(formatPendingAsks([]), "pending_asks: none");
  } finally { store.close(); }
});

test("pending asks are newest first, limited, and still visible after a restart", () => {
  const home = mkdtempSync(path.join(tmpdir(), "pending-store-"));
  const file = path.join(home, "bus.db");
  let store = new Store(file);
  try {
    for (let i = 0; i < 205; i++) insert(store, { id: `ask-${i}`, correlationId: `correlation-${i}` });
    assert.equal(store.pendingAsks("board").length, 50);
    assert.equal(store.pendingAsks("board", 1000).length, 200);
    assert.deepEqual(store.pendingAsks("board", 2).map((a) => a.id), ["ask-204", "ask-203"]);
    store.close();
    store = new Store(file);
    assert.equal(store.pendingAsks("board", 1)[0]!.id, "ask-204");
  } finally { store.close(); rmSync(home, { recursive: true, force: true }); }
});

async function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), "pending-wire-"));
  const token = ensureToken(home);
  const store = new Store(path.join(home, "bus.db"));
  const daemon = await startDaemon({ port: 0, dbFile: path.join(home, "bus.db"), token, paneProbe: async () => true });
  writeFileSync(path.join(home, "daemon.json"), JSON.stringify({ port: daemon.port, url: daemon.url }));
  const clients: BusClient[] = [];
  return {
    home, token, store, daemon,
    async join(name: string, repo = "board") {
      const client = new BusClient(); clients.push(client);
      await client.connect(daemon.url, { type: "hello", token, name, harness: "grok", cwd: "/work", repoKey: repo,
        sessionId: `session-${name}`, boundSession: true, wake: false, status: "original",
        ...(name === "agy" ? { role: "orchestrator" as const } : {}) });
      return client;
    },
    async close() {
      for (const client of clients) client.close();
      await daemon.close(); store.close(); rmSync(home, { recursive: true, force: true });
    },
  };
}

test("status tracks multiple in-flight dispatches until their matching replies, without changing read-only status", async () => {
  const fx = await fixture();
  try {
    const agy = await fx.join("agy");
    const eg = await fx.join("eg");
    const muse = await fx.join("muse");
    const other = await fx.join("eg", "other");
    const first = await agy.request({ type: "ask", to: "eg", body: "fix the bug" });
    const second = await agy.request({ type: "ask", to: "muse", body: "add tests" });
    assert.equal(first.type, "published"); assert.equal(second.type, "published");
    if (first.type !== "published" || second.type !== "published") return;
    assert.notEqual(first.id, first.correlationId);
    await eg.request({ type: "inbox" });
    await eg.request({ type: "publish", topic: "reports", body: "working on it" });
    const before = fx.store.getAgent("board", "agy")!;
    const status = await agy.request({ type: "status", pending: true });
    assert.equal(status.type, "ok");
    if (status.type !== "ok") return;
    assert.deepEqual(status.pending_asks!.map((a) => a.id), [second.id, first.id]);
    assert.equal(fx.store.getAgent("board", "agy")!.status, before.status);
    assert.equal(fx.store.getAgent("board", "agy")!.lastSeen, before.lastSeen);
    const egView = await eg.request({ type: "status", pending: true });
    assert.equal(egView.type, "ok");
    if (egView.type === "ok") assert.deepEqual(egView.pending_asks!.map((a) => a.id), [first.id]);
    const unrelated = await fx.join("observer");
    const observerView = await unrelated.request({ type: "status", pending: true });
    assert.equal(observerView.type, "ok");
    if (observerView.type === "ok") assert.deepEqual(observerView.pending_asks, []);
    const isolated = await other.request({ type: "status", pending: true });
    assert.equal(isolated.type, "ok");
    if (isolated.type === "ok") assert.deepEqual(isolated.pending_asks, []);
    await eg.request({ type: "reply", correlationId: first.correlationId!, body: "fixed" });
    assert.deepEqual(fx.store.pendingAsks("board").map((a) => a.id), [second.id]);
    const updated = await agy.request({ type: "status", status: "reviewing" });
    assert.equal(updated.type, "ok");
    if (updated.type === "ok") assert.equal(updated.pending_asks!.length, 1);
    assert.equal(fx.store.getAgent("board", "agy")!.status, "reviewing");
    await muse.request({ type: "reply", correlationId: second.correlationId!, body: "done" });
    const empty = await agy.request({ type: "status", pending: true });
    if (empty.type === "ok") assert.deepEqual(empty.pending_asks, []);
    await assert.rejects(agy.request({ type: "status", limit: 0 }), /limit must/);
    await assert.rejects(agy.request({ type: "status", limit: 201 }), /limit must/);
  } finally { await fx.close(); }
});

test("CLI status supports read-only pending text/JSON, limits and existing status updates", async () => {
  const fx = await fixture();
  const exec = promisify(execFile);
  const cli = path.resolve("src/cli.ts");
  try {
    insert(fx.store);
    insert(fx.store, { id: "ask-two", correlationId: "correlation-two" });
    fx.store.upsertAgent({ repo: "board", name: "agy", harness: "grok", sessionId: null, cwd: "/work", wake: false, status: "original" });
    const opts = { env: { ...process.env, SWITCHBOARD_HOME: fx.home, SWITCHBOARD_NO_AUTOSTART: "1", SWITCHBOARD_REPO_KEY: "board" } };
    const args = ["--experimental-strip-types", cli, "status", "--name", "agy"];
    const text = await exec(process.execPath, [...args, "--pending", "--limit", "1"], opts);
    assert.match(text.stdout, /pending_asks \(most recent 1\)/);
    assert.match(text.stdout, /id=ask-two/);
    assert.doesNotMatch(text.stdout, /health=|status updated/);
    const filtered = await exec(process.execPath, [...args, "--pending", "--json"], opts);
    const json = JSON.parse(filtered.stdout);
    assert.deepEqual(Object.keys(json), ["pending_asks"]);
    assert.equal(json.pending_asks.length, 2);
    assert.equal(fx.store.getAgent("board", "agy")!.status, "original");
    const plain = await exec(process.execPath, args, opts);
    assert.match(plain.stdout, /^status/);
    assert.match(plain.stdout, /pending_asks/);
    const changed = await exec(process.execPath, [...args, "--status", "reviewing", "--json"], opts);
    assert.match(JSON.parse(changed.stdout).detail, /status updated/);
    assert.equal(fx.store.getAgent("board", "agy")!.status, "reviewing");
    await assert.rejects(exec(process.execPath, [...args, "--limit", "1oops"], opts), /--limit must/);
  } finally { await fx.close(); }
});

test("MCP bus_status exposes pending_asks and bus_reply immediately removes the answered correlation", async () => {
  const fx = await fixture();
  const mcp = new Client({ name: "pending-test", version: "1.0" });
  try {
    const agy = await fx.join("agy");
    const asked = await agy.request({ type: "ask", to: "eg", body: "implement pending ask tracking" });
    assert.equal(asked.type, "published");
    if (asked.type !== "published") return;
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ["--experimental-strip-types", path.resolve("src/cli.ts"), "mcp"], stderr: "pipe",
      env: { PATH: process.env.PATH!, SWITCHBOARD_HOME: fx.home, SWITCHBOARD_URL: fx.daemon.url,
        SWITCHBOARD_REPO_KEY: "board", SWITCHBOARD_NAME: "eg", SWITCHBOARD_HARNESS: "codex", SWITCHBOARD_SESSION: "eg-test-thread" } });
    await mcp.connect(transport);
    const status = await mcp.callTool({ name: "bus_status", arguments: { pending: true } });
    assert.equal(status.isError, undefined);
    const pending = status.structuredContent!.pending_asks as PendingAsk[];
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.id, asked.id);
    assert.equal(pending[0]!.correlation_id, asked.correlationId);
    assert.match((status.content[0] as { text: string }).text, /pending_asks/);
    await mcp.callTool({ name: "bus_reply", arguments: { correlationId: asked.correlationId!, message: "implemented" } });
    const cleared = await mcp.callTool({ name: "bus_status", arguments: {} });
    assert.deepEqual(cleared.structuredContent!.pending_asks, []);
  } finally { await mcp.close(); await fx.close(); }
});
