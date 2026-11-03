import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BusClient } from "../src/busClient.ts";
import { startDaemon } from "../src/daemon.ts";
import { Store } from "../src/store.ts";
import { ensureToken } from "../src/token.ts";
import { waitForMessages } from "../src/wait.ts";
import type { AgentMetrics } from "../src/types.ts";

async function fixture(name: "agy" | "eg") {
  const home = mkdtempSync(path.join(tmpdir(), "mcp-wait-"));
  const token = ensureToken(home);
  const file = path.join(home, "switchboard.db");
  const store = new Store(file);
  store.setOrchestrator("board", "agy");
  const daemon = await startDaemon({ port: 0, dbFile: file, token, paneProbe: async () => true });
  const sender = new BusClient();
  await sender.connect(daemon.url, { type: "hello", token, name: "muse", harness: "grok", cwd: "/work", repoKey: "board", wake: false });
  const mcp = new Client({ name: "wait-test", version: "1.0" });
  await mcp.connect(new StdioClientTransport({ command: process.execPath,
    args: ["--experimental-strip-types", path.resolve("src/cli.ts"), "mcp"], stderr: "pipe",
    env: { PATH: process.env.PATH!, SWITCHBOARD_HOME: home, SWITCHBOARD_URL: daemon.url,
      SWITCHBOARD_REPO_KEY: "board", SWITCHBOARD_NAME: name, SWITCHBOARD_HARNESS: "grok", SWITCHBOARD_SESSION: `${name}-thread` } }));
  const cursorKey = `${name}:${name}-thread`;
  const baseline = store.latestUnreadSeq("board", name, cursorKey);
  store.ack("board", cursorKey, baseline);
  return { store, mcp, sender, cursorKey, baseline,
    async close() { await mcp.close(); sender.close(); await daemon.close(); store.close(); rmSync(home, { recursive: true, force: true }); },
  };
}

test("bus_wait wakes natively without consuming the caller's session inbox; bus_status exposes metrics", async () => {
  const fx = await fixture("agy");
  try {
    const waiting = fx.mcp.callTool({ name: "bus_wait", arguments: { timeout_seconds: 3, interval_ms: 10, since_seq: fx.baseline } });
    await fx.sender.request({ type: "publish", topic: "work", to: "agy", body: "new result" });
    const result = await waiting;
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent!.status, "MESSAGES");
    assert.equal((result.structuredContent!.messages as { preview: string }[])[0]!.preview, "new result");
    assert.equal(fx.store.cursor("board", fx.cursorKey), fx.baseline);
    const inbox = await fx.mcp.callTool({ name: "bus_inbox", arguments: {} });
    assert.match((inbox.content[0] as { text: string }).text, /new result/);
    assert.ok(fx.store.cursor("board", fx.cursorKey) > fx.baseline);
    const asked = await fx.mcp.callTool({ name: "bus_ask", arguments: { agent: "muse", question: "complete this" } });
    assert.equal(asked.isError, undefined);
    const correlation = /correlation=([^\s]+)/.exec((asked.content[0] as { text: string }).text)![1]!;
    await fx.sender.request({ type: "reply", correlationId: correlation, body: "done" });
    const status = await fx.mcp.callTool({ name: "bus_status", arguments: {} });
    const metrics = status.structuredContent!.agent_metrics as AgentMetrics[];
    const muse = metrics.find((m) => m.agent === "muse")!;
    assert.equal(muse.asks_received, 1);
    assert.equal(muse.replies_sent, 1);
    assert.equal(muse.pending_asks_count, 0);
    assert.ok(muse.avg_reply_latency_seconds! >= 0);
    assert.match((status.content[0] as { text: string }).text, /agent_metrics:/);
    assert.match((status.content[0] as { text: string }).text, /agent=muse asks_received=1 replies_sent=1/);
    const controller = new AbortController();
    const cancelled = fx.mcp.callTool({ name: "bus_wait", arguments: { timeout_seconds: 120, interval_ms: 60_000 } }, undefined, { signal: controller.signal, timeout: 130_000 });
    // A second tool call completes while the wait is sleeping, then cancellation stops that wait.
    await fx.mcp.callTool({ name: "bus_status", arguments: { pending: true } });
    controller.abort();
    await assert.rejects(cancelled);
    const other = await fx.mcp.callTool({ name: "bus_wait", arguments: { to: "muse", timeout_seconds: 1, wake_existing: true } });
    assert.equal(other.structuredContent!.status, "MESSAGES");
  } finally { await fx.close(); }
});

test("bus_wait validates bounds, supports timeout/existing mail, and protects other recipients", async () => {
  const fx = await fixture("eg");
  try {
    const tools = await fx.mcp.listTools();
    const wait = tools.tools.find((tool) => tool.name === "bus_wait")!;
    assert.ok(wait);
    const empty = await fx.mcp.callTool({ name: "bus_inbox", arguments: {} });
    assert.equal((empty.content[0] as { text: string }).text, "inbox empty");
    const lifecycle = await fx.mcp.callTool({ name: "bus_wait", arguments: { topic: "presence", wake_existing: true, timeout_seconds: 1 } });
    assert.equal(lifecycle.structuredContent!.status, "MESSAGES");
    assert.ok((lifecycle.structuredContent!.messages as { topic: string }[]).every((message) => message.topic === "presence"));
    const properties = wait.inputSchema.properties as Record<string, { minimum?: number; maximum?: number }>;
    assert.equal(properties.timeout_seconds!.minimum, 1);
    assert.equal(properties.timeout_seconds!.maximum, 120);
    for (const args of [{ timeout_seconds: 0 }, { timeout_seconds: 121 }, { interval_ms: 0 }, { since_seq: -1 }]) {
      const invalid = await fx.mcp.callTool({ name: "bus_wait", arguments: args });
      assert.equal(invalid.isError, true);
    }
    const denied = await fx.mcp.callTool({ name: "bus_wait", arguments: { to: "agy", timeout_seconds: 1 } });
    assert.equal(denied.isError, true);
    await fx.sender.request({ type: "publish", topic: "work", to: "eg", body: "already unread" });
    const existing = await fx.mcp.callTool({ name: "bus_wait", arguments: { wake_existing: true, timeout_seconds: 1 } });
    assert.equal(existing.structuredContent!.status, "MESSAGES");
    assert.equal(fx.store.cursor("board", fx.cursorKey), fx.baseline);
    // Default startup baseline skips that existing unread message.
    const timeout = await fx.mcp.callTool({ name: "bus_wait", arguments: { timeout_seconds: 1, interval_ms: 100 } });
    assert.equal(timeout.structuredContent!.status, "TIMEOUT");
    assert.deepEqual(timeout.structuredContent!.messages, []);
    const status = await fx.mcp.callTool({ name: "bus_status", arguments: {} });
    assert.deepEqual((status.structuredContent!.agent_metrics as AgentMetrics[]).map((m) => m.agent), ["eg"]);
    await fx.sender.request({ type: "publish", topic: "repo", body: "broadcast" });
    const broadcast = await fx.mcp.callTool({ name: "bus_wait", arguments: { to: "*", timeout_seconds: 1, wake_existing: true } });
    assert.equal(broadcast.structuredContent!.status, "MESSAGES");
  } finally { await fx.close(); }
});

test("wait cancellation interrupts a long polling sleep", async () => {
  const store = new Store(":memory:");
  try {
    const controller = new AbortController();
    const pending = waitForMessages(store, { repo: "board", to: "agy", intervalMs: 60_000, timeoutMs: 120_000, signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    await assert.rejects(waitForMessages(store, { repo: "board", to: "agy", signal: controller.signal }), { name: "AbortError" });
  } finally { store.close(); }
});
