import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { BusClient } from "../src/busClient.ts";
import { startDaemon } from "../src/daemon.ts";
import { Store } from "../src/store.ts";
import { ensureToken } from "../src/token.ts";
import { formatWaitResult, waitForMessages } from "../src/wait.ts";
import type { BusMessage } from "../src/types.ts";

let nextId = 0;
function insert(store: Store, extra: Partial<BusMessage> = {}) {
  return store.insert({ repo: "board", id: `m-${nextId++}`, topic: "dm", fromId: "worker", fromName: "eg",
    body: "a\n  new result", ts: Date.now(), kind: "pub", correlationId: null, to: "agy", ...extra });
}

test("wait-existing reads only unread recipient/broadcast messages and never acks", async () => {
  const store = new Store(":memory:");
  try {
    const read = insert(store);
    store.ack("board", "agy", read.seq);
    insert(store, { to: "other" });
    insert(store, { repo: "other" });
    const direct = insert(store, { kind: "reply", correlationId: "corr" });
    const broadcast = insert(store, { to: null });
    const star = insert(store, { to: "*" });
    const result = await waitForMessages(store, { repo: "board", to: "agy", wakeExisting: true, timeoutMs: 0 });
    assert.equal(result.status, "MESSAGES");
    assert.deepEqual(result.messages.map((m) => m.seq), [direct.seq, broadcast.seq, star.seq]);
    assert.equal(result.messages[0]!.correlation_id, "corr");
    assert.equal(result.messages[0]!.preview, "a new result");
    assert.equal(result.messages[1]!.to, "*");
    assert.equal(store.cursor("board", "agy"), read.seq);
    const broadcastOnly = await waitForMessages(store, { repo: "board", to: "*", wakeExisting: true, timeoutMs: 0 });
    assert.deepEqual(broadcastOnly.messages.map((m) => m.seq), [broadcast.seq, star.seq]);
  } finally { store.close(); }
});

test("default baseline skips existing unread and wakes for a new matching message", async () => {
  const store = new Store(":memory:");
  let now = 0;
  let sleeps = 0;
  try {
    const old = insert(store);
    insert(store, { to: "someone-else" });
    const result = await waitForMessages(store, { repo: "board", to: "agy", timeoutMs: 5000 }, {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
        sleeps++;
        insert(store, sleeps === 1 ? { to: "someone-else" } : { to: "agy", body: "new" });
      },
    });
    assert.equal(result.since_seq, old.seq);
    assert.equal(sleeps, 2);
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0]!.preview, "new");
    assert.equal(store.cursor("board", "agy"), 0);
  } finally { store.close(); }
});

test("timeout uses the remaining deadline and returns TIMEOUT without advancing cursors", async () => {
  const store = new Store(":memory:");
  let now = 0;
  const sleeps: number[] = [];
  try {
    insert(store);
    const result = await waitForMessages(store, { repo: "board", to: "agy", timeoutMs: 2500 }, {
      now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; },
    });
    assert.deepEqual(sleeps, [1500, 1000]);
    assert.equal(result.status, "TIMEOUT");
    assert.equal(formatWaitResult(result), "TIMEOUT");
    assert.equal(store.cursor("board", "agy"), 0);
  } finally { store.close(); }
});

test("explicit baseline overrides wake-existing, honors cursor changes and supports session cursors", async () => {
  const store = new Store(":memory:");
  try {
    const old = insert(store);
    const newer = insert(store, { body: "x".repeat(300) });
    const result = await waitForMessages(store, { repo: "board", to: "agy", sinceSeq: old.seq, wakeExisting: true, timeoutMs: 0 });
    assert.deepEqual(result.messages.map((m) => m.seq), [newer.seq]);
    assert.equal(result.messages[0]!.preview.length, 160);
    store.ack("board", "agy:thread", newer.seq);
    assert.equal((await waitForMessages(store, { repo: "board", to: "agy", cursorKey: "agy:thread", sinceSeq: 0, timeoutMs: 0 })).status, "TIMEOUT");
    let now = 0;
    const consumed = await waitForMessages(store, { repo: "board", to: "agy", timeoutMs: 10, intervalMs: 10 }, {
      now: () => now,
      sleep: async (ms) => { const message = insert(store); store.ack("board", "agy", message.seq); now += ms; },
    });
    assert.equal(consumed.status, "TIMEOUT");
  } finally { store.close(); }
});

test("wait rejects invalid polling parameters", async () => {
  const store = new Store(":memory:");
  try {
    for (const extra of [
      { timeoutMs: -1 }, { timeoutMs: NaN }, { timeoutMs: Infinity }, { intervalMs: 0 }, { intervalMs: 1.5 },
      { intervalMs: Infinity }, { sinceSeq: -1 }, { sinceSeq: 1.5 }, { sinceSeq: Number.MAX_SAFE_INTEGER + 1 }, { to: "invalid name" },
    ]) await assert.rejects(waitForMessages(store, { repo: "board", to: "agy", ...extra }), /--to|--timeout|--interval-ms|--since-seq/);
  } finally { store.close(); }
});

const cli = path.resolve("src/cli.ts");
function launchWait(home: string, args: string[] = [], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, ["--experimental-strip-types", cli, "wait", "--timeout", "3", "--interval-ms", "10", ...args], {
    env: { ...process.env, SWITCHBOARD_HOME: home, SWITCHBOARD_REPO_KEY: "board", SWITCHBOARD_AGENT: "agy", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // Prevent an early process failure from becoming an unhandled rejection in callers using only done.
  void ready.catch(() => {});
  child.stderr.on("data", (chunk) => { stderr += chunk; if (stderr.includes("waiting to=")) readyResolve(); });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", (error) => { readyReject(error); reject(error); });
    child.once("close", (code) => {
      if (!stderr.includes("waiting to=")) readyReject(new Error(stderr));
      resolve({ code, stdout, stderr });
    });
  });
  return { child, ready, done };
}

async function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), "wait-cli-"));
  const token = ensureToken(home);
  const dbFile = path.join(home, "switchboard.db");
  const store = new Store(dbFile);
  const daemon = await startDaemon({ port: 0, dbFile, token, paneProbe: async () => true });
  const clients: BusClient[] = [];
  return {
    home, store, url: daemon.url,
    async join(name: string) {
      const client = new BusClient(); clients.push(client);
      await client.connect(daemon.url, { type: "hello", token, name, harness: "grok", cwd: "/work", repoKey: "board", wake: false });
      return client;
    },
    async close() {
      for (const client of clients) client.close();
      await daemon.close(); store.close(); rmSync(home, { recursive: true, force: true });
    },
  };
}

test("CLI wait wakes on a newly published message and bus_inbox can still consume it", async () => {
  const fx = await fixture();
  let pending: ReturnType<typeof launchWait> | undefined;
  try {
    const sender = await fx.join("eg");
    const agy = await fx.join("agy");
    const old = insert(fx.store, { body: "old unread" });
    pending = launchWait(fx.home, ["--to", "agy", "--json"]);
    await pending.ready;
    const published = await sender.request({ type: "publish", topic: "work", body: "new message", to: "agy" });
    assert.equal(published.type, "published");
    const result = await pending.done;
    assert.equal(result.code, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.status, "MESSAGES");
    assert.equal(json.since_seq, old.seq);
    assert.equal(json.messages.length, 1);
    assert.equal(json.messages[0].preview, "new message");
    assert.equal(fx.store.cursor("board", "agy"), 0);
    const inbox = await agy.request({ type: "inbox" });
    assert.equal(inbox.type, "inbox");
    if (inbox.type === "inbox") assert.ok(inbox.messages.some((message) => message.body === "new message"));
  } finally { pending?.child.kill(); await pending?.done; await fx.close(); }
});

test("CLI wait wakes on bus_reply with the correct correlation summary", async () => {
  const fx = await fixture();
  let pending: ReturnType<typeof launchWait> | undefined;
  try {
    const agy = await fx.join("agy");
    const eg = await fx.join("eg");
    const asked = await agy.request({ type: "ask", to: "eg", body: "do work" });
    assert.equal(asked.type, "published");
    if (asked.type !== "published") return;
    pending = launchWait(fx.home, ["--json"]);
    await pending.ready;
    await eg.request({ type: "reply", correlationId: asked.correlationId!, body: "finished" });
    const result = await pending.done;
    assert.equal(result.code, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.messages[0].kind, "reply");
    assert.equal(json.messages[0].correlation_id, asked.correlationId);
    assert.equal(json.messages[0].from, "eg");
    assert.equal(fx.store.cursor("board", "agy"), 0);
  } finally { pending?.child.kill(); await pending?.done; await fx.close(); }
});

test("CLI wait supports existing unread, explicit since-seq, recipient defaults and timeout success", async () => {
  const fx = await fixture();
  const exec = promisify(execFile);
  try {
    const old = insert(fx.store, { to: "custom" });
    const env = { ...process.env, SWITCHBOARD_HOME: fx.home, SWITCHBOARD_REPO_KEY: "board", SWITCHBOARD_AGENT: "custom" };
    const args = ["--experimental-strip-types", cli, "wait", "--wake-existing", "--timeout", "0"];
    const existing = await exec(process.execPath, [...args, "--json"], { env });
    assert.equal(JSON.parse(existing.stdout).messages[0].seq, old.seq);
    const text = await exec(process.execPath, args, { env });
    assert.match(text.stdout, /from=eg to=custom topic=dm kind=pub/);
    const explicit = await exec(process.execPath, [...args, "--since-seq", String(old.seq)], { env });
    assert.equal(explicit.stdout, "TIMEOUT\n");
    const timed = await exec(process.execPath, ["--experimental-strip-types", cli, "wait", "--to", "agy", "--timeout", "0.025", "--interval-ms", "1000", "--json"], { env });
    assert.equal(JSON.parse(timed.stdout).status, "TIMEOUT");
    assert.equal(fx.store.cursor("board", "custom"), 0);
    fx.store.ack("board", "custom:thread", old.seq);
    const session = await exec(process.execPath, [...args, "--session", "thread"], { env });
    assert.equal(session.stdout, "TIMEOUT\n");
    await assert.rejects(exec(process.execPath, [...args, "--interval-ms", "0"], { env }), /--interval-ms/);
  } finally { await fx.close(); }
});

test("CLI wait holds an online WS presence without double-counting and wakes immediately on push", async () => {
  const fx = await fixture();
  let museWait: ReturnType<typeof launchWait> | undefined;
  let agyWait: ReturnType<typeof launchWait> | undefined;
  try {
    const sender = await fx.join("eg");
    const agy = await fx.join("agy");
    await sender.request({
      type: "register",
      name: "muse",
      harness: "muse",
      cwd: "/work",
      sessionId: "01a1957b-9e69-7b90-aa4b-d1f30c47dc47",
      wake: false,
    });

    museWait = launchWait(
      fx.home,
      ["--to", "muse", "--interval-ms", "60000", "--json"],
      { SWITCHBOARD_URL: fx.url },
    );
    agyWait = launchWait(
      fx.home,
      ["--to", "agy", "--interval-ms", "60000", "--json"],
      { SWITCHBOARD_URL: fx.url },
    );
    await Promise.all([museWait.ready, agyWait.ready]);

    const who = await sender.request({ type: "who" });
    assert.equal(who.type, "who");
    if (who.type === "who") {
      const museRows = who.agents.filter((a) => a.name === "muse");
      assert.equal(museRows.length, 1);
      assert.equal(museRows[0]!.online, true);
      assert.equal(museRows[0]!.harness, "muse");
      assert.equal(museRows[0]!.connectionCount, 1);
      assert.equal(museRows[0]!.wakeSessionId, "01a1957b-9e69-7b90-aa4b-d1f30c47dc47");

      const agyRows = who.agents.filter((a) => a.name === "agy");
      assert.equal(agyRows.length, 1);
      assert.equal(agyRows[0]!.online, true);
      assert.equal(agyRows[0]!.connectionCount, 1);
    }

    const start = Date.now();
    await sender.request({ type: "publish", topic: "dm", body: "instant push wake", to: "muse" });
    const museResult = await museWait.done;
    assert.equal(museResult.code, 0);
    assert.ok(Date.now() - start < 2000);
    const parsed = JSON.parse(museResult.stdout);
    assert.equal(parsed.status, "MESSAGES");
    assert.equal(parsed.messages[0].preview, "instant push wake");
    void agy;
  } finally {
    museWait?.child.kill();
    agyWait?.child.kill();
    await Promise.allSettled([museWait?.done, agyWait?.done]);
    await fx.close();
  }
});

test("waitForMessages filters unsubscribed custom broadcast topics and scopes directed messages by sessionId", async () => {
  const store = new Store(":memory:");
  try {
    const s1 = "019c8e1c-0001-7000-8000-000000000001";
    const s2 = "019c8e1c-0002-7000-8000-000000000002";
    store.upsertAgent({ repo: "board", name: "grok", harness: "grok", sessionId: s1, cwd: "/work", wake: false, status: "online", bySession: true });
    store.upsertAgent({ repo: "board", name: "grok", harness: "grok", sessionId: s2, cwd: "/work", wake: false, status: "online", bySession: true });

    // 1. Unsubscribed broadcast on custom topic 'alerts' and 'reports' (for worker) should not wake waitForMessages
    insert(store, { to: null, topic: "alerts", body: "unsubscribed broadcast" });
    insert(store, { to: null, topic: "reports", body: "orchestrator report" });
    // Message directed to sibling session s2 should not wake s1
    insert(store, { to: s2, topic: "dm", body: "only for s2" });

    const resBeforeSub = await waitForMessages(store, {
      repo: "board",
      to: "grok",
      sessionId: s1,
      subscriptionKey: s1,
      isOrchestrator: false,
      wakeExisting: true,
      timeoutMs: 0,
    });
    assert.equal(resBeforeSub.status, "TIMEOUT");

    // 2. Subscribing s1 to 'alerts' and publishing a new message wakes s1
    const subSeq = store.maxSeq("board");
    store.subscribe("board", s1, ["alerts"], subSeq);
    const liveAlert = insert(store, { to: null, topic: "alerts", body: "subscribed broadcast" });
    const directS1 = insert(store, { to: s1, topic: "dm", body: "direct for s1" });

    const resAfterSub = await waitForMessages(store, {
      repo: "board",
      to: "grok",
      sessionId: s1,
      subscriptionKey: s1,
      isOrchestrator: false,
      wakeExisting: true,
      timeoutMs: 0,
    });
    assert.equal(resAfterSub.status, "MESSAGES");
    assert.deepEqual(
      resAfterSub.messages.map((m) => m.seq),
      [liveAlert.seq, directS1.seq],
    );
  } finally {
    store.close();
  }
});
