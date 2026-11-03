import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { resolveShimCwd } from "./init.ts";
import { repoKey } from "./repo.ts";
import { createPaneProbe, formatDiagnostics, sessionDiagnostics, type PaneProbe } from "./health.ts";
import { Store } from "./store.ts";
import {
  BODY_MAX,
  NAME_RE,
  PRESENCE_TTL_MS,
  TOPIC_RE,
  WAKE_COOLDOWN_MS,
  type BusMessage,
  type ClientFrame,
  type Role,
  type ServerFrame,
  type WakeInfo,
  type PrunedAgent,
} from "./types.ts";
import { decideWake, launchFor, logWake, type SpawnWake } from "./wake.ts";

export type DaemonOptions = {
  /** Use port 0 in tests to take a free port. */
  port: number;
  dbFile: string;
  token: string;
  spawnWake?: SpawnWake;
  logFile?: string;
  presenceTtlMs?: number;
  sweepMs?: number;
  paneProbe?: PaneProbe;
};

export type DaemonHandle = {
  port: number;
  url: string;
  close: () => Promise<void>;
};

type Conn = {
  socket: WebSocket;
  authed: boolean;
  agentId: string;
  name: string;
  harness: string;
  repo: string;
  cwd: string;
  sessionId: string | null;
  /** The client supplied sessionId, so this connection has its own inbox cursor. */
  declaredSession: string | null;
  sessionBound: boolean;
  wake: boolean;
  status: string;
  role: Role;
  topics: Set<string>;
  lastSeen: number;
};

export function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  const store = new Store(options.dbFile);
  const http = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ server: http });
  const conns = new Set<Conn>();
  const lastWake = new Map<string, number>();

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port, "127.0.0.1", () => resolve());
  });

  const address = http.address();
  if (!address || typeof address === "string") {
    throw new Error("daemon did not bind a TCP port");
  }
  const port = address.port;

  wss.on("connection", (socket, request) => {
    const addr = request.socket.remoteAddress;
    if (!isLoopback(addr)) {
      socket.close(1008, "loopback only");
      return;
    }
    const conn: Conn = {
      socket,
      authed: false,
      agentId: "",
      name: "",
      harness: "",
      repo: "",
      cwd: "",
      sessionId: null,
      declaredSession: null,
      sessionBound: false,
      wake: false,
      status: "online",
      role: "worker",
      topics: new Set(),
      lastSeen: Date.now(),
    };
    conns.add(conn);
    const helloTimer = setTimeout(() => {
      if (!conn.authed) socket.close(1008, "hello timeout");
    }, 5_000);

    socket.on("message", (data) => {
      let frame: ClientFrame;
      try {
        frame = JSON.parse(data.toString()) as ClientFrame;
      } catch {
        send(socket, { type: "error", error: "invalid json" });
        return;
      }
      try {
        handle(conn, frame);
      } catch (error) {
        const message = error instanceof Error ? error.message : "request failed";
        send(socket, { type: "error", error: message });
      }
    });

    socket.on("close", () => {
      clearTimeout(helloTimer);
      const gone = conn.authed;
      conns.delete(conn);
      if (gone && !stopping) announce(conn, "offline");
    });
    socket.on("error", () => {
      socket.close();
    });
  });

  const presenceTtlMs = options.presenceTtlMs ?? PRESENCE_TTL_MS;
  let stopping = false;
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const conn of conns) {
      if (conn.authed && now - conn.lastSeen > presenceTtlMs) {
        conn.socket.close(1001, "presence timeout");
      }
    }
  }, options.sweepMs ?? 5_000);
  sweep.unref?.();

  function handle(conn: Conn, frame: ClientFrame): void {
    conn.lastSeen = Date.now();
    if (!conn.authed) {
      if (frame.type !== "hello") {
        send(conn.socket, { type: "error", error: "hello required" });
        conn.socket.close(1008, "hello required");
        return;
      }
      hello(conn, frame);
      return;
    }
    if (frame.type === "hello") {
      send(conn.socket, { type: "error", error: "already joined" });
      return;
    }
    switch (frame.type) {
      case "publish":
        void publish(conn, frame);
        break;
      case "subscribe":
        for (const topic of frame.topics) requireTopic(topic);
        for (const topic of frame.topics) conn.topics.add(topic);
        send(conn.socket, { type: "ok", detail: `subscribed ${[...frame.topics].join(",")}` });
        break;
      case "unsubscribe":
        for (const topic of frame.topics) conn.topics.delete(topic);
        send(conn.socket, { type: "ok", detail: "unsubscribed" });
        break;
      case "inbox":
        inbox(conn, frame.since, frame.topic, frame.limit);
        break;
      case "ack":
        store.ack(conn.repo, clientKey(conn), frame.cursor);
        send(conn.socket, { type: "ok", detail: "acked" });
        break;
      case "doctor":
        void sendDoctor(conn, frame).catch((error) => {
          send(conn.socket, { type: "error", error: error instanceof Error ? error.message : "doctor failed" });
        });
        break;
      case "who":
        void sendWho(conn);
        break;
      case "ask":
        void ask(conn, frame.to, frame.body, frame.topic);
        break;
      case "reply":
        void reply(conn, frame.correlationId, frame.body);
        break;
      case "report":
        void report(conn, frame.body);
        break;
      case "status":
        conn.status = frame.status;
        store.touchAgent(conn.repo, conn.name, frame.status);
        void sendStatus(conn);
        break;
      case "orchestrator":
        setOrchestrator(conn, frame.name);
        break;
      case "register":
        register(conn, frame);
        break;
      case "heartbeat":
        store.touchAgent(conn.repo, conn.name);
        break;
      default:
        send(conn.socket, { type: "error", error: "unknown frame" });
    }
  }

  async function sendWho(conn: Conn): Promise<void> {
    const probe = options.paneProbe ?? createPaneProbe();
    const rows = await Promise.all(agents(conn.repo).map(async (agent) => ({
      ...agent, diagnostics: await sessionDiagnostics(agent, probe),
    })));
    send(conn.socket, { type: "who", agents: rows });
  }

  async function sendDoctor(conn: Conn, frame: Extract<ClientFrame, { type: "doctor" }>): Promise<void> {
    const repos = frame.all
      ? [...new Set([...store.listRepos(), ...[...conns].filter((peer) => peer.authed).map((peer) => peer.repo)])].sort()
      : [conn.repo];
    const probe = options.paneProbe ?? createPaneProbe();
    const candidates = repos.flatMap((repo) => agents(repo)).map((agent) => ({
      agent, stored: store.getAgent(agent.repo, agent.name),
    }));
    const rows = await Promise.all(candidates.map(async ({ agent }) => ({
      ...agent, diagnostics: await sessionDiagnostics(agent, probe),
    })));
    const pruned: PrunedAgent[] = [];
    if (frame.prune) {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        const stored = candidates[i]!.stored;
        const reason = row.diagnostics.health;
        if (reason !== "dead_pane" && reason !== "stale") continue;
        const current = agents(row.repo).find((peer) => peer.name === row.name && peer.sessionId === row.sessionId);
        if (!current || current.lastSeen !== row.lastSeen) continue;
        // Only mutate the registration if it still belongs to the scanned session.
        const ownsRegistration = stored?.sessionId === row.sessionId;
        if (ownsRegistration && !store.pruneAgent(stored!, reason)) continue;
        let clearedLiveBinding = false;
        if (reason === "dead_pane") {
          for (const peer of conns) {
            if (peer.authed && peer.repo === row.repo && peer.name === row.name && peer.sessionId === row.sessionId) {
              peer.sessionBound = false;
              peer.sessionId = peer.agentId;
              clearedLiveBinding = true;
            }
          }
        }
        if (!ownsRegistration && !clearedLiveBinding) continue;
        pruned.push({ repo: row.repo, name: row.name, sessionId: row.sessionId, reason });
      }
    }
    // Report the scan plus the exact mutations; last-seen timestamps remain historical evidence.
    send(conn.socket, { type: "doctor", agents: rows, pruned });
  }

  async function sendStatus(conn: Conn): Promise<void> {
    // A CLI status update must diagnose the registered/live agent, not its ephemeral CLI socket.
    const rows = agents(conn.repo);
    const row = rows.find((row) => row.name === conn.name && row.sessionId === conn.sessionId)
      ?? rows.find((row) => row.name === conn.name);
    const detail = row ? formatDiagnostics(await sessionDiagnostics(row, options.paneProbe ?? createPaneProbe())) : "";
    send(conn.socket, { type: "ok", detail: `status updated${detail ? `; ${detail}` : ""}` });
  }

  function hello(conn: Conn, frame: Extract<ClientFrame, { type: "hello" }>): void {
    if (frame.token !== options.token) {
      send(conn.socket, { type: "error", error: "bad token" });
      conn.socket.close(1008, "bad token");
      return;
    }
    requireName(frame.name);
    if (!frame.repoKey || frame.repoKey.length > 64) throw new Error("repo key required");
    if (!frame.cwd) throw new Error("cwd required");
    const effectiveCwd = frame.cwd === "/" ? resolveShimCwd("/") : frame.cwd;
    const effectiveRepo = frame.cwd === "/" && effectiveCwd !== "/" ? repoKey(effectiveCwd) : frame.repoKey;
    const existing = store.getAgent(effectiveRepo, frame.name);
    conn.authed = true;
    conn.agentId = randomUUID();
    conn.name = frame.name;
    conn.harness = frame.harness || "unknown";
    conn.repo = effectiveRepo;
    conn.cwd = effectiveCwd;
    conn.declaredSession = frame.sessionId || null;
    conn.sessionBound = Boolean(frame.boundSession && frame.sessionId);
    conn.sessionId = conn.declaredSession || existing?.sessionId || conn.agentId;
    conn.wake = frame.wake === undefined ? (existing?.wake ?? false) : frame.wake;
    conn.status = frame.status || "online";
    conn.role = elect(conn.repo, conn.name, frame.role === "orchestrator");
    conn.topics.add("repo");
    conn.topics.add("presence");
    if (conn.role === "orchestrator") conn.topics.add("reports");
    if (conn.harness !== "cli") {
      store.upsertAgent({
        repo: conn.repo,
        name: conn.name,
        harness: conn.harness,
        sessionId: conn.sessionBound ? conn.declaredSession : (existing?.sessionId ?? null),
        cwd: conn.cwd,
        wake: conn.wake,
        status: frame.status || existing?.status || "online",
      });
    }
    send(conn.socket, {
      type: "welcome",
      agentId: conn.agentId,
      repoKey: conn.repo,
      cursor: store.cursor(conn.repo, clientKey(conn)),
      role: conn.role,
      orchestrator: store.getOrchestrator(conn.repo),
    });
    announce(conn, "online");
  }

  function elect(repo: string, name: string, wants: boolean): Role {
    const stored = store.getOrchestrator(repo);
    if (stored) {
      return stored === name ? "orchestrator" : "worker";
    }
    if (!wants) return "worker";
    store.setOrchestrator(repo, name);
    return "orchestrator";
  }

  function setOrchestrator(conn: Conn, name?: string): void {
    if (name !== undefined) {
      requireName(name);
      store.setOrchestrator(conn.repo, name);
      for (const peer of conns) {
        if (!peer.authed || peer.repo !== conn.repo) continue;
        if (peer.name === name) {
          peer.role = "orchestrator";
          peer.topics.add("reports");
        } else if (peer.role === "orchestrator") {
          peer.role = "worker";
          peer.topics.delete("reports");
        }
      }
    }
    send(conn.socket, {
      type: "orchestrator",
      orchestrator: store.getOrchestrator(conn.repo),
    });
  }

  function announce(conn: Conn, state: "online" | "offline"): void {
    if (!conn.authed || conn.harness === "cli" || !conn.repo) return;
    const message = store.insert({
      repo: conn.repo,
      id: randomUUID(),
      topic: "presence",
      fromId: conn.agentId || conn.name,
      fromName: conn.name,
      body: `${state} session=${conn.sessionId ?? "none"} role=${conn.role}`,
      ts: Date.now(),
      kind: "pub",
      correlationId: null,
      to: null,
    });
    fanout(message, conn);
    if (state === "offline") store.touchAgent(conn.repo, conn.name, "offline");
  }

  function clientKey(conn: Conn): string {
    return conn.declaredSession && !conn.declaredSession.startsWith("zellij:")
      ? `${conn.name}:${conn.declaredSession}`
      : conn.name;
  }

  async function publish(
    conn: Conn,
    frame: { topic: string; body: string; id?: string; to?: string },
    kind: BusMessage["kind"] = "pub",
    correlationId: string | null = null,
  ): Promise<void> {
    requireTopic(frame.topic);
    requireBody(frame.body);
    if (frame.to) requireName(frame.to);
    const message = store.insert({
      repo: conn.repo,
      id: frame.id || randomUUID(),
      topic: frame.topic,
      fromId: conn.agentId,
      fromName: conn.name,
      body: frame.body,
      ts: Date.now(),
      kind,
      correlationId,
      to: frame.to || null,
    });
    store.touchAgent(conn.repo, conn.name);
    fanout(message, conn);
    const wake = await wakeFor(conn.repo, message);
    send(conn.socket, {
      type: "published",
      id: message.id,
      seq: message.seq,
      wake,
      correlationId: message.correlationId,
    });
  }

  async function ask(conn: Conn, to: string, body: string, topic?: string): Promise<void> {
    requireName(to);
    const others = [...conns].filter(
      (peer) => peer.authed && peer.repo === conn.repo && peer.name === to && peer.socket !== conn.socket,
    );
    if (to === conn.name && others.length === 0) throw new Error("ask someone else");
    await publish(
      conn,
      { topic: topic || "dm", body, to, id: randomUUID() },
      "ask",
      randomUUID(),
    );
  }

  async function report(conn: Conn, body: string): Promise<void> {
    try {
      requireBody(body);
      const name = store.getOrchestrator(conn.repo);
      if (!name) throw new Error("no orchestrator yet");
      if (conn.role === "orchestrator") throw new Error("the orchestrator reads reports in bus_inbox");
      await publish(conn, { topic: "reports", body, to: name });
    } catch (error) {
      const message = error instanceof Error ? error.message : "request failed";
      send(conn.socket, { type: "error", error: message });
    }
  }

  async function reply(conn: Conn, correlationId: string, body: string): Promise<void> {
    if (!correlationId) throw new Error("correlation id required");
    const askMessage = store.byCorrelation(conn.repo, correlationId);
    if (!askMessage) throw new Error("no ask with that correlation id");
    const target =
      conn.name === askMessage.fromName && askMessage.to ? askMessage.to : askMessage.fromName;
    await publish(
      conn,
      {
        topic: askMessage.topic,
        body,
        to: target,
        id: randomUUID(),
      },
      "reply",
      correlationId,
    );
  }

  function inbox(conn: Conn, since: number | undefined, topic: string | undefined, limit: number | undefined): void {
    if (topic) requireTopic(topic);
    const key = clientKey(conn);
    const cursor = since ?? store.cursor(conn.repo, key);
    const pageSize = limit ?? 50;
    const messages = store.inbox(conn.repo, cursor, {
      topic,
      to: conn.name,
      limit: pageSize,
    });
    const next = messages.length ? messages[messages.length - 1]!.seq : cursor;
    if (messages.length) store.ack(conn.repo, key, next);
    store.touchAgent(conn.repo, conn.name);
    const updatedCursor = store.cursor(conn.repo, key);
    const pendingAsk = store.unansweredAsk(conn.repo, conn.name, updatedCursor);
    send(conn.socket, {
      type: "inbox",
      messages,
      cursor: updatedCursor,
      more: messages.length === pageSize,
      pendingAsk,
    });
  }

  function register(
    conn: Conn,
    frame: Extract<ClientFrame, { type: "register" }>,
  ): void {
    requireName(frame.name);
    if (!frame.cwd) throw new Error("cwd required");
    if (!frame.harness) throw new Error("harness required");
    store.upsertAgent({
      repo: conn.repo,
      name: frame.name,
      harness: frame.harness,
      sessionId: frame.sessionId || null,
      cwd: frame.cwd,
      wake: frame.wake,
      status: "registered",
    });
    send(conn.socket, { type: "registered", name: frame.name });
  }

  function fanout(message: BusMessage, origin: Conn): void {
    for (const peer of conns) {
      if (!peer.authed || peer.repo !== message.repo || peer.socket === origin.socket) continue;
      const directed = message.to === peer.name;
      const subscribed = peer.topics.has(message.topic);
      if (directed || subscribed) send(peer.socket, { type: "message", message });
    }
  }

  async function wakeFor(repo: string, message: BusMessage): Promise<WakeInfo> {
    if (!message.to) return decideWake({
      directed: false,
      online: false,
      harness: null,
      sessionId: null,
      wakeEnabled: false,
    });
    const target = describeTarget(repo, message.to);
    if (!target) {
      return { mode: "skip", detail: `no agent named ${message.to} in this repo` };
    }
    const info = decideWake({
      directed: true,
      online: target.online,
      harness: target.harness,
      sessionId: target.sessionId,
      wakeEnabled: target.wake,
    });
    if (info.mode !== "inject" && info.mode !== "headless") return info;
    const key = `${repo}:${message.to}`;
    const last = lastWake.get(key) ?? 0;
    if (Date.now() - last < WAKE_COOLDOWN_MS) {
      return { mode: "skip", detail: "wake is on cooldown; the message is in the log" };
    }
    const launch = launchFor({
      mode: info.mode,
      harness: target.harness,
      cwd: target.cwd,
      sessionId: target.sessionId,
      message,
    });
    if (!launch || !options.spawnWake) {
      return { mode: "skip", detail: "wake command is not available" };
    }
    try {
      if (options.logFile) logWake(options.logFile, launch, message.id);
      await options.spawnWake(launch);
      lastWake.set(key, Date.now());
      return info;
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "spawn failed";
      return { mode: "skip", detail: `wake failed: ${messageText}` };
    }
  }

  function describeTarget(repo: string, name: string): {
    harness: string;
    sessionId: string | null;
    cwd: string;
    wake: boolean;
    online: boolean;
  } | null {
    const live = [...conns].find(
      (conn) => conn.authed && conn.repo === repo && conn.name === name && conn.harness !== "cli",
    );
    const row = store.getAgent(repo, name);
    if (!live && !row) return null;
    return {
      harness: live?.harness || row!.harness,
      sessionId: (live?.sessionBound ? live.sessionId : null) || row?.sessionId || null,
      cwd: live?.cwd || row!.cwd,
      wake: live?.wake || row?.wake || false,
      online: Boolean(live),
    };
  }

  function agents(repo: string) {
    const orchestrator = store.getOrchestrator(repo);
    const live = [...conns].filter((conn) => conn.authed && conn.repo === repo && conn.harness !== "cli");
    const liveNames = new Set(live.map((conn) => conn.name));
    const rows = live.map((conn) => ({
      repo,
      name: conn.name,
      harness: conn.harness,
      sessionId: conn.sessionId,
      cwd: conn.cwd,
      wake: conn.wake,
      lastSeen: conn.lastSeen,
      online: true,
      status: conn.status || "online",
      role: conn.role,
    }));
    for (const row of store.listAgents(repo, new Set())) {
      if (!liveNames.has(row.name)) {
        rows.push({ ...row, role: row.name === orchestrator ? "orchestrator" : "worker" });
      }
    }
    rows.sort((a, b) => a.name.localeCompare(b.name) || (a.sessionId ?? "").localeCompare(b.sessionId ?? ""));
    return rows;
  }

  return {
    port,
    url: `ws://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        stopping = true;
        clearInterval(sweep);
        for (const conn of conns) conn.socket.close();
        wss.close(() => {
          http.close(() => {
            store.close();
            resolve();
          });
        });
      }),
  };
}

function send(socket: WebSocket, frame: ServerFrame): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
}

function requireTopic(topic: string): void {
  if (!TOPIC_RE.test(topic)) throw new Error(`bad topic: ${topic}`);
}

function requireName(name: string): void {
  if (!NAME_RE.test(name)) throw new Error(`bad name: ${name}`);
}

function requireBody(body: string): void {
  if (!body.trim()) throw new Error("empty message");
  if (body.length > BODY_MAX) throw new Error(`message is longer than ${BODY_MAX} bytes`);
}


