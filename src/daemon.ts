import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  defaultSpawnTerminalTab,
  discoverRatioBinding,
  readRepoConfigByKey,
  resolveInvitedAgentSpec,
  resolveOrchestratorName,
  resolveShimCwd,
  type SpawnTerminalTab,
} from "./init.ts";
import { gitCheckoutInfo, gitRepoRoot, repoKey } from "./repo.ts";
import { createPaneProbe, formatDiagnostics, sessionDiagnostics, type PaneProbe } from "./health.ts";
import { BUILD, buildWarning, runtimeInfo } from "./build.ts";
import { extractStateRatioProject } from "./status.ts";
import { Store, inboxCursorKey } from "./store.ts";
import {
  BODY_MAX,
  NAME_RE,
  PRESENCE_TTL_MS,
  STATE_KEY_RE,
  TOPIC_RE,
  WAKE_COOLDOWN_MS,
  type BusMessage,
  type BuildInfo,
  type AgentRecord,
  type ClientFrame,
  type InviteMode,
  type InvitedAgent,
  type ReplyState,
  type Role,
  type ServerFrame,
  type WakeInfo,
  type PrunedAgent,
} from "./types.ts";
import { TTY_RE, UUID_RE, decideWake, isCodexTurnInProgress, launchFor, logWake, type SpawnWake } from "./wake.ts";

export type DaemonOptions = {
  /** Use port 0 in tests to take a free port. */
  port: number;
  dbFile: string;
  token: string;
  spawnWake?: SpawnWake;
  spawnTerminal?: SpawnTerminalTab;
  logFile?: string;
  presenceTtlMs?: number;
  sweepMs?: number;
  paneProbe?: PaneProbe;
  presenceDebounceMs?: number;
  wakeCooldownMs?: number;
  isTurnInProgress?: (harness: string, sessionId: string | null) => boolean;
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
  const wakeCooldownMs = options.wakeCooldownMs ?? WAKE_COOLDOWN_MS;
  const turnInProgress =
    options.isTurnInProgress ??
    ((harness: string, sessionId: string | null) =>
      harness === "codex" && isCodexTurnInProgress(sessionId));
  const trailingWakes = new Map<string, ReturnType<typeof setTimeout>>();
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
      case "subscribe": {
        requireBoundRepo(conn);
        for (const topic of frame.topics) requireTopic(topic);
        const sinceSeq = store.maxSeq(conn.repo);
        store.subscribe(conn.repo, subscriptionKey(conn), frame.topics, sinceSeq);
        for (const topic of frame.topics) {
          conn.topics.add(topic);
          for (const peer of conns) {
            if (peer.authed && groupKey(peer) === groupKey(conn)) peer.topics.add(topic);
          }
        }
        const joined = [...frame.topics].join(",");
        respond({
          type: "ok",
          detail: `subscribed ${joined}; live from now on. Read older mail with bus_inbox and topic=${joined}.`,
        });
        break;
      }
      case "unsubscribe": {
        requireBoundRepo(conn);
        for (const topic of frame.topics) requireTopic(topic);
        const removable = frame.topics.filter((topic) => topic !== "repo" && topic !== "presence");
        store.unsubscribe(conn.repo, subscriptionKey(conn), removable);
        for (const topic of removable) {
          conn.topics.delete(topic);
          for (const peer of conns) {
            if (peer.authed && groupKey(peer) === groupKey(conn)) peer.topics.delete(topic);
          }
        }
        const kept = frame.topics.filter((topic) => topic === "repo" || topic === "presence");
        respond({
          type: "ok",
          detail: kept.length
            ? `unsubscribed${removable.length ? ` ${removable.join(",")}` : ""}; ${kept.join(",")} cannot be removed`
            : "unsubscribed",
        });
        break;
      }
      case "inbox":
        inbox(conn, frame.since, frame.topic, frame.limit, frame.ack, respond);
        break;
      case "ack":
        requireBoundRepo(conn);
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
        await ask(conn, frame.to, frame.body, frame.topic, frame.supersedes, respond);
        break;
      case "reply":
        await reply(conn, frame.correlationId, frame.body, frame.state, respond);
        break;
      case "report":
        await report(conn, frame.body, respond);
        break;
      case "state":
        handleState(conn, frame, respond);
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
      case "invite":
        await invite(conn, frame, respond);
        break;
      case "heartbeat":
        store.touchAgent(conn.repo, conn.name, undefined, conn.sessionId);
        break;
      default:
        respond({ type: "error", error: "unknown frame" });
    }
  }

  function expectedRatioProject(
    repo: string,
    rows: AgentRecord[],
  ): { expected: string | null; splitProjects?: string[] } {
    const stateEntries = store.listState(repo);
    const fromState = extractStateRatioProject(stateEntries);
    if (fromState) return { expected: fromState };
    const cfg = readRepoConfigByKey(repo);
    if (cfg?.ratioProject?.trim()) return { expected: cfg.ratioProject.trim() };
    const onlineWithRatio = rows.filter((r) => r.online && r.ratio?.project && r.ratio.project !== "unpinned");
    const distinctOnline = [...new Set(onlineWithRatio.map((r) => r.ratio!.project))].sort();
    if (distinctOnline.length > 1) {
      return { expected: null, splitProjects: distinctOnline };
    }
    return { expected: null };
  }

  async function diagnostics(
    agent: AgentRecord,
    probe: PaneProbe,
    ratioCheck?: { expected: string | null; splitProjects?: string[] },
  ) {
    const result = await sessionDiagnostics(agent, probe);
    for (const build of agent.builds ?? []) {
      const warning = buildWarning(BUILD, build);
      const formatted = warning ? `MCP ${warning}` : null;
      if (formatted && !result.warnings.includes(formatted)) result.warnings.push(formatted);
    }
    const unknownBuilds = (agent.connectionCount ?? 0) - (agent.builds?.length ?? 0);
    if (agent.online && unknownBuilds > 0) result.warnings.push(`${unknownBuilds} client connection(s) missing build metadata; reconnect MCP after upgrading`);
    if (ratioCheck?.expected && agent.ratio?.project && agent.ratio.project !== ratioCheck.expected) {
      result.warnings.push(
        `Ratio project mismatch (configured MCP header): agent has X-Ratio-Project=${agent.ratio.project} (${agent.ratio.source}), expected ${ratioCheck.expected}`,
      );
    } else if (
      ratioCheck?.splitProjects &&
      agent.online &&
      agent.ratio?.project &&
      agent.ratio.project !== "unpinned"
    ) {
      result.warnings.push(
        `Ratio project split across online agents (${ratioCheck.splitProjects.join(" vs ")}); set bus_state key="ratio:project" or "contract" ratio_project to pin the board`,
      );
    }
    return result;
  }

  async function sendWho(conn: Conn, respond: Respond): Promise<void> {
    const probe = options.paneProbe ?? createPaneProbe();
    const baseRows = agents(conn.repo);
    const ratioCheck = expectedRatioProject(conn.repo, baseRows);
    const rows = await Promise.all(baseRows.map(async (agent) => ({
      ...agent, diagnostics: await diagnostics(agent, probe, ratioCheck),
    })));
    respond({ type: "who", agents: rows, daemon: daemonInfo });
  }

  async function sendDoctor(conn: Conn, frame: Extract<ClientFrame, { type: "doctor" }>, respond: Respond): Promise<void> {
    const repos = frame.all
      ? [...new Set([...store.listRepos(), ...[...conns].filter((peer) => peer.authed).map((peer) => peer.repo)])].sort()
      : [conn.repo];
    const probe = options.paneProbe ?? createPaneProbe();
    const ratioByRepo = new Map<string, { expected: string | null; splitProjects?: string[] }>();
    const candidates = repos.flatMap((repo) => {
      const repoAgents = agents(repo, { includeAllOffline: true });
      ratioByRepo.set(repo, expectedRatioProject(repo, repoAgents));
      return repoAgents;
    }).map((agent) => ({
      agent,
      stored: store.getAgent(agent.repo, agent.sessionId || agent.name),
    }));
    const rows = await Promise.all(candidates.map(async ({ agent }) => ({
      ...agent, diagnostics: await diagnostics(agent, probe, ratioByRepo.get(agent.repo)),
    })));
    const pruned: PrunedAgent[] = [];
    if (frame.prune) {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        const stored = candidates[i]!.stored;
        const reason = row.diagnostics.health;
        if (reason !== "dead_pane" && reason !== "stale") continue;
        const current = agents(row.repo, { includeAllOffline: true }).find((peer) => peer.name === row.name && peer.sessionId === row.sessionId);
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
    const boardState = store
      .listState(conn.repo)
      .filter(
        (e) =>
          e.key === "contract" ||
          e.key === "ratio:project" ||
          e.key.startsWith("verdict:") ||
          e.key.startsWith("verdict/"),
      );
    respond({
      type: "ok",
      daemon: daemonInfo,
      detail: `${frame.status === undefined ? "status" : "status updated"}${detail ? `; ${detail}` : ""}`,
      pending_asks: store.pendingAsks(conn.repo, frame.limit, Date.now(),
        conn.role === "orchestrator" || conn.harness === "cli" ? undefined : conn.name),
      agent_metrics: store.agentMetrics(conn.repo,
        conn.role === "orchestrator" || conn.harness === "cli" ? undefined : conn.name),
      board_state: boardState,
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
    conn.wakeSessionId =
      frame.wakeSessionId ||
      ((!conn.sessionBound || conn.sessionId === existing?.sessionId) ? existing?.wakeSessionId : null) ||
      (conn.sessionBound ? conn.sessionId : existing?.sessionId ?? null);
    conn.build = frame.build;
    conn.wake = frame.wake === undefined ? (existing?.wake ?? false) : frame.wake;
    conn.status = [...conns].find((peer) => peer !== conn && peer.authed && groupKey(peer) === groupKey(conn))?.status
      || frame.status || existing?.status || "online";
    conn.role = conn.cwd === "/" ? "worker" : elect(conn.repo, conn.name, frame.role === "orchestrator");
    if (conn.cwd !== "/") {
      restoreSubscriptions(conn);
      if (declaredSession && !declaredSession.startsWith("zellij:")) {
        const sessionKey = `${conn.name}:${declaredSession}`;
        const baseCursor = store.cursor(conn.repo, conn.name);
        if (store.cursor(conn.repo, sessionKey) === 0 && baseCursor > 0) {
          store.ack(conn.repo, sessionKey, baseCursor);
        }
      }
    }
    if (conn.cwd !== "/" && conn.harness !== "cli" && !conn.waitOnly && (!existing || conn.sessionBound)) {
      if (!isSessionLiveInOtherRepo(conn.repo, conn.declaredSession, frame.wakeSessionId)) {
        store.evictCrossRepoBinding(conn.repo, conn.declaredSession, frame.wakeSessionId);
      }
      store.upsertAgent({
        repo: conn.repo,
        name: conn.name,
        harness: conn.harness,
        sessionId: conn.sessionBound ? conn.declaredSession : (existing?.sessionId ?? null),
        wakeSessionId: frame.wakeSessionId ?? existing?.wakeSessionId ?? null,
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
        wakeSessionId: frame.wakeSessionId ?? null,
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
      cursor: conn.cwd === "/" ? 0 : store.cursor(conn.repo, clientKey(conn)),
      role: conn.role,
      orchestrator: conn.cwd === "/" ? null : store.getOrchestrator(conn.repo),
    });
    if (conn.cwd !== "/") {
      presence(conn, "online");
      replayDeferredWakes(conn.repo);
    }
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
    requireBoundRepo(conn);
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
          if (!store.subscriptions(conn.repo, subscriptionKey(peer)).has("reports")) {
            peer.topics.delete("reports");
          }
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

  function subscriptionKey(conn: Conn): string {
    if (conn.sessionId) return conn.sessionId;
    if (conn.declaredSession) return conn.declaredSession;
    const stored = store.getAgent(conn.repo, conn.name);
    if (stored?.sessionId) return stored.sessionId;
    return `name:${conn.name}`;
  }

  function restoreSubscriptions(conn: Conn): void {
    conn.topics.add("repo");
    conn.topics.add("presence");
    if (conn.role === "orchestrator") conn.topics.add("reports");
    for (const topic of store.subscriptions(conn.repo, subscriptionKey(conn)).keys()) {
      conn.topics.add(topic);
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
    extra?: { replyState?: ReplyState | null; supersedes?: string | null },
  ): Promise<void> {
    requireBoundRepo(conn);
    requireTopic(frame.topic);
    requireBody(frame.body);
    if (frame.to !== undefined && frame.to !== "*") {
      requireName(frame.to);
      if (looksLikeSessionTarget(frame.to) && !describeTarget(conn.repo, frame.to)) {
        throw new Error(`target session ${frame.to} is not registered in this repository`);
      }
    }
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
      replyState: extra?.replyState ?? null,
      supersedes: extra?.supersedes ?? null,
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

  async function ask(
    conn: Conn,
    to: string,
    body: string,
    topic: string | undefined,
    supersedes: string | undefined,
    respond: Respond,
  ): Promise<void> {
    requireBoundRepo(conn);
    requireName(to);
    if (looksLikeSessionTarget(to) && !describeTarget(conn.repo, to)) {
      throw new Error(`target session ${to} is not registered in this repository`);
    }
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
    if (supersedes !== undefined) {
      if (typeof supersedes !== "string" || !supersedes) throw new Error("invalid supersedes correlation id");
      const priorAsk = store.byCorrelation(conn.repo, supersedes);
      if (!priorAsk) throw new Error("no ask with that supersedes correlation id");
    }
    const bodyRatioMatch = /(?:X-Ratio-Project|ratio_project)\s*[=:]\s*["']?(p-[a-z0-9_-]+)["']?/i.exec(body);
    const boardExpectedRatio =
      bodyRatioMatch?.[1] ??
      extractStateRatioProject(store.listState(conn.repo)) ??
      readRepoConfigByKey(conn.repo)?.ratioProject?.trim() ??
      null;
    if (boardExpectedRatio) {
      const target = describeTarget(conn.repo, to);
      if (target) {
        const targetRatio = discoverRatioBinding({
          cwd: target.cwd,
          harness: target.harness,
          name: target.name,
        });
        if (
          targetRatio?.project &&
          targetRatio.project !== "unpinned" &&
          targetRatio.project !== boardExpectedRatio
        ) {
          throw new Error(
            `cannot ask ${target.name}: Ratio project mismatch (${target.name} has X-Ratio-Project=${targetRatio.project} in ${targetRatio.source}, but this board/ask requires ${boardExpectedRatio})`,
          );
        }
      }
    }
    await publish(
      conn,
      { topic: topic || "dm", body, to, id: randomUUID() },
      respond,
      "ask",
      randomUUID(),
      { supersedes: supersedes ?? null },
    );
  }

  async function report(conn: Conn, body: string, respond: Respond): Promise<void> {
    try {
      requireBoundRepo(conn);
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

  async function reply(
    conn: Conn,
    correlationId: string,
    body: string,
    state: ReplyState | undefined,
    respond: Respond,
  ): Promise<void> {
    requireBoundRepo(conn);
    if (typeof correlationId !== "string" || !correlationId) throw new Error("correlation id required");
    const replyState: ReplyState = state ?? "done";
    if (replyState !== "done" && replyState !== "progress" && replyState !== "blocked") {
      throw new Error("reply state must be done, progress, or blocked");
    }
    const askMessage = store.byCorrelation(conn.repo, correlationId);
    if (!askMessage) throw new Error("no ask with that correlation id");
    const targetSessionOwner = askMessage.to ? store.getAgentBySession(conn.repo, askMessage.to)?.name : undefined;
    const isRecipient =
      conn.name === askMessage.to ||
      (conn.sessionId !== null && conn.sessionId === askMessage.to) ||
      (conn.declaredSession !== null && conn.declaredSession === askMessage.to) ||
      (!conn.sessionBound && targetSessionOwner === conn.name);
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
      { replyState },
    );
  }

  function handleState(
    conn: Conn,
    frame: Extract<ClientFrame, { type: "state" }>,
    respond: Respond,
  ): void {
    requireBoundRepo(conn);
    const action = frame.action;
    if (action !== "get" && action !== "set" && action !== "list" && action !== "delete") {
      throw new Error("state action must be get, set, list, or delete");
    }
    if (frame.ifRev !== undefined && (!Number.isSafeInteger(frame.ifRev) || frame.ifRev < 0)) {
      throw new Error("ifRev must be a non-negative integer");
    }
    if (action === "list") {
      if (frame.prefix !== undefined && typeof frame.prefix !== "string") {
        throw new Error("prefix must be a string");
      }
      const entries = store.listState(conn.repo, frame.prefix);
      respond({ type: "state", action: "list", entries });
      return;
    }
    if (!frame.key) throw new Error("state key required");
    requireStateKey(frame.key);
    if (action === "get") {
      const entry = store.getState(conn.repo, frame.key) ?? null;
      respond({ type: "state", action: "get", entry });
      return;
    }
    if (action === "set") {
      if (typeof frame.value !== "string") throw new Error("state value must be a string");
      if (frame.value.length > BODY_MAX) throw new Error(`state value is longer than ${BODY_MAX} bytes`);
      const res = store.setState({
        repo: conn.repo,
        key: frame.key,
        value: frame.value,
        updatedBy: conn.name,
        ifRev: frame.ifRev,
      });
      if (!res.ok) {
        respond({
          type: "state",
          action: "set",
          ok: false,
          entry: res.current,
          conflict: true,
          detail: `revision conflict on ${frame.key}: expected rev=${frame.ifRev}, current rev=${res.current?.rev ?? 0}`,
        });
        return;
      }
      store.touchAgent(conn.repo, conn.name, undefined, conn.sessionId);
      respond({ type: "state", action: "set", ok: true, entry: res.entry });
      return;
    }
    const res = store.deleteState({ repo: conn.repo, key: frame.key, ifRev: frame.ifRev });
    if (!res.ok) {
      respond({
        type: "state",
        action: "delete",
        ok: false,
        entry: res.current,
        conflict: true,
        detail: `revision conflict on ${frame.key}: expected rev=${frame.ifRev}, current rev=${res.current?.rev ?? 0}`,
      });
      return;
    }
    store.touchAgent(conn.repo, conn.name, undefined, conn.sessionId);
    respond({ type: "state", action: "delete", ok: true, entry: null, deleted: res.deleted, rev: res.rev });
  }

  function inbox(
    conn: Conn,
    since: number | undefined,
    topic: string | undefined,
    limit: number | undefined,
    ack: boolean | undefined,
    respond: Respond,
  ): void {
    requireBoundRepo(conn);
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
      subscriptionKey: subscriptionKey(conn),
      isOrchestrator: conn.role === "orchestrator",
      limit: pageSize,
    });
    const shouldAck = ack !== false;
    const next = messages.length ? messages[messages.length - 1]!.seq : cursor;
    if (shouldAck && messages.length) {
      store.ack(conn.repo, key, next);
      const primary = store.getAgent(conn.repo, conn.name)?.sessionId;
      const multiSession = [...conns].some(
        (peer) =>
          peer.authed &&
          peer.repo === conn.repo &&
          peer.name === conn.name &&
          peer.declaredSession &&
          peer.declaredSession !== (conn.declaredSession ?? primary),
      );
      if (!multiSession && primary && !primary.startsWith("zellij:")) {
        const companionBase = conn.declaredSession === primary ? conn.name : `${conn.name}:${primary}`;
        const companionKey = inboxCursorKey(companionBase, topic);
        if (store.cursor(conn.repo, companionKey) < next) {
          store.ack(conn.repo, companionKey, next);
        }
      }
      store.clearDeferredWake(conn.repo, conn.name);
      if (conn.sessionId) store.clearDeferredWake(conn.repo, conn.sessionId);
      if (primary) store.clearDeferredWake(conn.repo, primary);
    }
    store.touchAgent(conn.repo, conn.name, undefined, conn.sessionId);
    const updatedCursor = shouldAck ? store.cursor(conn.repo, key) : next;
    const pendingAsk = store.unansweredAsk(conn.repo, conn.name, updatedCursor, 0, conn.sessionId);
    respond({
      type: "inbox",
      messages,
      cursor: store.cursor(conn.repo, key),
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
    if (!frame.cwd || frame.cwd === "/") throw new Error('cannot register: cwd is "/"');
    if (!frame.harness) throw new Error("harness required");
    if (conn.cwd === "/" || (frame.rebind && conn.harness !== "cli")) {
      const targetRoot = gitRepoRoot(frame.cwd);
      if (!existsSync(frame.cwd) || !existsSync(`${targetRoot}/.git`)) {
        throw new Error(`cannot bind repository: ${frame.cwd} is not a git checkout`);
      }
      const nextRepo = repoKey(targetRoot);
      if (conn.repo && conn.repo !== nextRepo) {
        store.evictCrossRepoBinding(nextRepo, conn.sessionId, conn.wakeSessionId);
      }
      conn.cwd = targetRoot;
      conn.repo = nextRepo;
      const orch = store.getOrchestrator(conn.repo);
      conn.role = orch === conn.name ? "orchestrator" : "worker";
    }
    requireBoundRepo(conn);
    if (
      frame.cwd !== conn.cwd &&
      existsSync(frame.cwd) &&
      existsSync(conn.cwd) &&
      existsSync(`${gitRepoRoot(frame.cwd)}/.git`) &&
      existsSync(`${gitRepoRoot(conn.cwd)}/.git`) &&
      repoKey(frame.cwd) !== conn.repo &&
      repoKey(frame.cwd, "split") !== conn.repo &&
      repoKey(frame.cwd) !== repoKey(conn.cwd)
    ) {
      throw new Error("cannot register: cwd belongs to a different repository board");
    }
    if (isSessionLiveInOtherRepo(conn.repo, frame.sessionId, frame.wakeSessionId, conn)) {
      throw new Error("cannot register: session is currently active in another repository board");
    }
    store.evictCrossRepoBinding(conn.repo, frame.sessionId, frame.wakeSessionId);
    const existing = frame.sessionId
      ? store.getAgentBySession(conn.repo, frame.sessionId)
      : store.getAgent(conn.repo, frame.name);
    if (frame.sessionId) {
      store.migrateSubscriptions(conn.repo, `name:${frame.name}`, frame.sessionId);
    }
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
    const status =
      conn.harness === "cli" || conn.name !== frame.name
        ? (existing?.status || "registered")
        : (conn.status || "online");
    const saved = store.upsertAgent({
      repo: conn.repo,
      name: frame.name,
      harness: frame.harness,
      sessionId: frame.sessionId || null,
      wakeSessionId: frame.wakeSessionId ?? existing?.wakeSessionId ?? null,
      cwd: frame.cwd,
      branch: checkout.branch,
      head: checkout.head,
      wake,
      status,
      bySession: Boolean(frame.sessionId),
    });
    if (conn.harness !== "cli" && conn.name === frame.name) {
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
      restoreSubscriptions(conn);
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
        restoreSubscriptions(peer);
      }
    }
    respond({ type: "registered", name: frame.name, agent: saved, created: !existing });
  }

  async function invite(
    conn: Conn,
    frame: Extract<ClientFrame, { type: "invite" }>,
    respond: Respond,
  ): Promise<void> {
    requireBoundRepo(conn);
    if (!Array.isArray(frame.agents) || frame.agents.length === 0) {
      throw new Error("invite requires at least one agent or harness name");
    }
    const mode: InviteMode = frame.mode ?? "terminal";
    if (mode !== "terminal" && mode !== "headless") {
      throw new Error("invite mode must be terminal or headless");
    }
    if (frame.orchestrator !== undefined && frame.orchestrator.trim()) {
      const nextOrch = resolveOrchestratorName(frame.orchestrator.trim());
      requireName(nextOrch);
      const currentOrch = store.getOrchestrator(conn.repo);
      if (
        currentOrch &&
        currentOrch !== nextOrch &&
        conn.name !== currentOrch &&
        conn.harness !== "cli"
      ) {
        throw new Error(`orchestrator is already ${currentOrch}; only ${currentOrch} or the CLI can reassign it`);
      }
      store.setOrchestrator(conn.repo, nextOrch);
      for (const peer of conns) {
        if (peer.authed && peer.repo === conn.repo) {
          peer.role = peer.name === nextOrch ? "orchestrator" : "worker";
        }
      }
    }
    const repoRootDir = gitRepoRoot(conn.cwd);
    const checkout = gitCheckoutInfo(repoRootDir);
    const currentRows = agents(conn.repo);
    const invited: InvitedAgent[] = [];
    const seen = new Set<string>();

    for (const rawName of frame.agents) {
      if (typeof rawName !== "string" || !rawName.trim()) continue;
      const spec = resolveInvitedAgentSpec(rawName);
      if (!spec) {
        throw new Error(`unknown agent or harness: ${rawName}`);
      }
      if (seen.has(spec.name)) continue;
      seen.add(spec.name);

      const live = currentRows.find((row) => row.online && row.name === spec.name);
      if (live) {
        const wakeId = live.wakeSessionId ?? live.sessionId ?? null;
        const wakeInfo = decideWake({
          directed: true,
          online: true,
          harness: live.harness,
          sessionId: wakeId,
          wakeEnabled: true,
        });
        invited.push({
          name: live.name,
          harness: live.harness,
          action: "already_online",
          sessionId: live.sessionId,
          wakeSessionId: wakeId,
          wakeMode: wakeInfo.mode,
          detail: `already online on this repository board (${wakeInfo.mode})`,
        });
        continue;
      }

      if (mode === "headless") {
        const existingOffline = store.getAgent(conn.repo, spec.name);
        const resumableSession =
          existingOffline?.sessionId &&
          !TTY_RE.test(existingOffline.sessionId) &&
          !existingOffline.sessionId.startsWith("zellij:") &&
          !existingOffline.sessionId.startsWith("tmux:") &&
          !/^%\d+$/.test(existingOffline.sessionId)
            ? existingOffline.sessionId
            : null;
        store.saveInvitedAgent({
          repo: conn.repo,
          name: spec.name,
          harness: spec.harness,
          sessionId: resumableSession,
          wakeSessionId: null,
          cwd: repoRootDir,
          branch: checkout.branch,
          head: checkout.head,
          status: "registered",
        });
        invited.push({
          name: spec.name,
          harness: spec.harness,
          action: "registered_headless",
          sessionId: resumableSession,
          wakeSessionId: null,
          wakeMode: "headless",
          detail: `registered for headless subscription CLI wake in ${repoRootDir}`,
        });
        continue;
      }

      if (!spec.command) {
        throw new Error(`CLI binary not found for ${spec.name} (${spec.harness})`);
      }
      const spawnTab = options.spawnTerminal ?? defaultSpawnTerminalTab;
      const ttySession = await spawnTab({
        cwd: repoRootDir,
        name: spec.name,
        harness: spec.harness,
        cmd: spec.command,
        args: spec.args,
      });
      store.evictCrossRepoBinding(conn.repo, undefined, ttySession);
      store.saveInvitedAgent({
        repo: conn.repo,
        name: spec.name,
        harness: spec.harness,
        sessionId: null,
        wakeSessionId: ttySession,
        cwd: repoRootDir,
        branch: checkout.branch,
        head: checkout.head,
        status: "invited",
      });
      const actionLabel = ttySession.startsWith("zellij:") ? "Zellij pane" : "Terminal tab";
      invited.push({
        name: spec.name,
        harness: spec.harness,
        action: "launched_terminal",
        sessionId: null,
        wakeSessionId: ttySession,
        wakeMode: "inject",
        detail: `opened ${actionLabel} (${ttySession}) in ${repoRootDir}`,
      });
    }

    respond({
      type: "invited",
      repoKey: conn.repo,
      cwd: repoRootDir,
      orchestrator: store.getOrchestrator(conn.repo),
      invited,
    });
  }

  function fanout(message: BusMessage, origin: Conn): void {
    const targetSessionOwner =
      message.to && message.to !== "*" ? store.getAgentBySession(message.repo, message.to)?.name : undefined;
    for (const peer of conns) {
      if (!peer.authed || peer.repo !== message.repo || peer.socket === origin.socket) continue;
      const delivered =
        message.to && message.to !== "*"
          ? message.to === peer.name ||
            message.to === peer.sessionId ||
            message.to === peer.declaredSession ||
            (!peer.sessionBound && targetSessionOwner === peer.name)
          : peer.topics.has(message.topic);
      if (delivered) send(peer.socket, { type: "message", message });
    }
  }

  function isMessageUnreadForTarget(repo: string, message: BusMessage): boolean {
    if (!message.to) return false;
    const target = describeTarget(repo, message.to);
    if (!target) return false;
    const cursorKeys = new Set<string>([target.name, message.to]);
    if (target.declaredSession && !target.declaredSession.startsWith("zellij:")) {
      cursorKeys.add(`${target.name}:${target.declaredSession}`);
    }
    for (const peer of conns) {
      if (!peer.authed || peer.repo !== repo || peer.harness === "cli") continue;
      if (peer.name === target.name || peer.sessionId === message.to || peer.declaredSession === message.to) {
        cursorKeys.add(clientKey(peer));
      }
    }
    for (const cKey of cursorKeys) {
      if (store.cursor(repo, cKey) >= message.seq) return false;
      if (store.cursor(repo, inboxCursorKey(cKey, message.topic)) >= message.seq) return false;
    }
    return true;
  }

  function isSessionLiveInOtherRepo(
    repo: string,
    sessionId?: string | null,
    wakeSessionId?: string | null,
    ignorePeer?: Conn,
  ): boolean {
    for (const id of [sessionId, wakeSessionId]) {
      if (!id) continue;
      for (const peer of conns) {
        if (
          peer !== ignorePeer &&
          peer.authed &&
          peer.repo !== repo &&
          peer.cwd !== "/" &&
          peer.harness !== "cli" &&
          !peer.waitOnly &&
          (peer.sessionId === id || peer.declaredSession === id || peer.wakeSessionId === id)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  function scheduleTrailingWake(key: string, repo: string, message: BusMessage): void {
    if (message.to) {
      store.saveDeferredWake(repo, message.to, message.seq);
    }
    const existing = trailingWakes.get(key);
    if (existing) clearTimeout(existing);
    const elapsed = Date.now() - (lastWake.get(key) ?? 0);
    const remainingCooldown = wakeCooldownMs - Math.max(0, elapsed);
    const delay =
      remainingCooldown > 0
        ? Math.max(25, remainingCooldown)
        : Math.max(25, Math.min(wakeCooldownMs, 1000));
    const timer = setTimeout(() => {
      trailingWakes.delete(key);
      if (stopping) return;
      if (!isMessageUnreadForTarget(repo, message)) {
        if (message.to) store.clearDeferredWake(repo, message.to);
        return;
      }
      void wakeFor(repo, message);
    }, delay);
    timer.unref?.();
    trailingWakes.set(key, timer);
  }

  function replayDeferredWakes(repoFilter?: string): void {
    for (const entry of store.listDeferredWakes(repoFilter)) {
      const msg = store.bySeq(entry.repo, entry.seq);
      if (!msg || !msg.to || !isMessageUnreadForTarget(entry.repo, msg)) {
        store.clearDeferredWake(entry.repo, entry.target);
        continue;
      }
      const key = JSON.stringify([entry.repo, msg.to]);
      if (!trailingWakes.has(key)) {
        scheduleTrailingWake(key, entry.repo, msg);
      }
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
      store.clearDeferredWake(repo, message.to);
      return { mode: "skip", detail: `no agent named ${message.to} in this repo` };
    }
    if (target.sessionId && isSessionLiveInOtherRepo(repo, target.sessionId, target.sessionId)) {
      store.clearDeferredWake(repo, message.to);
      return { mode: "skip", detail: "session is active in another repository" };
    }
    const info = decideWake({
      directed: true,
      online: target.online,
      harness: target.harness,
      sessionId: target.sessionId,
      wakeEnabled: target.wake,
    });
    if (info.mode !== "inject" && info.mode !== "headless") {
      store.clearDeferredWake(repo, message.to);
      return info;
    }
    const key = JSON.stringify([repo, message.to]);
    if (info.mode === "inject" && turnInProgress(target.harness, target.sessionId)) {
      scheduleTrailingWake(key, repo, message);
      return {
        mode: "skip",
        detail: "turn is in progress; delivering via hook/inbox before queueing",
      };
    }
    const last = lastWake.get(key) ?? 0;
    if (waking.has(key) || Date.now() - last < wakeCooldownMs) {
      scheduleTrailingWake(key, repo, message);
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
      store.clearDeferredWake(repo, message.to);
      return { mode: "skip", detail: "wake command is not available" };
    }
    waking.add(key);
    try {
      if (options.logFile) logWake(options.logFile, launch, message.id);
      await options.spawnWake(launch);
      lastWake.set(key, Date.now());
      store.clearDeferredWake(repo, message.to);
      return info;
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "spawn failed";
      return { mode: "skip", detail: `wake failed: ${messageText}` };
    } finally {
      waking.delete(key);
    }
  }

  function describeTarget(repo: string, target: string): {
    name: string;
    declaredSession: string | null;
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
    const liveWakeSession = live
      ? (live.wakeSessionId || ((!live.sessionBound || live.sessionId === row?.sessionId) ? row?.wakeSessionId : null) || (live.sessionBound ? live.sessionId : null))
      : null;
    return {
      name: live?.name ?? row!.name,
      declaredSession: live?.declaredSession ?? row?.sessionId ?? null,
      harness: live?.sessionBound ? live.harness : row?.harness ?? live!.harness,
      sessionId: live
        ? (liveWakeSession || row?.sessionId || null)
        : ((row?.status === "invited" ? (row.wakeSessionId || row.sessionId) : (row?.sessionId || row?.wakeSessionId)) || null),
      cwd: live?.sessionBound ? live.cwd : row?.cwd ?? live!.cwd,
      wake: row?.wake ?? live?.wake ?? false,
      online: Boolean(live),
    };
  }

  function agents(repo: string, opts?: { includeAllOffline?: boolean }): AgentRecord[] {
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
        wakeSessionId:
          conn.wakeSessionId ||
          ((!conn.sessionBound || conn.sessionId === registered?.sessionId) ? registered?.wakeSessionId : null) ||
          (conn.sessionBound ? conn.sessionId : registered?.sessionId ?? null),
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
        ratio: discoverRatioBinding({ cwd: conn.cwd, harness: conn.harness, name: conn.name }),
      };
    });
    const includeAllOffline = Boolean(opts?.includeAllOffline);
    const liveNames = new Set(rows.map((row) => row.name));
    const liveSessions = new Set(rows.flatMap((row) => (row.sessionId ? [row.sessionId] : [])));
    const seenOfflineByName = new Set<string>();
    const staleCutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const row of store.listAgents(repo, new Set())) {
      const represented = row.sessionId
        ? liveSessions.has(row.sessionId) || rows.some((live) => live.online && live.name === row.name && !live.sessionId)
        : liveNames.has(row.name);
      if (represented) continue;
      if (!includeAllOffline && row.status !== "invited") {
        if (liveNames.has(row.name)) continue;
        if (seenOfflineByName.has(row.name)) continue;
        if (!row.wake && row.lastSeen < staleCutoff) continue;
        seenOfflineByName.add(row.name);
      }
      rows.push({
        ...row,
        wakeSessionId: row.sessionId || row.wakeSessionId || null,
        connectionCount: 0,
        role: row.name === orchestrator ? "orchestrator" : "worker",
        ratio: discoverRatioBinding({ cwd: row.cwd, harness: row.harness, name: row.name }),
      });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name) || (a.sessionId ?? "").localeCompare(b.sessionId ?? ""));
    return rows;
  }

  replayDeferredWakes();

  return {
    port,
    url: `ws://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        stopping = true;
        clearInterval(sweep);
        for (const timer of pendingOffline.values()) clearTimeout(timer);
        pendingOffline.clear();
        for (const timer of trailingWakes.values()) clearTimeout(timer);
        trailingWakes.clear();
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

function requireBoundRepo(conn: Conn): void {
  if (!conn.cwd || conn.cwd === "/" || !conn.repo) {
    throw new Error(
      'session is not bound to a repository checkout (cwd is "/"); call bus_register({ cwd: "<absolute-repo-path>" }) first to bind this session to your current workspace',
    );
  }
}

function looksLikeSessionTarget(to: string): boolean {
  return (
    UUID_RE.test(to) ||
    TTY_RE.test(to) ||
    to.startsWith("zellij:") ||
    to.startsWith("tmux:") ||
    /^%\d+$/.test(to)
  );
}

function requireTopic(topic: string): void {
  if (typeof topic !== "string" || !TOPIC_RE.test(topic)) throw new Error(`bad topic: ${topic}`);
}

function requireStateKey(key: string): void {
  if (typeof key !== "string" || !STATE_KEY_RE.test(key)) throw new Error(`bad state key: ${key}`);
}

function requireName(name: string): void {
  if (typeof name !== "string" || !NAME_RE.test(name)) throw new Error(`bad name: ${name}`);
}

function requireBody(body: string): void {
  if (typeof body !== "string") throw new Error("message body must be a string");
  if (!body.trim()) throw new Error("empty message");
  if (body.length > BODY_MAX) throw new Error(`message is longer than ${BODY_MAX} bytes`);
}


