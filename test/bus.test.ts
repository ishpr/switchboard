import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BusClient } from "../src/busClient.ts";
import { startDaemon, type DaemonHandle, isLoopback } from "../src/daemon.ts";
import { formatMessage, hookStdout, shouldSkipHookForPrompt } from "../src/hook.ts";
import { ensureToken } from "../src/token.ts";
import type { BusMessage, ClientHello, WakeLaunch } from "../src/types.ts";

type Fixture = {
  daemon: DaemonHandle;
  token: string;
  launches: WakeLaunch[];
};

async function fixture(): Promise<Fixture> {
  const home = mkdtempSync(path.join(tmpdir(), "switchboard-"));
  const token = ensureToken(home);
  const launches: WakeLaunch[] = [];
  const daemon = await startDaemon({
    port: 0,
    dbFile: path.join(home, "switchboard.db"),
    token,
    spawnWake: async (launch) => {
      launches.push(launch);
    },
    isTurnInProgress: () => false,
    presenceTtlMs: 250,
    sweepMs: 40,
  });
  return { daemon, token, launches };
}

function hello(token: string, name: string, repo: string, extra: Partial<ClientHello> = {}): ClientHello {
  return {
    type: "hello",
    token,
    name,
    harness: extra.harness ?? "claude",
    repoKey: repo,
    cwd: extra.cwd ?? "/work",
    sessionId: extra.sessionId,
    wake: extra.wake,
    status: extra.status,
    role: extra.role,
    boundSession: extra.boundSession,
  };
}

async function join(fx: Fixture, name: string, repo = "repo-a", extra: Partial<ClientHello> = {}) {
  const client = new BusClient();
  await client.connect(fx.daemon.url, hello(fx.token, name, repo, extra));
  return client;
}

function waitForMessage(client: BusClient): Promise<BusMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for a message")), 2_000);
    client.onMessage = (frame) => {
      clearTimeout(timer);
      resolve(frame.message);
    };
  });
}

test("isLoopback accepts only local peers", () => {
  assert.equal(isLoopback("127.0.0.1"), true);
  assert.equal(isLoopback("::1"), true);
  assert.equal(isLoopback("::ffff:127.0.0.1"), true);
  assert.equal(isLoopback("10.0.0.8"), false);
  assert.equal(isLoopback(undefined), false);
});

test("two clients share a topic, and a later client catches up from the log", async () => {
  const fx = await fixture();
  const claude = await join(fx, "claude");
  const codex = await join(fx, "codex", "repo-a", { harness: "codex" });
  try {
    const incoming = waitForMessage(codex);
    const published = await claude.request({ type: "publish", topic: "repo", body: "tests are green" });
    assert.equal(published.type, "published");
    if (published.type !== "published") return;
    const pushed = await incoming;
    assert.equal(pushed.body, "tests are green");
    assert.equal(pushed.id, published.id);

    const late = await join(fx, "grok", "repo-a", { harness: "grok" });
    const inbox = await late.request({ type: "inbox", since: 0 });
    assert.equal(inbox.type, "inbox");
    if (inbox.type !== "inbox") return;
    assert.ok(inbox.messages.some((entry) => entry.body === "tests are green"));
    late.close();
  } finally {
    claude.close();
    codex.close();
    await fx.daemon.close();
  }
});

test("a different repo hash does not see the message", async () => {
  const fx = await fixture();
  const a = await join(fx, "claude", "repo-a");
  const b = await join(fx, "codex", "repo-b", { harness: "codex" });
  try {
    let leaked = false;
    b.onMessage = () => {
      leaked = true;
    };
    await a.request({ type: "publish", topic: "repo", body: "only repo-a" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(leaked, false);
    const inbox = await b.request({ type: "inbox", since: 0 });
    assert.equal(inbox.type, "inbox");
    if (inbox.type !== "inbox") return;
    assert.equal(
      inbox.messages.some((entry) => entry.body === "only repo-a"),
      false,
    );
  } finally {
    a.close();
    b.close();
    await fx.daemon.close();
  }
});

test("a bad token is rejected", async () => {
  const fx = await fixture();
  const client = new BusClient();
  try {
    await assert.rejects(
      client.connect(fx.daemon.url, hello("nope", "claude", "repo-a")),
      /bad token/,
    );
  } finally {
    client.close();
    await fx.daemon.close();
  }
});

test("ask and reply share a correlation id", async () => {
  const fx = await fixture();
  const claude = await join(fx, "claude");
  const codex = await join(fx, "codex", "repo-a", { harness: "codex" });
  try {
    const asked = waitForMessage(codex);
    const ack = await claude.request({ type: "ask", to: "codex", body: "what failed?" });
    assert.equal(ack.type, "published");
    if (ack.type !== "published") return;
    assert.equal(ack.wake.mode, "push");
    const ask = await asked;
    assert.equal(ask.kind, "ask");
    assert.equal(ask.correlationId, ack.correlationId);

    const replied = waitForMessage(claude);
    const replyAck = await codex.request({
      type: "reply",
      correlationId: ask.correlationId ?? "",
      body: "the inbox test",
    });
    assert.equal(replyAck.type, "published");
    const reply = await replied;
    assert.equal(reply.kind, "reply");
    assert.equal(reply.correlationId, ask.correlationId);
    assert.equal(reply.to, "claude");
    assert.equal(fx.launches.length, 0);
  } finally {
    claude.close();
    codex.close();
    await fx.daemon.close();
  }
});

test("a directed message is not delivered to a third agent", async () => {
  const fx = await fixture();
  const claude = await join(fx, "claude");
  const grok = await join(fx, "grok", "repo-a", { harness: "grok" });
  try {
    await claude.request({ type: "register", name: "kimi", harness: "kimi", cwd: "/work", wake: false });
    await claude.request({ type: "ask", to: "kimi", body: "private" });
    const inbox = await grok.request({ type: "inbox", since: 0 });
    assert.equal(inbox.type, "inbox");
    if (inbox.type !== "inbox") return;
    assert.equal(
      inbox.messages.some((entry) => entry.body === "private"),
      false,
    );
  } finally {
    claude.close();
    grok.close();
    await fx.daemon.close();
  }
});

test("offline wake starts the headless CLI, and a bound Codex session is queued", async () => {
  const fx = await fixture();
  const claude = await join(fx, "claude");
  try {
    await claude.request({
      type: "register",
      name: "kimi",
      harness: "kimi",
      cwd: "/work/kimi",
      wake: true,
    });
    const kimi = await claude.request({ type: "ask", to: "kimi", body: "please look" });
    assert.equal(kimi.type, "published");
    if (kimi.type !== "published") return;
    assert.equal(kimi.wake.mode, "headless");
    assert.equal(fx.launches[0]?.cmd, "kimi-cli");
    assert.ok(fx.launches[0]?.args.includes("--print"));

    const again = await claude.request({ type: "ask", to: "kimi", body: "again" });
    assert.equal(again.type, "published");
    if (again.type !== "published") return;
    assert.equal(again.wake.mode, "skip");
    assert.equal(fx.launches.length, 1);

    const codexThreadId = "01a175cd-251c-7571-abb3-21ea77b5d73d";
    await claude.request({
      type: "register",
      name: "codex",
      harness: "codex",
      cwd: "/work/codex",
      sessionId: codexThreadId,
      wake: true,
    });
    const codex = await claude.request({ type: "ask", to: "codex", body: "in the desktop thread" });
    assert.equal(codex.type, "published");
    if (codex.type !== "published") return;
    assert.equal(codex.wake.mode, "inject");
    const launch = fx.launches.at(-1);
    assert.ok(launch);
    assert.ok(launch.args.includes(codexThreadId));
    assert.ok(launch.args.includes("queue"));
  } finally {
    claude.close();
    await fx.daemon.close();
  }
});

test("an open agent without an inject command is not spawned beside the TUI", async () => {
  const fx = await fixture();
  const claude = await join(fx, "claude");
  const grok = await join(fx, "grok", "repo-a", { harness: "grok", wake: true });
  try {
    const ack = await claude.request({ type: "ask", to: "grok", body: "you are idle at the prompt" });
    assert.equal(ack.type, "published");
    if (ack.type !== "published") return;
    assert.equal(ack.wake.mode, "push");
    assert.equal(fx.launches.length, 0);
  } finally {
    claude.close();
    grok.close();
    await fx.daemon.close();
  }
});

test("two sessions of one harness poll separately and both stay visible", async () => {
  const fx = await fixture();
  const first = await join(fx, "grok", "repo-a", { harness: "grok", sessionId: "grok-a" });
  const second = await join(fx, "grok", "repo-a", { harness: "grok", sessionId: "grok-b" });
  try {
    const who = await first.request({ type: "who" });
    assert.equal(who.type, "who");
    if (who.type !== "who") return;
    const live = who.agents.filter((agent) => agent.name === "grok" && agent.online);
    assert.deepEqual(
      live.map((agent) => agent.sessionId).sort(),
      ["grok-a", "grok-b"],
    );

    await first.request({ type: "publish", topic: "repo", body: "from grok-a" });
    const readBySecond = await second.request({ type: "inbox" });
    assert.equal(readBySecond.type, "inbox");
    if (readBySecond.type !== "inbox") return;
    assert.ok(readBySecond.messages.some((entry) => entry.body === "from grok-a"));
    assert.equal(readBySecond.messages.some((entry) => entry.topic === "presence"), false);
    const presence = await second.request({ type: "inbox", topic: "presence" });
    assert.equal(presence.type, "inbox");
    if (presence.type === "inbox") assert.ok(presence.messages.some((entry) => entry.body.includes("grok-a")));

    const readByFirst = await first.request({ type: "inbox" });
    assert.equal(readByFirst.type, "inbox");
    if (readByFirst.type !== "inbox") return;
    assert.ok(readByFirst.messages.some((entry) => entry.body === "from grok-a"));
  } finally {
    first.close();
    second.close();
    await fx.daemon.close();
  }
});

test("a live session shows the status it set", async () => {
  const fx = await fixture();
  const grok = await join(fx, "grok", "repo-a", { harness: "grok", sessionId: "g1" });
  try {
    const updated = await grok.request({ type: "status", status: "grok-ready" });
    assert.equal(updated.type, "ok");
    const who = await grok.request({ type: "who" });
    assert.equal(who.type, "who");
    if (who.type !== "who") return;
    const row = who.agents.find((agent) => agent.sessionId === "g1");
    assert.ok(row);
    assert.equal(row.status, "grok-ready");
    assert.equal(row.online, true);
  } finally {
    grok.close();
    await fx.daemon.close();
  }
});

test("connecting without a wake flag keeps the registered wake policy", async () => {
  const fx = await fixture();
  const cli = await join(fx, "cli", "repo-a", { harness: "cli", wake: false });
  try {
    const registered = await cli.request({
      type: "register",
      name: "kimi",
      harness: "kimi",
      cwd: "/work",
      wake: true,
    });
    assert.equal(registered.type, "registered");
    const kimi = await join(fx, "kimi", "repo-a", { harness: "kimi" });
    try {
      const who = await kimi.request({ type: "who" });
      assert.equal(who.type, "who");
      if (who.type !== "who") return;
      const row = who.agents.find((agent) => agent.name === "kimi");
      assert.ok(row);
      assert.equal(row.wake, true);
      assert.equal(row.online, true);
    } finally {
      kimi.close();
    }
  } finally {
    cli.close();
    await fx.daemon.close();
  }
});

test("presence drops after the heartbeat ttl", async () => {
  const fx = await fixture();
  const watcher = await join(fx, "claude");
  const idle = await join(fx, "codex", "repo-a", { harness: "codex" });
  try {
    idle.close();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const who = await watcher.request({ type: "who" });
    assert.equal(who.type, "who");
    if (who.type !== "who") return;
    const codex = who.agents.find((agent) => agent.name === "codex");
    assert.ok(codex);
    assert.equal(codex.online, false);
  } finally {
    watcher.close();
    await fx.daemon.close();
  }
});

test("the first claimant is the orchestrator and a different name cannot take the role", async () => {
  const fx = await fixture();
  const cursor = new BusClient();
  const claude = new BusClient();
  try {
    const welcome = await cursor.connect(
      fx.daemon.url,
      hello(fx.token, "cursor", "repo-a", { harness: "cursor", role: "orchestrator", sessionId: "c1" }),
    );
    assert.equal(welcome.role, "orchestrator");
    assert.equal(welcome.orchestrator, "cursor");

    const refused = await claude.connect(
      fx.daemon.url,
      hello(fx.token, "claude", "repo-a", { role: "orchestrator", sessionId: "cl1" }),
    );
    assert.equal(refused.role, "worker");
    assert.equal(refused.orchestrator, "cursor");

    const who = await claude.request({ type: "who" });
    assert.equal(who.type, "who");
    if (who.type !== "who") return;
    const cursorRow = who.agents.find((agent) => agent.sessionId === "c1");
    const claudeRow = who.agents.find((agent) => agent.sessionId === "cl1");
    assert.equal(cursorRow?.role, "orchestrator");
    assert.equal(claudeRow?.role, "worker");
  } finally {
    cursor.close();
    claude.close();
    await fx.daemon.close();
  }
});

test("a report reaches only the orchestrator", async () => {
  const fx = await fixture();
  const cursor = await join(fx, "cursor", "repo-a", {
    harness: "cursor",
    role: "orchestrator",
    sessionId: "c1",
  });
  const grok = await join(fx, "grok", "repo-a", { harness: "grok", sessionId: "g1" });
  const claude = await join(fx, "claude", "repo-a", { sessionId: "cl1" });
  try {
    await assert.rejects(
      cursor.request({ type: "report", body: "the orchestrator does not report to itself" }),
      /bus_inbox/,
    );
    const incoming = waitForMessage(cursor);
    const reported = await grok.request({ type: "report", body: "grok finished the task" });
    assert.equal(reported.type, "published");
    const pushed = await incoming;
    assert.equal(pushed.topic, "reports");
    assert.equal(pushed.to, "cursor");
    assert.equal(pushed.body, "grok finished the task");

    const claudeInbox = await claude.request({ type: "inbox", since: 0 });
    assert.equal(claudeInbox.type, "inbox");
    if (claudeInbox.type !== "inbox") return;
    assert.equal(
      claudeInbox.messages.some((entry) => entry.body === "grok finished the task"),
      false,
    );

    const cursorInbox = await cursor.request({ type: "inbox", since: 0 });
    assert.equal(cursorInbox.type, "inbox");
    if (cursorInbox.type !== "inbox") return;
    assert.ok(cursorInbox.messages.some((entry) => entry.body === "grok finished the task"));
  } finally {
    cursor.close();
    grok.close();
    claude.close();
    await fx.daemon.close();
  }
});

test("a report waits for the orchestrator and is refused before one exists", async () => {
  const fx = await fixture();
  const grok = await join(fx, "grok", "repo-a", { harness: "grok" });
  try {
    await assert.rejects(grok.request({ type: "report", body: "too early" }), /no orchestrator/);
  } finally {
    grok.close();
  }

  const cursor = await join(fx, "cursor", "repo-a", { harness: "cursor", role: "orchestrator" });
  cursor.close();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const late = await join(fx, "grok", "repo-a", { harness: "grok", sessionId: "g2" });
  try {
    const reported = await late.request({ type: "report", body: "while cursor was away" });
    assert.equal(reported.type, "published");
    const back = await join(fx, "cursor", "repo-a", {
      harness: "cursor",
      role: "orchestrator",
      sessionId: "c2",
    });
    try {
      const inbox = await back.request({ type: "inbox", since: 0 });
      assert.equal(inbox.type, "inbox");
      if (inbox.type !== "inbox") return;
      assert.ok(inbox.messages.some((entry) => entry.body === "while cursor was away"));
    } finally {
      back.close();
    }
  } finally {
    late.close();
    await fx.daemon.close();
  }
});

test("a later ask survives the first full inbox page", async () => {
  const fx = await fixture();
  const sender = await join(fx, "cursor", "repo-a", { harness: "cursor", role: "orchestrator" });
  const claude = await join(fx, "claude", "repo-a", { sessionId: "claude-page" });
  try {
    for (let i = 0; i < 60; i++) {
      const published = await sender.request({ type: "publish", topic: "repo", body: `pad ${i}` });
      assert.equal(published.type, "published");
    }
    const asked = await sender.request({ type: "ask", to: "claude", body: "orchtest reply now" });
    assert.equal(asked.type, "published");

    const first = await claude.request({ type: "inbox" });
    assert.equal(first.type, "inbox");
    if (first.type !== "inbox") return;
    assert.equal(first.more, true);
    assert.equal(first.messages.length, 50);
    assert.equal(
      first.messages.some((entry) => entry.body === "orchtest reply now"),
      false,
    );

    const second = await claude.request({ type: "inbox" });
    assert.equal(second.type, "inbox");
    if (second.type !== "inbox") return;
    assert.ok(second.messages.some((entry) => entry.body === "orchtest reply now" && entry.kind === "ask"));
  } finally {
    sender.close();
    claude.close();
    await fx.daemon.close();
  }
});

test("a client automatically reconnects and restores subscriptions after a daemon restart", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "switchboard-reconn-"));
  const token = ensureToken(home);
  const dbFile = path.join(home, "switchboard.db");
  let daemon = await startDaemon({ port: 0, dbFile, token });

  const client = new BusClient();
  client.endpointResolver = async () => ({ url: daemon.url, token });
  try {
    await client.connect(daemon.url, hello(token, "pi", "repo-a"));
    await client.request({ type: "subscribe", topics: ["train"] });

    // Restart the daemon on a new port
    await daemon.close();
    daemon = await startDaemon({ port: 0, dbFile, token });

    // Next request transparently reconnects and re-subscribes
    const who = await client.request({ type: "who" });
    assert.equal(who.type, "who");

    const peer = new BusClient();
    await peer.connect(daemon.url, hello(token, "eg", "repo-a"));
    try {
      const incoming = new Promise<BusMessage>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out")), 2_000);
        client.onMessage = (frame) => {
          if (frame.message.topic === "train") {
            clearTimeout(timer);
            resolve(frame.message);
          }
        };
      });
      await peer.request({ type: "publish", topic: "train", body: "reconnected on train" });
      const msg = await incoming;
      assert.equal(msg.body, "reconnected on train");
    } finally {
      peer.close();
    }
  } finally {
    client.close();
    await daemon.close();
  }
});

test("ephemeral cli connections do not overwrite registered agent metadata", async () => {
  const fx = await fixture();
  const registrar = await join(fx, "cli", "repo-a", { harness: "cli" });
  try {
    await registrar.request({
      type: "register",
      name: "codex",
      harness: "codex",
      cwd: "/work/codex",
      sessionId: "thread-42",
      wake: true,
    });
    // An ephemeral hook/cli connection using the agent's name must not clobber harness, sessionId, or wake
    const hookConn = await join(fx, "codex", "repo-a", { harness: "cli" });
    await hookConn.request({ type: "inbox" });
    hookConn.close();

    const who = await registrar.request({ type: "who" });
    assert.equal(who.type, "who");
    if (who.type !== "who") return;
    const codex = who.agents.find((a) => a.name === "codex");
    assert.ok(codex);
    assert.equal(codex.harness, "codex");
    assert.equal(codex.sessionId, "thread-42");
    assert.equal(codex.wake, true);
  } finally {
    registrar.close();
    await fx.daemon.close();
  }
});

test("orchestrator can be configured independently per repo and reassigned dynamically", async () => {
  const fx = await fixture();
  const cursorA = await join(fx, "cursor", "repo-a", { harness: "cursor", role: "orchestrator" });
  const cursorB = await join(fx, "cursor", "repo-b", { harness: "cursor", role: "orchestrator" });
  const agyA = await join(fx, "agy", "repo-a", { harness: "antigravity" });
  const agyB = await join(fx, "agy", "repo-b", { harness: "antigravity" });
  const piA = await join(fx, "pi", "repo-a", { harness: "claude" });
  try {
    // Reassign repo-a orchestrator to agy
    const setRes = await cursorA.request({ type: "orchestrator", name: "agy" });
    assert.deepEqual(setRes, { type: "orchestrator", orchestrator: "agy" });

    // repo-b keeps cursor as orchestrator
    const getB = await cursorB.request({ type: "orchestrator" });
    assert.deepEqual(getB, { type: "orchestrator", orchestrator: "cursor" });

    // Live agyA session is now the orchestrator in repo-a and receives reports
    const incomingAgy = waitForMessage(agyA);
    const repA = await piA.request({ type: "report", body: "pi finished slice in repo-a" });
    assert.equal(repA.type, "published");
    const msgA = await incomingAgy;
    assert.equal(msgA.topic, "reports");
    assert.equal(msgA.to, "agy");
    assert.equal(msgA.body, "pi finished slice in repo-a");

    // Reconnecting agy in repo-a without role=orchestrator in hello still gets role=orchestrator
    agyA.close();
    const agyA2 = await join(fx, "agy", "repo-a", { harness: "antigravity" });
    try {
      const whoA = await agyA2.request({ type: "who" });
      assert.equal(whoA.type, "who");
      if (whoA.type === "who") {
        assert.equal(whoA.agents.find((a) => a.name === "agy")?.role, "orchestrator");
        assert.equal(whoA.agents.find((a) => a.name === "cursor")?.role, "worker");
      }
    } finally {
      agyA2.close();
    }
  } finally {
    cursorA.close();
    cursorB.close();
    agyA.close();
    agyB.close();
    piA.close();
    await fx.daemon.close();
  }
});

test("multi-turn replies route to the other party and who separates an unbound connection from its registered wake target", async () => {
  const fx = await fixture();
  const registrar = await join(fx, "cli", "repo-a", { harness: "cli" });
  await registrar.request({
    type: "register",
    name: "muse",
    harness: "muse",
    cwd: "/work/muse",
    sessionId: "zellij:switchboard:6",
    wake: true,
  });
  registrar.close();

  const muse = await join(fx, "muse", "repo-a", { harness: "muse" });
  const agy = await join(fx, "agy", "repo-a", { harness: "antigravity", role: "orchestrator" });
  try {
    const who = await agy.request({ type: "who" });
    assert.equal(who.type, "who");
    if (who.type === "who") {
      assert.equal(who.agents.find((a) => a.name === "muse")?.sessionId, null);
      assert.equal(who.agents.find((a) => a.name === "muse")?.wakeSessionId, "zellij:switchboard:6");
    }

    // 1. muse asks agy
    const askReceived = waitForMessage(agy);
    const askRes = await muse.request({ type: "ask", to: "agy", body: "ready for review?" });
    assert.equal(askRes.type, "published");
    const askMsg = await askReceived;
    assert.equal(askMsg.to, "agy");
    assert.ok(askMsg.correlationId);

    // 2. agy replies to muse on that correlationId
    const reply1Received = waitForMessage(muse);
    await agy.request({ type: "reply", correlationId: askMsg.correlationId!, body: "go ahead and push" });
    const reply1Msg = await reply1Received;
    assert.equal(reply1Msg.to, "muse");

    // 3. muse replies back to agy on the SAME correlationId (must route to agy, not muse!)
    const reply2Received = waitForMessage(agy);
    await muse.request({ type: "reply", correlationId: askMsg.correlationId!, body: "PR #628 is up" });
    const reply2Msg = await reply2Received;
    assert.equal(reply2Msg.fromName, "muse");
    assert.equal(reply2Msg.to, "agy");
    assert.equal(reply2Msg.body, "PR #628 is up");
  } finally {
    muse.close();
    agy.close();
    await fx.daemon.close();
  }
});

test("inbox tracks unanswered ask for Stop hook and clears it once bus_reply is sent", async () => {
  const fx = await fixture();
  const agy = await join(fx, "agy", "repo-a", { harness: "antigravity", role: "orchestrator" });
  const eg = await join(fx, "eg", "repo-a", { harness: "claude" });
  try {
    // 1. UserPromptSubmit skips consuming inbox when prompt is a [switchboard] wake prompt
    assert.equal(
      shouldSkipHookForPrompt("UserPromptSubmit", {
        prompt: "[switchboard] Message from agy (id=1): call bus_inbox and reply with bus_reply.",
      }),
      true,
    );
    assert.equal(
      shouldSkipHookForPrompt("UserPromptSubmit", { prompt: "normal user prompt" }),
      false,
    );
    assert.equal(shouldSkipHookForPrompt("Stop", { stop_hook_active: true }), true);

    // 2. agy sends ask to eg
    const askRes = await agy.request({ type: "ask", to: "eg", body: "stabilize CI step 6" });
    assert.equal(askRes.type, "published");
    if (askRes.type !== "published") return;
    const cid = askRes.correlationId!;

    // 3. eg polls inbox: receives message with REQUIRED bus_reply footer and pendingAsk
    const inbox1 = await eg.request({ type: "inbox" });
    assert.equal(inbox1.type, "inbox");
    if (inbox1.type !== "inbox") return;
    const askMsg = inbox1.messages.find((m) => m.kind === "ask");
    assert.ok(askMsg);
    const formatted = formatMessage(askMsg);
    assert.match(formatted, /REQUIRED — when finished, call bus_reply/);
    assert.ok(inbox1.pendingAsk);
    assert.equal(inbox1.pendingAsk?.correlationId, cid);

    // 4. Subsequent Stop hook check (empty new messages, but pendingAsk still open) blocks Stop!
    const inbox2 = await eg.request({ type: "inbox" });
    assert.equal(inbox2.type, "inbox");
    if (inbox2.type !== "inbox") return;
    assert.equal(inbox2.messages.length, 0);
    assert.equal(inbox2.pendingAsk?.correlationId, cid);
    const stopOut = JSON.parse(hookStdout("claude", "Stop", [], inbox2.pendingAsk, false));
    assert.equal(stopOut.decision, "block");
    assert.match(stopOut.reason, new RegExp(cid));
    assert.equal(hookStdout("claude", "Stop", [], inbox2.pendingAsk, true), "");

    // 5. Once eg calls bus_reply, pendingAsk is cleared and Stop hook does not block
    await eg.request({ type: "reply", correlationId: cid, body: "CI step 6 green, PR opened" });
    const inbox3 = await eg.request({ type: "inbox" });
    assert.equal(inbox3.type, "inbox");
    if (inbox3.type !== "inbox") return;
    assert.equal(inbox3.pendingAsk, null);
    assert.equal(hookStdout("claude", "Stop", [], inbox3.pendingAsk, false), "");
  } finally {
    agy.close();
    eg.close();
    await fx.daemon.close();
  }
});

test("reply state progress and blocked keep ask open until state=done, and supersedes closes prior ask", async () => {
  const fx = await fixture();
  const agy = await join(fx, "agy", "repo-a", { harness: "antigravity", role: "orchestrator" });
  const eg = await join(fx, "eg", "repo-a", { harness: "claude" });
  try {
    const ask1 = await agy.request({ type: "ask", to: "eg", body: "task 1" });
    assert.equal(ask1.type, "published");
    if (ask1.type !== "published") return;
    const cid1 = ask1.correlationId!;

    await eg.request({ type: "inbox" });

    // progress reply keeps ask1 open and records last_reply_state=progress
    const progIncoming = waitForMessage(agy);
    await eg.request({ type: "reply", correlationId: cid1, body: "50% done", state: "progress" });
    const progMsg = await progIncoming;
    assert.equal(progMsg.replyState, "progress");
    assert.match(formatMessage(progMsg), /state=progress/);

    const status1 = await agy.request({ type: "status", pending: true });
    assert.equal(status1.type, "ok");
    if (status1.type === "ok") {
      assert.equal(status1.pending_asks?.length, 1);
      assert.equal(status1.pending_asks?.[0]?.correlation_id, cid1);
      assert.equal(status1.pending_asks?.[0]?.last_reply_state, "progress");
    }

    // blocked reply also keeps ask1 open and updates last_reply_state=blocked
    await eg.request({ type: "reply", correlationId: cid1, body: "waiting on schema", state: "blocked" });
    const inboxAfterBlocked = await eg.request({ type: "inbox" });
    assert.equal(inboxAfterBlocked.type, "inbox");
    if (inboxAfterBlocked.type === "inbox") {
      assert.equal(inboxAfterBlocked.pendingAsk?.correlationId, cid1);
    }

    // Superseding ask closes ask1 and leaves only ask2 open
    const ask2 = await agy.request({
      type: "ask",
      to: "eg",
      body: "task 1 revised",
      supersedes: cid1,
    });
    assert.equal(ask2.type, "published");
    if (ask2.type !== "published") return;
    const cid2 = ask2.correlationId!;

    const status2 = await agy.request({ type: "status", pending: true });
    assert.equal(status2.type, "ok");
    if (status2.type === "ok") {
      assert.equal(status2.pending_asks?.length, 1);
      assert.equal(status2.pending_asks?.[0]?.correlation_id, cid2);
    }

    // Replying with state=done closes ask2
    await eg.request({ type: "inbox" });
    await eg.request({ type: "reply", correlationId: cid2, body: "completed revised task", state: "done" });
    const status3 = await agy.request({ type: "status", pending: true });
    assert.equal(status3.type, "ok");
    if (status3.type === "ok") {
      assert.equal(status3.pending_asks?.length, 0);
    }
  } finally {
    agy.close();
    eg.close();
    await fx.daemon.close();
  }
});

test("trailing wake fires after cooldown if message remains unread, and skips if already acked", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "switchboard-trailing-"));
  const token = ensureToken(home);
  const launches: WakeLaunch[] = [];
  const daemon = await startDaemon({
    port: 0,
    dbFile: path.join(home, "switchboard.db"),
    token,
    wakeCooldownMs: 60,
    spawnWake: async (launch) => {
      launches.push(launch);
    },
  });
  const claude = new BusClient();
  await claude.connect(daemon.url, hello(token, "claude", "repo-a"));
  try {
    await claude.request({
      type: "register",
      name: "kimi",
      harness: "kimi",
      cwd: "/work/kimi",
      wake: true,
    });

    // 1st ask triggers immediate wake (launches.length === 1)
    const first = await claude.request({ type: "ask", to: "kimi", body: "first task" });
    assert.equal(first.type, "published");
    assert.equal(launches.length, 1);

    // 2nd ask within cooldown returns skip immediately, then fires trailing wake after cooldown because unread
    const second = await claude.request({ type: "ask", to: "kimi", body: "second task (unread)" });
    assert.equal(second.type, "published");
    if (second.type === "published") assert.equal(second.wake.mode, "skip");
    assert.equal(launches.length, 1);

    await new Promise((resolve) => setTimeout(resolve, 110));
    assert.equal(launches.length, 2);

    // 3rd ask within cooldown that gets read before cooldown expires does NOT fire a redundant trailing wake
    const third = await claude.request({ type: "ask", to: "kimi", body: "third task (read)" });
    assert.equal(third.type, "published");
    const kimiCli = new BusClient();
    await kimiCli.connect(daemon.url, hello(token, "kimi", "repo-a", { harness: "cli" }));
    await kimiCli.request({ type: "inbox" });
    kimiCli.close();

    await new Promise((resolve) => setTimeout(resolve, 110));
    assert.equal(launches.length, 2);
  } finally {
    claude.close();
    await daemon.close();
  }
});

test("state get/set/list/delete supports rev compare-and-swap and never triggers wakes", async () => {
  const fx = await fixture();
  const agy = await join(fx, "agy", "repo-a", { harness: "antigravity", role: "orchestrator" });
  const codex = await join(fx, "codex", "repo-a", { harness: "codex" });
  try {
    await agy.request({
      type: "register",
      name: "kimi",
      harness: "kimi",
      cwd: "/work/kimi",
      wake: true,
    });

    // Create-only with ifRev=0 succeeds (rev=1)
    const set1 = await agy.request({
      type: "state",
      action: "set",
      key: "merge-queue",
      value: "pr-243",
      ifRev: 0,
    });
    assert.equal(set1.type, "state");
    if (set1.type === "state") {
      assert.equal(set1.conflict, undefined);
      assert.equal(set1.entry?.rev, 1);
      assert.equal(set1.entry?.value, "pr-243");
      assert.equal(set1.entry?.updatedBy, "agy");
    }

    // Second create-only with ifRev=0 conflicts and returns current rev=1
    const conflictCreate = await codex.request({
      type: "state",
      action: "set",
      key: "merge-queue",
      value: "pr-244",
      ifRev: 0,
    });
    assert.equal(conflictCreate.type, "state");
    if (conflictCreate.type === "state") {
      assert.equal(conflictCreate.conflict, true);
      assert.equal(conflictCreate.entry?.rev, 1);
      assert.equal(conflictCreate.entry?.value, "pr-243");
    }

    // CAS update with ifRev=1 succeeds (rev=2)
    const set2 = await codex.request({
      type: "state",
      action: "set",
      key: "merge-queue",
      value: "pr-243+f17",
      ifRev: 1,
    });
    assert.equal(set2.type, "state");
    if (set2.type === "state") {
      assert.equal(set2.conflict, undefined);
      assert.equal(set2.entry?.rev, 2);
      assert.equal(set2.entry?.updatedBy, "codex");
    }

    // List with prefix
    await agy.request({ type: "state", action: "set", key: "merge-target", value: "main" });
    const listed = await agy.request({ type: "state", action: "list", prefix: "merge-" });
    assert.equal(listed.type, "state");
    if (listed.type === "state") {
      assert.deepEqual(
        listed.entries?.map((e) => e.key),
        ["merge-queue", "merge-target"],
      );
    }

    // Delete with stale ifRev=1 conflicts, delete with ifRev=2 succeeds
    const badDel = await agy.request({ type: "state", action: "delete", key: "merge-queue", ifRev: 1 });
    assert.equal(badDel.type, "state");
    if (badDel.type === "state") assert.equal(badDel.conflict, true);

    const goodDel = await agy.request({ type: "state", action: "delete", key: "merge-queue", ifRev: 2 });
    assert.equal(goodDel.type, "state");
    if (goodDel.type === "state") {
      assert.equal(goodDel.conflict, undefined);
      assert.equal(goodDel.deleted, true);
    }

    // Zero automatic wakes triggered by any state operation
    assert.equal(fx.launches.length, 0);
  } finally {
    agy.close();
    codex.close();
    await fx.daemon.close();
  }
});

test("default inbox honors session subscriptions, persists them across reconnects, protects repo/presence, and never leaks directed topic mail", async () => {
  const fx = await fixture();
  const sender = await join(fx, "claude", "repo-a");
  const muse1 = await join(fx, "muse", "repo-a", {
    harness: "muse",
    sessionId: "01a1957b-b088-76e1-b08b-ad1ac5ed8594",
    boundSession: true,
  });
  const muse2 = await join(fx, "muse", "repo-a", {
    harness: "muse",
    sessionId: "01a19366-9ddb-7781-aab6-33bc60c5810a",
    boundSession: true,
  });
  const codex = await join(fx, "codex", "repo-a", {
    harness: "codex",
    sessionId: "01a175cd-251c-7571-abb3-21ea77b5d73d",
    boundSession: true,
  });

  try {
    // 1. Broadcast on review BEFORE muse1 subscribes
    await sender.request({ type: "publish", topic: "review", body: "older review broadcast" });

    // Unsubscribed agents do not see review broadcast in default inbox
    const unsubInbox = await codex.request({ type: "inbox" });
    assert.equal(unsubInbox.type, "inbox");
    if (unsubInbox.type === "inbox") {
      assert.equal(
        unsubInbox.messages.some((m) => m.body === "older review broadcast"),
        false,
      );
    }

    // 2. muse1 subscribes to review: response states it is live from now on and how to read older mail
    const subRes = await muse1.request({ type: "subscribe", topics: ["review"] });
    assert.equal(subRes.type, "ok");
    if (subRes.type === "ok") {
      assert.match(subRes.detail, /live from now on/);
      assert.match(subRes.detail, /bus_inbox.*topic=review/);
    }

    // 3. New broadcast on review after muse1 subscribed
    await sender.request({ type: "publish", topic: "review", body: "live review broadcast" });

    // Directed message to codex on topic review (must reach codex, and must NOT leak to muse1!)
    await sender.request({
      type: "publish",
      topic: "review",
      to: "codex",
      body: "private review for codex",
    });

    // muse1 default inbox gets "live review broadcast", NOT "older review broadcast" and NOT "private review for codex"
    const muse1Default = await muse1.request({ type: "inbox" });
    assert.equal(muse1Default.type, "inbox");
    if (muse1Default.type === "inbox") {
      const bodies = muse1Default.messages.map((m) => m.body);
      assert.ok(bodies.includes("live review broadcast"));
      assert.equal(bodies.includes("older review broadcast"), false);
      assert.equal(bodies.includes("private review for codex"), false);
    }

    // muse1 can read older review mail by passing topic="review", still without seeing codex's private review
    const muse1Topic = await muse1.request({ type: "inbox", topic: "review" });
    assert.equal(muse1Topic.type, "inbox");
    if (muse1Topic.type === "inbox") {
      const bodies = muse1Topic.messages.map((m) => m.body);
      assert.deepEqual(bodies, ["older review broadcast", "live review broadcast"]);
    }

    // codex default inbox receives the directed message on review even without subscribing to review, but not the broadcast
    const codexDefault = await codex.request({ type: "inbox" });
    assert.equal(codexDefault.type, "inbox");
    if (codexDefault.type === "inbox") {
      const bodies = codexDefault.messages.map((m) => m.body);
      assert.deepEqual(bodies, ["private review for codex"]);
    }

    // muse2 (different session id of same harness) did NOT subscribe to review and does not see review broadcast
    const muse2Default = await muse2.request({ type: "inbox" });
    assert.equal(muse2Default.type, "inbox");
    if (muse2Default.type === "inbox") {
      assert.equal(
        muse2Default.messages.some((m) => m.topic === "review"),
        false,
      );
    }

    // 4. Reconnect muse1 with a brand new BusClient (simulating a new shim for the same Muse session):
    //    subscription to review is restored from SQLite on connect!
    muse1.close();
    const muse1Reconnected = await join(fx, "muse", "repo-a", {
      harness: "muse",
      sessionId: "01a1957b-b088-76e1-b08b-ad1ac5ed8594",
      boundSession: true,
    });
    try {
      const pushedPromise = waitForMessage(muse1Reconnected);
      await sender.request({ type: "publish", topic: "review", body: "after reconnect review" });
      const pushed = await pushedPromise;
      assert.equal(pushed.topic, "review");
      assert.equal(pushed.body, "after reconnect review");

      const afterReconnInbox = await muse1Reconnected.request({ type: "inbox" });
      assert.equal(afterReconnInbox.type, "inbox");
      if (afterReconnInbox.type === "inbox") {
        assert.ok(afterReconnInbox.messages.some((m) => m.body === "after reconnect review"));
      }

      // 5. repo and presence cannot be removed by unsubscribe
      const unsubProtected = await muse1Reconnected.request({
        type: "unsubscribe",
        topics: ["repo", "presence", "review"],
      });
      assert.equal(unsubProtected.type, "ok");
      if (unsubProtected.type === "ok") {
        assert.match(unsubProtected.detail, /repo,presence cannot be removed/);
      }

      await sender.request({ type: "publish", topic: "repo", body: "repo stays subscribed" });
      await sender.request({ type: "publish", topic: "review", body: "review was unsubscribed" });

      const finalInbox = await muse1Reconnected.request({ type: "inbox" });
      assert.equal(finalInbox.type, "inbox");
      if (finalInbox.type === "inbox") {
        const bodies = finalInbox.messages.map((m) => m.body);
        assert.ok(bodies.includes("repo stays subscribed"));
        assert.equal(bodies.includes("review was unsubscribed"), false);
      }
    } finally {
      muse1Reconnected.close();
    }
  } finally {
    sender.close();
    muse1.close();
    muse2.close();
    codex.close();
    await fx.daemon.close();
  }
});

test("wake_session_id persists in SQLite across legacy shim reconnects and falls back to session_id when offline", async () => {
  const fx = await fixture();
  const cli = await join(fx, "cli", "repo-a", { harness: "cli" });
  try {
    const museUuid = "01a1957b-b088-76e1-b08b-ad1ac5ed8594";
    const reg = await cli.request({
      type: "register",
      name: "muse",
      harness: "muse",
      cwd: "/work",
      sessionId: museUuid,
      wakeSessionId: "tty:/dev/ttys007",
      wake: true,
    });
    assert.equal(reg.type, "registered");

    // Simulate a legacy pre-bebd1de shim connecting without sessionId or wakeSessionId
    const legacyMuse = await join(fx, "muse", "repo-a", {
      harness: "muse",
    });
    try {
      const onlineWho = await cli.request({ type: "who" });
      assert.equal(onlineWho.type, "who");
      if (onlineWho.type === "who") {
        const row = onlineWho.agents.find((a) => a.name === "muse");
        assert.ok(row);
        assert.equal(row.online, true);
        assert.equal(row.wakeSessionId, "tty:/dev/ttys007");
        assert.equal(row.diagnostics?.wakeMode, "inject");
      }
    } finally {
      legacyMuse.close();
    }

    // Wait briefly for socket close to register offline
    await new Promise((r) => setTimeout(r, 30));
    const offlineWho = await cli.request({ type: "who" });
    assert.equal(offlineWho.type, "who");
    if (offlineWho.type === "who") {
      const row = offlineWho.agents.find((a) => a.name === "muse");
      assert.ok(row);
      assert.equal(row.online, false);
      assert.equal(row.sessionId, museUuid);
      assert.equal(row.wakeSessionId, museUuid);
      assert.equal(row.diagnostics?.wakeMode, "headless");
    }

    // An ask addressed to the session UUID can be read and replied to by an unbound CLI connection for that agent name
    const codex = await join(fx, "codex", "repo-a", { harness: "codex" });
    const museCli = await join(fx, "muse", "repo-a", { harness: "cli" });
    try {
      const asked = await codex.request({
        type: "ask",
        to: museUuid,
        body: "session-addressed ask for muse",
      });
      assert.equal(asked.type, "published");
      if (asked.type === "published" && asked.correlationId) {
        const cliInbox = await museCli.request({ type: "inbox" });
        assert.equal(cliInbox.type, "inbox");
        if (cliInbox.type === "inbox") {
          assert.ok(cliInbox.messages.some((m) => m.correlationId === asked.correlationId));
        }
        const replied = await museCli.request({
          type: "reply",
          correlationId: asked.correlationId,
          body: "replied from unbound CLI as muse",
        });
        assert.equal(replied.type, "published");
        const st = await codex.request({ type: "status", pending: true });
        assert.equal(st.type, "ok");
        if (st.type === "ok") {
          assert.equal(
            st.pending_asks?.some((p) => p.correlation_id === asked.correlationId),
            false,
          );
        }
      }
    } finally {
      codex.close();
      museCli.close();
    }
  } finally {
    cli.close();
    await fx.daemon.close();
  }
});

test("active Codex turn defers codex queue injection, cancels if read via hook/inbox mid-turn, and fires when turn finishes if unread", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "switchboard-turn-defer-"));
  const token = ensureToken(home);
  const launches: WakeLaunch[] = [];
  let turnActive = true;
  const daemon = await startDaemon({
    port: 0,
    dbFile: path.join(home, "switchboard.db"),
    token,
    spawnWake: async (launch) => {
      launches.push(launch);
    },
    isTurnInProgress: (harness) => harness === "codex" && turnActive,
    wakeCooldownMs: 60,
    presenceTtlMs: 250,
    sweepMs: 40,
  });

  const codexUuid = "01a175cd-251c-7571-abb3-21ea77b5d73d";
  const muse = new BusClient();
  const codex = new BusClient();
  await muse.connect(daemon.url, hello(token, "muse", "repo-a", { harness: "muse" }));
  await codex.connect(
    daemon.url,
    hello(token, "codex", "repo-a", {
      harness: "codex",
      sessionId: codexUuid,
      boundSession: true,
      wake: true,
    }),
  );

  try {
    // 1. Message 1 arrives while Codex turn is active -> deferred, not queued immediately
    const ask1 = await muse.request({
      type: "ask",
      to: "codex",
      body: "mid-turn message 1",
    });
    assert.equal(ask1.type, "published");
    if (ask1.type === "published") {
      assert.equal(ask1.wake.mode, "skip");
      assert.match(ask1.wake.detail ?? "", /turn is in progress/);
    }
    assert.equal(launches.length, 0);

    // Codex consumes message 1 mid-turn via PostToolUse hook / bus_inbox
    const inbox1 = await codex.request({ type: "inbox" });
    assert.equal(inbox1.type, "inbox");
    if (inbox1.type === "inbox") {
      assert.equal(inbox1.messages.length, 1);
      assert.equal(inbox1.messages[0]?.body, "mid-turn message 1");
    }

    // Even after turn ends, message 1 was already read so codex queue never fires for it
    turnActive = false;
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(launches.length, 0);

    // 2. Message 2 arrives while Codex turn is active, and turn ends before any hook reads it -> codex queue fires once idle
    turnActive = true;
    const ask2 = await muse.request({
      type: "ask",
      to: "codex",
      body: "mid-turn message 2 unread",
    });
    assert.equal(ask2.type, "published");
    assert.equal(launches.length, 0);

    turnActive = false;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(launches.length, 1);
    assert.ok(launches[0]?.args.includes("queue"));
    assert.ok(launches[0]?.args.includes(codexUuid));
  } finally {
    muse.close();
    codex.close();
    await daemon.close();
  }
});
