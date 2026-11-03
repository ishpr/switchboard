import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { resolveShimCwd } from "./init.ts";
import { gitCheckoutInfo, repoKey } from "./repo.ts";
import { createPaneProbe, formatDiagnostics, sessionDiagnostics, type PaneProbe } from "./health.ts";
import { BUILD, buildWarning, runtimeInfo } from "./build.ts";
import { Store, inboxCursorKey } from "./store.ts";
import {
  BODY_MAX,
  NAME_RE,
  PRESENCE_TTL_MS,
  TOPIC_RE,
  WAKE_COOLDOWN_MS,
  type BusMessage,
  type BuildInfo,
  type AgentRecord,
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
  presenceDebounceMs?: number;
};

export type DaemonHandle = {
  port: number;
  url: string;
  close: () => Promise<void>;
};

type Conn = {
  socket: WebSocket;
  build?: BuildInfo;
  authed: boolean;
  agentId: string;
  name: string;
  harness: string;
  repo: string;
  cwd: string;
  branch: string | null;
  head: string | null;
  sessionId: string | null;
  wakeSessionId: string | null;
  /** The client supplied sessionId, so this connection has its own inbox cursor. */
  declaredSession: string | null;
  sessionBound: boolean;
  waitOnly: boolean;
  wake: boolean;
  status: string;
  role: Role;
  topics: Set<string>;
  lastSeen: number;
};

type Respond = (frame: ServerFrame) => void;

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
  const waking = new Set<string>();
  const daemonInfo = runtimeInfo();
  const onlineGroups = new Set<string>();
  const pendingOffline = new Map<string, ReturnType<typeof setTimeout>>();

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
      branch: null,
      head: null,
      sessionId: null,
      wakeSessionId: null,
      declaredSession: null,
      sessionBound: false,
      waitOnly: false,
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

    let legacyQueue: Promise<void> = Promise.resolve();
    socket.on("message", (data) => {
      let frame: ClientFrame;
      try {
        frame = JSON.parse(data.toString()) as ClientFrame;
        if (!frame || typeof frame !== "object" || typeof frame.type !== "string") throw new Error("invalid frame");
        if (frame.reqId !== undefined && (typeof frame.reqId !== "string" || !frame.reqId || frame.reqId.length > 128)) throw new Error("invalid reqId");
      } catch {
        send(socket, { type: "error", error: "invalid frame or JSON" });
        return;
      }
      const reqId = frame.reqId;
      const respond: Respond = (response) => send(socket, { ...response, ...(reqId ? { reqId } : {}) });
      const dispatch = async () => {
        try { await handle(conn, frame, respond); }
        catch (error) { respond({ type: "error", error: error instanceof Error ? error.message : "request failed" }); }
      };
      // Old clients have no request IDs: serialize their dispatches to preserve their FIFO contract.
      if (reqId) void dispatch();
      else legacyQueue = legacyQueue.then(dispatch);
    });

    socket.on("close", () => {
      clearTimeout(helloTimer);
      const gone = conn.authed;
      conns.delete(conn);
      if (gone && !stopping) presence(conn, "offline");
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

  async function handle(conn: Conn, frame: ClientFrame, respond: Respond): Promise<void> {
    conn.lastSeen = Date.now();
    if (!conn.authed) {
      if (frame.type !== "hello") {
        respond({ type: "error", error: "hello required" });
        conn.socket.close(1008, "hello required");
        return;
      }
      hello(conn, frame, respond);
      return;
    }
    if (frame.type === "hello") {
      respond({ type: "error", error: "already joined" });
      return;
    }
    switch (frame.type) {
      case "publish":
        await publish(conn, frame, respond);
        break;
      case "subscribe":
        for (const topic of frame.topics) requireTopic(topic);
        for (const topic of frame.topics) conn.topics.add(topic);
        respond({ type: "ok", detail: `subscribed ${[...frame.topics].join(",")}` });
        break;
      case "unsubscribe":
        for (const topic of frame.topics) conn.topics.delete(topic);
        respond({ type: "ok", detail: "unsubscribed" });
        break;
      case "inbox":
        inbox(conn, frame.since, frame.topic, frame.limit, respond);
        break;
      case "ack":
        store.ack(conn.repo, clientKey(conn), frame.cursor);
        respond({ type: "ok", detail: "acked" });
        break;
      case "doctor":
        await sendDoctor(conn, frame, respond);
        break;
      case "who":
        await sendWho(conn, respond);
        break;
      case "ask":
        await ask(conn, frame.to, frame.body, frame.topic, respond);
        break;
      case "reply":
        await reply(conn, frame.correlationId, frame.body, respond);
        break;
      case "report":
        await report(conn, frame.body, respond);
        break;
      case "status":
        if (frame.limit !== undefined && (!Number.isInteger(frame.limit) || frame.limit < 1 || frame.limit > 200)) {
          throw new Error("status limit must be an integer from 1 to 200");
        }
        if (frame.status !== undefined) {
          if (typeof frame.status !== "string") throw new Error("status must be a string");
          conn.status = frame.status;
          for (const peer of conns) {
            if (peer.authed && peer.repo === conn.repo && peer.name === conn.name
              && (conn.harness === "cli" || groupKey(peer) === groupKey(conn))) peer.status = frame.status;
          }
          store.touchAgent(conn.repo, conn.name, frame.status, conn.sessionId);
        }
        await sendStatus(conn, frame, respond);
        break;
      case "orchestrator":
        setOrchestrator(conn, frame.name, respond);
        break;
      case "register":
        register(conn, frame, respond);
        break;
      case "heartbeat":
        store.touchAgent(conn.repo, conn.name, undefined, conn.sessionId);
        break;
      default:
        respond({ type: "error", error: "unknown frame" });
    }
  }

  async function diagnostics(agent: AgentRecord, probe: PaneProbe) {
    const result = await sessionDiagnostics(agent, probe);
    for (const build of agent.builds ?? []) {
      const warning = buildWarning(BUILD, build);
      if (warning && !result.warnings.includes(warning)) result.warnings.push(`MCP ${warning}`);
    }
    const unknownBuilds = (agent.connectionCount ?? 0) - (agent.builds?.length ?? 0);
    if (agent.online && unknownBuilds > 0) result.warnings.push(`${unknownBuilds} client connection(s) missing build metadata; reconnect MCP after upgrading`);
    return result;
  }

  async function sendWho(conn: Conn, respond: Respond): Promise<void> {
    const probe = options.paneProbe ?? createPaneProbe();
    const rows = await Promise.all(agents(conn.repo).map(async (agent) => ({
      ...agent, diagnostics: await diagnostics(agent, probe),
    })));
    respond({ type: "who", agents: rows, daemon: daemonInfo });
  }

  async function sendDoctor(conn: Conn, frame: Extract<ClientFrame, { type: "doctor" }>, respond: Respond): Promise<void> {
    const repos = frame.all
      ? [...new Set([...store.listRepos(), ...[...conns].filter((peer) => peer.authed).map((peer) => peer.repo)])].sort()
      : [conn.repo];
    const probe = options.paneProbe ?? createPaneProbe();
    const candidates = repos.flatMap((repo) => agents(repo)).map((agent) => ({
      agent,
      stored: store.getAgent(agent.repo, agent.sessionId || agent.name),
    }));
    const rows = await Promise.all(candidates.map(async ({ agent }) => ({
      ...agent, diagnostics: await diagnostics(agent, probe),
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
        const targetId = row.sessionId ?? row.wakeSessionId ?? null;
        const ownsRegistration = stored?.sessionId === targetId;
        if (ownsRegistration && !store.pruneAgent(stored!, reason)) continue;
        let clearedLiveBinding = false;
        if (reason === "dead_pane") {
          for (const peer of conns) {
            if (
              peer.authed &&
              peer.repo === row.repo &&
              peer.name === row.name &&
              (peer.sessionId === targetId || peer.wakeSessionId === targetId)
            ) {
              peer.sessionBound = false;
              peer.sessionId = null;
              peer.wakeSessionId = null;
              clearedLiveBinding = true;
            }
          }
        }
        if (!ownsRegistration && !clearedLiveBinding) continue;
        pruned.push({ repo: row.repo, name: row.name, sessionId: targetId, reason });
      }
    }
    // Report the scan plus the exact mutations; last-seen timestamps remain historical evidence.
    respond({ type: "doctor", agents: rows, pruned, daemon: daemonInfo });
  }

  async function sendStatus(conn: Conn, frame: Extract<ClientFrame, { type: "status" }>, respond: Respond): Promise<void> {
    // A CLI status update must diagnose the registered/live agent, not its ephemeral CLI socket.
    const rows = agents(conn.repo);
    const row = rows.find((row) => row.name === conn.name && row.sessionId === conn.sessionId)
      ?? rows.find((row) => row.name === conn.name);
    const detail = row && !frame.pending ? formatDiagnostics(await sessionDiagnostics(row, options.paneProbe ?? createPaneProbe())) : "";
    respond({
      type: "ok",
      daemon: daemonInfo,
      detail: `${frame.status === undefined ? "status" : "status updated"}${detail ? `; ${detail}` : ""}`,
      pending_asks: store.pendingAsks(conn.repo, frame.limit, Date.now(),
        conn.role === "orchestrator" || conn.harness === "cli" ? undefined : conn.name),
      agent_metrics: store.agentMetrics(conn.repo,
        conn.role === "orchestrator" || conn.harness === "cli" ? undefined : conn.name),
    });
  }

  function hello(conn: Conn, frame: Extract<ClientFrame, { type: "hello" }>, respond: Respond): void {
    if (frame.token !== options.token) {
      respond({ type: "error", error: "bad token" });
      conn.socket.close(1008, "bad token");
      return;
    }
    requireName(frame.name);
    if (!frame.repoKey || frame.repoKey.length > 64) throw new Error("repo key required");
    if (!frame.cwd) throw new Error("cwd required");
    const effectiveCwd = frame.cwd === "/" ? resolveShimCwd("/") : frame.cwd;
    const effectiveRepo = frame.cwd === "/" && effectiveCwd !== "/" ? repoKey(effectiveCwd) : frame.repoKey;
    const declaredSession = frame.sessionId || null;
    const existing =
      (declaredSession ? store.getAgentBySession(effectiveRepo, declaredSession) : undefined) ??
      store.getAgent(effectiveRepo, frame.name);
    conn.authed = true;
    conn.agentId = randomUUID();
    conn.name = frame.name;
    conn.waitOnly = Boolean(frame.waitOnly);
    conn.harness = (conn.waitOnly && existing && (!frame.harness || frame.harness === "wait" || frame.harness === "unknown"))
      ? existing.harness
      : (frame.harness || "unknown");
    conn.repo = effectiveRepo;
    conn.cwd = effectiveCwd;
    conn.branch = frame.branch ?? existing?.branch ?? null;
    conn.head = frame.head ?? existing?.head ?? null;
    conn.declaredSession = declaredSession;
    conn.sessionBound = Boolean(frame.boundSession && declaredSession);
    conn.sessionId = conn.declaredSession;
    conn.wakeSessionId = frame.wakeSessionId || (conn.sessionBound ? conn.sessionId : existing?.sessionId ?? null);
    conn.build = frame.build;
    conn.wake = frame.wake === undefined ? (existing?.wake ?? false) : frame.wake;
    conn.status = [...conns].find((peer) => peer !== conn && peer.authed && groupKey(peer) === groupKey(conn))?.status
      || frame.status || existing?.status || "online";
    conn.role = elect(conn.repo, conn.name, frame.role === "orchestrator");
    conn.topics.add("repo");
    conn.topics.add("presence");
    if (conn.role === "orchestrator") conn.topics.add("reports");
    if (conn.cwd !== "/" && conn.harness !== "cli" && !conn.waitOnly && (!existing || conn.sessionBound)) {
      store.upsertAgent({
        repo: conn.repo,
        name: conn.name,
        harness: conn.harness,
        sessionId: conn.sessionBound ? conn.declaredSession : (existing?.sessionId ?? null),
        cwd: conn.cwd,
        branch: conn.branch,
        head: conn.head,
        wake: conn.wake,
        status: conn.status,
      });
    } else if (conn.cwd !== "/" && conn.harness !== "cli" && conn.waitOnly && !existing) {
      store.upsertAgent({
        repo: conn.repo,
        name: conn.name,
        harness: conn.harness,
        sessionId: conn.sessionBound ? conn.declaredSession : null,
        cwd: conn.cwd,
        branch: conn.branch,
        head: conn.head,
        wake: conn.wake,
        status: conn.status,
      });
    } else if (conn.cwd !== "/" && conn.harness !== "cli") {
      store.touchAgent(conn.repo, conn.name, undefined, conn.sessionId);
    }
    respond({
      type: "welcome",
      daemon: daemonInfo,
      agentId: conn.agentId,
      repoKey: conn.repo,
      cursor: store.cursor(conn.repo, clientKey(conn)),
      role: conn.role,
      orchestrator: store.getOrchestrator(conn.repo),
    });
    presence(conn, "online");
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

  function setOrchestrator(conn: Conn, name: string | undefined, respond: Respond): void {
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
    respond({
      type: "orchestrator",
      orchestrator: store.getOrchestrator(conn.repo),
    });
  }

  function groupKey(conn: Conn): string {
    return JSON.stringify([conn.repo, conn.name, conn.declaredSession]);
  }

  function presence(conn: Conn, state: "online" | "offline"): void {
    if (conn.harness === "cli" || stopping) return;
    if (
      conn.waitOnly &&
      [...conns].some(
        (peer) =>
          peer !== conn &&
          peer.authed &&
          peer.repo === conn.repo &&
          peer.name === conn.name &&
          peer.harness !== "cli" &&
          !peer.waitOnly,
      )
    ) {
      return;
    }
    const key = groupKey(conn);
    if (state === "online") {
      const pending = pendingOffline.get(key);
      if (pending) { clearTimeout(pending); pendingOffline.delete(key); }
      if (!onlineGroups.has(key)) { onlineGroups.add(key); announce(conn, "online"); }
      return;
    }
    if ([...conns].some((peer) => peer.authed && groupKey(peer) === key && peer.harness !== "cli")) return;
    if (pendingOffline.has(key)) return;
    const timer = setTimeout(() => {
      pendingOffline.delete(key);
      if (stopping) return;
      if ([...conns].some((peer) => peer.authed && groupKey(peer) === key && peer.harness !== "cli")) return;
      onlineGroups.delete(key);
      announce(conn, "offline");
    }, options.presenceDebounceMs ?? 250);
    timer.unref?.();
    pendingOffline.set(key, timer);
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
    if (
      state === "offline" &&
      ![...conns].some(
        (peer) =>
          peer.authed &&
          peer.repo === conn.repo &&
          peer.harness !== "cli" &&
          (conn.sessionId ? peer.sessionId === conn.sessionId : peer.name === conn.name),
      )
    ) {
      store.touchAgent(conn.repo, conn.name, "offline", conn.sessionId);
    }
  }

  function clientKey(conn: Conn): string {
    return conn.declaredSession && !conn.declaredSession.startsWith("zellij:")
      ? `${conn.name}:${conn.declaredSession}`
      : conn.name;
  }

  async function publish(
    conn: Conn,
    frame: { topic: string; body: string; id?: string; to?: string },
    respond: Respond,
    kind: BusMessage["kind"] = "pub",
    correlationId: string | null = null,
  ): Promise<void> {
    requireTopic(frame.topic);
    requireBody(frame.body);
    if (frame.to !== undefined && frame.to !== "*") requireName(frame.to);
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
      to: frame.to === "*" ? null : frame.to || null,
    });
    store.touchAgent(conn.repo, conn.name, undefined, conn.sessionId);
    fanout(message, conn);
    const wake = await wakeFor(conn.repo, message);
    respond({
      type: "published",
      id: message.id,
      seq: message.seq,
      wake,
      correlationId: message.correlationId,
    });
  }

  async function ask(conn: Conn, to: string, body: string, topic: string | undefined, respond: Respond): Promise<void> {
    requireName(to);
    const others = [...conns].filter(
      (peer) =>
        peer.authed &&
        peer.repo === conn.repo &&
        (peer.name === to || peer.sessionId === to || peer.declaredSession === to) &&
        peer.socket !== conn.socket,
    );
    if ((to === conn.name || to === conn.sessionId || to === conn.declaredSession) && others.length === 0) {
      throw new Error("ask someone else");
    }
    await publish(
      conn,
      { topic: topic || "dm", body, to, id: randomUUID() },
      respond,
      "ask",
      randomUUID(),
    );
  }

  async function report(conn: Conn, body: string, respond: Respond): Promise<void> {
    try {
      requireBody(body);
      const name = store.getOrchestrator(conn.repo);
      if (!name) throw new Error("no orchestrator yet");
      if (conn.role === "orchestrator") throw new Error("the orchestrator reads reports in bus_inbox");
      await publish(conn, { topic: "reports", body, to: name }, respond);
    } catch (error) {
      const message = error instanceof Error ? error.message : "request failed";
      respond({ type: "error", error: message });
    }
  }

  async function reply(conn: Conn, correlationId: string, body: string, respond: Respond): Promise<void> {
    if (typeof correlationId !== "string" || !correlationId) throw new Error("correlation id required");
    const askMessage = store.byCorrelation(conn.repo, correlationId);
    if (!askMessage) throw new Error("no ask with that correlation id");
    const isRecipient =
      conn.name === askMessage.to ||
      (conn.sessionId !== null && conn.sessionId === askMessage.to) ||
      (conn.declaredSession !== null && conn.declaredSession === askMessage.to);
    if (!isRecipient && conn.name !== askMessage.fromName) throw new Error("only ask participants may reply");
    const target =
      conn.name === askMessage.fromName && !isRecipient && askMessage.to ? askMessage.to : askMessage.fromName;
    await publish(
      conn,
      {
        topic: askMessage.topic,
        body,
        to: target,
        id: randomUUID(),
      },
      respond,
      "reply",
      correlationId,
    );
  }

  function inbox(conn: Conn, since: number | undefined, topic: string | undefined, limit: number | undefined, respond: Respond): void {
    if (topic) requireTopic(topic);
    const baseKey = clientKey(conn);
    const key = inboxCursorKey(baseKey, topic);
    const cursor = since ?? store.cursor(conn.repo, key);
    if (since !== undefined && (!Number.isSafeInteger(since) || since < 0)) throw new Error("invalid inbox sequence");
    const pageSize = limit ?? 50;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) throw new Error("inbox limit must be 1..200");
    const messages = store.inbox(conn.repo, cursor, {
      topic,
      to: conn.name,
      sessionId: conn.sessionId,
      limit: pageSize,
    });
    const next = messages.length ? messages[messages.length - 1]!.seq : cursor;
    if (messages.length) store.ack(conn.repo, key, next);
    store.touchAgent(conn.repo, conn.name, undefined, conn.sessionId);
    const updatedCursor = store.cursor(conn.repo, key);
    const pendingAsk = store.unansweredAsk(conn.repo, conn.name, updatedCursor, 0, conn.sessionId);
    respond({
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
    respond: Respond,
  ): void {
    requireName(frame.name);
    if (!frame.cwd) throw new Error("cwd required");
    if (!frame.harness) throw new Error("harness required");
    const existing = frame.sessionId
      ? store.getAgentBySession(conn.repo, frame.sessionId)
      : store.getAgent(conn.repo, frame.name);
    if (frame.sessionId && !frame.sessionId.startsWith("zellij:")) {
      const sessionKey = `${frame.name}:${frame.sessionId}`;
      const baseCursor = store.cursor(conn.repo, frame.name);
      if (store.cursor(conn.repo, sessionKey) === 0 && baseCursor > 0) {
        store.ack(conn.repo, sessionKey, baseCursor);
      }
    }
    const checkout =
      frame.branch !== undefined || frame.head !== undefined
        ? { branch: frame.branch ?? null, head: frame.head ?? null }
        : gitCheckoutInfo(frame.cwd);
    const wake = frame.wake === undefined ? (existing?.wake ?? conn.wake) : frame.wake;
    const status = conn.harness === "cli" ? (existing?.status || "registered") : (conn.status || "online");
    const saved = store.upsertAgent({
      repo: conn.repo,
      name: frame.name,
      harness: frame.harness,
      sessionId: frame.sessionId || null,
      cwd: frame.cwd,
      branch: checkout.branch,
      head: checkout.head,
      wake,
      status,
      bySession: Boolean(frame.sessionId),
    });
    if (conn.harness !== "cli") {
      if (frame.sessionId) {
        conn.declaredSession = frame.sessionId;
        conn.sessionId = frame.sessionId;
        conn.sessionBound = true;
      }
      if (frame.wakeSessionId || frame.sessionId) {
        conn.wakeSessionId = frame.wakeSessionId || frame.sessionId || conn.wakeSessionId;
      }
      conn.branch = checkout.branch ?? conn.branch;
      conn.head = checkout.head ?? conn.head;
      conn.wake = wake;
    } else {
      for (const peer of conns) {
        if (!peer.authed || peer.repo !== conn.repo || peer.name !== frame.name || peer.harness === "cli") continue;
        if (!peer.sessionBound && frame.sessionId) {
          peer.declaredSession = frame.sessionId;
          peer.sessionId = frame.sessionId;
          peer.sessionBound = true;
        }
        if (frame.wakeSessionId || frame.sessionId) {
          peer.wakeSessionId = frame.wakeSessionId || frame.sessionId || peer.wakeSessionId;
        }
        peer.branch = checkout.branch ?? peer.branch;
        peer.head = checkout.head ?? peer.head;
        peer.wake = wake;
      }
    }
    respond({ type: "registered", name: frame.name, agent: saved, created: !existing });
  }

  function fanout(message: BusMessage, origin: Conn): void {
    for (const peer of conns) {
      if (!peer.authed || peer.repo !== message.repo || peer.socket === origin.socket) continue;
      const delivered =
        message.to && message.to !== "*"
          ? message.to === peer.name || message.to === peer.sessionId || message.to === peer.declaredSession
          : peer.topics.has(message.topic);
      if (delivered) send(peer.socket, { type: "message", message });
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
    const key = JSON.stringify([repo, message.to]);
    const last = lastWake.get(key) ?? 0;
    if (waking.has(key) || Date.now() - last < WAKE_COOLDOWN_MS) {
      return { mode: "skip", detail: "wake is in flight or on cooldown; the message is in the log" };
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
    waking.add(key);
    try {
      if (options.logFile) logWake(options.logFile, launch, message.id);
      await options.spawnWake(launch);
      lastWake.set(key, Date.now());
      return info;
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "spawn failed";
      return { mode: "skip", detail: `wake failed: ${messageText}` };
    } finally {
      waking.delete(key);
    }
  }

  function describeTarget(repo: string, target: string): {
    harness: string;
    sessionId: string | null;
    cwd: string;
    wake: boolean;
    online: boolean;
  } | null {
    const bySession = [...conns].filter(
      (conn) =>
        conn.authed &&
        conn.repo === repo &&
        conn.harness !== "cli" &&
        (conn.sessionId === target || conn.declaredSession === target),
    );
    const byName = [...conns].filter(
      (conn) => conn.authed && conn.repo === repo && conn.name === target && conn.harness !== "cli",
    );
    const candidates = bySession.length > 0 ? bySession : byName;
    const row = store.getAgent(repo, target);
    const live = candidates.find((conn) => conn.sessionBound && conn.sessionId === row?.sessionId)
      ?? candidates.find((conn) => conn.sessionBound) ?? candidates[0];
    if (!live && !row) return null;
    const liveWakeSession = live?.wakeSessionId || (live?.sessionBound ? live.sessionId : null);
    return {
      harness: live?.sessionBound ? live.harness : row?.harness ?? live!.harness,
      sessionId: liveWakeSession || row?.sessionId || null,
      cwd: live?.sessionBound ? live.cwd : row?.cwd ?? live!.cwd,
      wake: row?.wake ?? live?.wake ?? false,
      online: Boolean(live),
    };
  }

  function agents(repo: string): AgentRecord[] {
    const orchestrator = store.getOrchestrator(repo);
    const nonWaitConns = [...conns].filter(
      (c) => c.authed && c.repo === repo && c.harness !== "cli" && !c.waitOnly,
    );
    const hasNonWaitByName = new Set(nonWaitConns.map((c) => c.name));
    const hasNonWaitByGroup = new Set(nonWaitConns.map((c) => groupKey(c)));
    const groups = new Map<string, Conn[]>();
    for (const conn of conns) {
      if (!conn.authed || conn.repo !== repo || conn.harness === "cli") continue;
      const key = groupKey(conn);
      if (conn.waitOnly && (hasNonWaitByGroup.has(key) || (!conn.declaredSession && hasNonWaitByName.has(conn.name)))) {
        continue;
      }
      const members = groups.get(key) ?? [];
      members.push(conn);
      groups.set(key, members);
    }
    const rows: AgentRecord[] = [...groups.values()].map((members) => {
      const nonWait = members.filter((member) => !member.waitOnly);
      const counted = nonWait.length > 0 ? nonWait : [members.reduce((a, b) => a.lastSeen >= b.lastSeen ? a : b)];
      const conn = counted.reduce((a, b) => a.lastSeen >= b.lastSeen ? a : b);
      const registered =
        (conn.sessionId ? store.getAgentBySession(repo, conn.sessionId) : undefined) ??
        store.getAgent(repo, conn.name);
      return {
        repo,
        name: conn.name,
        harness: conn.harness,
        sessionId: conn.sessionId,
        wakeSessionId: conn.wakeSessionId || (conn.sessionBound ? conn.sessionId : registered?.sessionId ?? null),
        cwd: conn.cwd,
        branch: conn.branch ?? registered?.branch ?? null,
        head: conn.head ?? registered?.head ?? null,
        wake: registered?.wake ?? conn.wake,
        lastSeen: Math.max(...members.map((member) => member.lastSeen)),
        online: true,
        status: conn.status || "online",
        role: conn.role,
        connectionCount: counted.length,
        connectionIds: counted.map((member) => member.agentId),
        builds: counted.flatMap((member) => (member.build ? [member.build] : [])),
      };
    });
    const liveNames = new Set(rows.map((row) => row.name));
    const liveSessions = new Set(rows.flatMap((row) => (row.sessionId ? [row.sessionId] : [])));
    for (const row of store.listAgents(repo, new Set())) {
      const represented = row.sessionId
        ? liveSessions.has(row.sessionId) || rows.some((live) => live.name === row.name && !live.sessionId)
        : liveNames.has(row.name);
      if (!represented) {
        rows.push({
          ...row,
          wakeSessionId: row.sessionId,
          connectionCount: 0,
          role: row.name === orchestrator ? "orchestrator" : "worker",
        });
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
        for (const timer of pendingOffline.values()) clearTimeout(timer);
        pendingOffline.clear();
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
  if (typeof topic !== "string" || !TOPIC_RE.test(topic)) throw new Error(`bad topic: ${topic}`);
}

function requireName(name: string): void {
  if (typeof name !== "string" || !NAME_RE.test(name)) throw new Error(`bad name: ${name}`);
}

function requireBody(body: string): void {
  if (typeof body !== "string") throw new Error("message body must be a string");
  if (!body.trim()) throw new Error("empty message");
  if (body.length > BODY_MAX) throw new Error(`message is longer than ${BODY_MAX} bytes`);
}


