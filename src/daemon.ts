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
import { createPaneProbe, formatDiagnostics, paneTarget, sessionDiagnostics, type PaneProbe } from "./health.ts";
import { BUILD, buildWarning, runtimeInfo } from "./build.ts";
import { extractStateRatioProject } from "./status.ts";
import { Store, inboxCursorKey, sessionHandle } from "./store.ts";
import {
  BODY_MAX,
  NAME_RE,
  PRESENCE_TTL_MS,
  STATE_KEY_RE,
  TOPIC_RE,
  UNIVERSAL_REPO,
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
  const trailingWakes = new Map<string, { timer: ReturnType<typeof setTimeout>; message: BusMessage }>();
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
      case "reinit":
        await handleReinit(conn, frame, respond);
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
        inbox(conn, frame.since, frame.topic, frame.limit, frame.ack, Boolean(frame.hook), respond);
        break;
      case "ack": {
        requireBoundRepo(conn);
        const baseKey = clientKey(conn);
        const isHook = Boolean(frame.hook);
        const targetKey = isHook ? `hook:${baseKey}` : baseKey;
        store.ack(conn.repo, targetKey, frame.cursor);
        if (!isHook) {
          store.ack(conn.repo, `hook:${baseKey}`, frame.cursor);
          store.ack(conn.repo, inboxCursorKey(baseKey, "dm"), frame.cursor);
          store.ack(conn.repo, inboxCursorKey(baseKey, "repo"), frame.cursor);
          if (conn.role === "orchestrator") {
            store.ack(conn.repo, inboxCursorKey(baseKey, "reports"), frame.cursor);
          }
        }
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
          const companionTarget = isHook ? `hook:${companionBase}` : companionBase;
          if (store.cursor(conn.repo, companionTarget) < frame.cursor) {
            store.ack(conn.repo, companionTarget, frame.cursor);
          }
          if (!isHook) {
            store.ack(conn.repo, `hook:${companionBase}`, frame.cursor);
            store.ack(conn.repo, inboxCursorKey(companionBase, "dm"), frame.cursor);
            store.ack(conn.repo, inboxCursorKey(companionBase, "repo"), frame.cursor);
            if (conn.role === "orchestrator") {
              store.ack(conn.repo, inboxCursorKey(companionBase, "reports"), frame.cursor);
            }
          }
        }
        clearPendingWakeTarget(conn.repo, conn.name, frame.cursor);
        if (conn.sessionId) clearPendingWakeTarget(conn.repo, conn.sessionId, frame.cursor);
        if (primary) clearPendingWakeTarget(conn.repo, primary, frame.cursor);
        respond({ type: "ok", detail: "acked" });
        break;
      }
      case "doctor":
        await sendDoctor(conn, frame, respond);
        break;
      case "who":
        await sendWho(conn, respond);
        break;
      case "ask":
        await ask(conn, frame.to, frame.body, frame.topic, frame.supersedes, frame.ratioProject, respond);
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
    respond({ type: "who", agents: rows, orchestrator: store.getOrchestrator(conn.repo), daemon: daemonInfo });
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
      stored: store.getAgent(agent.repo, agent.sessionId || agent.wakeSessionId || agent.name),
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
        const current = agents(row.repo, { includeAllOffline: true }).find(
          (peer) =>
            peer.name === row.name &&
            peer.sessionId === row.sessionId &&
            (peer.wakeSessionId ?? null) === (row.wakeSessionId ?? null),
        );
        if (!current || current.lastSeen !== row.lastSeen) continue;
        // Only mutate the registration if it still belongs to the scanned session and is not owned by a live healthy sibling.
        const targetId =
          (reason === "dead_pane"
            ? (row.wakeSessionId ?? row.sessionId)
            : (row.sessionId ?? row.wakeSessionId)) ?? null;
        const liveSiblingOwnsStored = Boolean(
          stored &&
            rows.some(
              (other) =>
                other !== row &&
                other.repo === row.repo &&
                other.name === row.name &&
                other.diagnostics.health === "online" &&
                ((stored.sessionId !== null && other.sessionId === stored.sessionId) ||
                  (stored.wakeSessionId && other.wakeSessionId === stored.wakeSessionId)),
            ),
        );
        const ownsRegistration = Boolean(
          stored &&
            !liveSiblingOwnsStored &&
            (stored.sessionId === row.sessionId ||
              stored.sessionId === targetId ||
              (targetId !== null && stored.wakeSessionId === targetId)),
        );
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
              if (peer.sessionId === targetId) {
                peer.sessionBound = false;
                peer.sessionId = null;
              }
              if (peer.wakeSessionId === targetId) {
                peer.wakeSessionId = null;
              }
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
      pending_asks: store.pendingAsks(
        conn.repo,
        frame.limit,
        Date.now(),
        conn.role === "orchestrator" || conn.harness === "cli" ? undefined : conn.name,
        conn.role === "orchestrator" || conn.harness === "cli" ? undefined : conn.sessionId,
      ),
      agent_metrics: store.agentMetrics(
        conn.repo,
        conn.role === "orchestrator" || conn.harness === "cli" ? undefined : conn.name,
        conn.role === "orchestrator" || conn.harness === "cli" ? undefined : conn.sessionId,
      ),
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
    const bySession = declaredSession ? store.getAgentBySession(effectiveRepo, declaredSession) : undefined;
    const byName = store.getAgent(effectiveRepo, frame.name);
    const existing = declaredSession
      ? (bySession ?? (!byName?.sessionId ? byName : undefined))
      : byName;
    conn.authed = true;
    conn.agentId = randomUUID();
    conn.name =
      bySession && (frame.harness === "cli" || frame.name === frame.harness)
        ? bySession.name
        : frame.name;
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
      ((!conn.sessionBound || conn.sessionId === existing?.sessionId || !existing?.sessionId)
        ? existing?.wakeSessionId
        : null) ||
      (conn.sessionBound ? conn.sessionId : existing?.sessionId ?? null);
    conn.build = frame.build;
    conn.wake = frame.wake === undefined ? (existing?.wake ?? false) : frame.wake;
    const existingStatus = existing?.status === "invited" ? undefined : existing?.status;
    conn.status = [...conns].find((peer) => peer !== conn && peer.authed && groupKey(peer) === groupKey(conn))?.status
      || frame.status || existingStatus || "online";
    conn.role = conn.cwd === "/" ? "worker" : elect(conn.repo, conn.name, frame.role === "orchestrator", conn.sessionId);
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
      if (!isSessionLiveInOtherRepo(conn.repo, conn.declaredSession, conn.wakeSessionId)) {
        store.evictCrossRepoBinding(conn.repo, conn.declaredSession, conn.wakeSessionId);
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
      store.touchAgent(
        conn.repo,
        conn.name,
        existing?.status === "invited" ? conn.status : undefined,
        conn.sessionId,
      );
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

  function isSessionOrchestratorValue(repo: string, orchestrator: string): boolean {
    if (looksLikeSessionTarget(orchestrator)) return true;
    if (store.getAgentBySession(repo, orchestrator)) return true;
    for (const peer of conns) {
      if (
        peer.authed &&
        peer.repo === repo &&
        peer.harness !== "cli" &&
        (peer.sessionId === orchestrator || peer.declaredSession === orchestrator)
      ) {
        return true;
      }
    }
    return false;
  }

  function isOrchestratorTarget(
    repo: string,
    orchestrator: string | null,
    peer: {
      name: string;
      sessionId?: string | null;
      declaredSession?: string | null;
      wakeSessionId?: string | null;
    },
  ): boolean {
    if (!orchestrator) return false;
    if (peer.sessionId && peer.sessionId === orchestrator) return true;
    if (peer.declaredSession && peer.declaredSession === orchestrator) return true;
    if (peer.wakeSessionId && peer.wakeSessionId === orchestrator) return true;
    if (isSessionOrchestratorValue(repo, orchestrator)) return false;
    return peer.name === orchestrator;
  }

  function hasLiveOrchestratorSocket(repo: string, orchestrator: string | null): boolean {
    if (!orchestrator) return false;
    return [...conns].some(
      (peer) =>
        peer.authed &&
        peer.repo === repo &&
        peer.harness !== "cli" &&
        !peer.waitOnly &&
        isOrchestratorTarget(repo, orchestrator, peer),
    );
  }

  function syncOrchestratorRoles(repo: string): void {
    const currentOrch = store.getOrchestrator(repo);
    for (const peer of conns) {
      if (!peer.authed || peer.repo !== repo) continue;
      if (isOrchestratorTarget(repo, currentOrch, peer)) {
        peer.role = "orchestrator";
        peer.topics.add("reports");
      } else if (peer.role === "orchestrator") {
        peer.role = "worker";
        if (!store.subscriptions(repo, subscriptionKey(peer)).has("reports")) {
          peer.topics.delete("reports");
        }
      }
    }
  }

  function elect(repo: string, name: string, wants: boolean, sessionId?: string | null): Role {
    let stored = store.getOrchestrator(repo);
    if (!stored) {
      const cfgOrch = readRepoConfigByKey(repo)?.orchestrator?.trim();
      if (cfgOrch) {
        const canonical = looksLikeSessionTarget(cfgOrch) ? cfgOrch : resolveOrchestratorName(cfgOrch);
        if (NAME_RE.test(canonical)) {
          store.setOrchestrator(repo, canonical);
          stored = canonical;
        }
      }
    }
    if (stored) {
      return isOrchestratorTarget(repo, stored, { name, sessionId }) ? "orchestrator" : "worker";
    }
    if (!wants) return "worker";
    store.setOrchestrator(repo, name);
    return "orchestrator";
  }

  function applyOrchestrator(conn: Conn, rawName: string, resolveAlias = false): void {
    const trimmed = rawName.trim();
    const nextOrch =
      resolveAlias && !looksLikeSessionTarget(trimmed) ? resolveOrchestratorName(trimmed) : trimmed;
    requireName(nextOrch);
    const currentOrch = store.getOrchestrator(conn.repo);
    if (
      currentOrch &&
      currentOrch !== nextOrch &&
      conn.name !== currentOrch &&
      conn.sessionId !== currentOrch &&
      conn.declaredSession !== currentOrch &&
      conn.harness !== "cli" &&
      hasLiveOrchestratorSocket(conn.repo, currentOrch)
    ) {
      throw new Error(`orchestrator is already ${currentOrch}; only ${currentOrch} or the CLI can reassign it`);
    }
    store.setOrchestrator(conn.repo, nextOrch);
    syncOrchestratorRoles(conn.repo);
  }

  function setOrchestrator(conn: Conn, name: string | undefined, respond: Respond): void {
    requireBoundRepo(conn);
    if (name !== undefined) {
      applyOrchestrator(conn, name, false);
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
    conn.topics.clear();
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

  function resolveRecipientTarget(repo: string, rawTo: string): string {
    if (rawTo === "*") return "*";
    requireName(rawTo);
    if (looksLikeSessionTarget(rawTo)) {
      if (!describeTarget(repo, rawTo)) {
        throw new Error(`target session ${rawTo} is not registered in this repository`);
      }
      return rawTo;
    }
    const lower = rawTo.toLowerCase();
    const sessionCandidates = new Map<
      string,
      { name: string; harness: string; sessionId: string; role: Role; branch: string | null; online: boolean }
    >();
    const currentOrch = store.getOrchestrator(repo);
    for (const row of store.listAgents(repo, new Set())) {
      if (!row.sessionId || looksLikePaneOrTtyTarget(row.sessionId)) continue;
      sessionCandidates.set(row.sessionId, {
        name: row.name,
        harness: row.harness,
        sessionId: row.sessionId,
        role: isOrchestratorTarget(repo, currentOrch, row) ? "orchestrator" : "worker",
        branch: row.branch ?? null,
        online: false,
      });
    }
    for (const peer of conns) {
      if (!peer.authed || peer.repo !== repo || peer.harness === "cli" || peer.waitOnly) continue;
      if (!peer.sessionBound || !peer.sessionId || looksLikePaneOrTtyTarget(peer.sessionId)) continue;
      sessionCandidates.set(peer.sessionId, {
        name: peer.name,
        harness: peer.harness,
        sessionId: peer.sessionId,
        role: isOrchestratorTarget(repo, currentOrch, peer) ? "orchestrator" : "worker",
        branch: peer.branch ?? sessionCandidates.get(peer.sessionId)?.branch ?? null,
        online: true,
      });
    }
    const handleMatches = [...sessionCandidates.values()].filter((c) => {
      const h1 = sessionHandle(c.name, c.sessionId, c.harness).toLowerCase();
      const h2 = `${c.harness}-${c.sessionId.slice(0, 4)}`.toLowerCase();
      return h1 === lower || h2 === lower;
    });
    if (handleMatches.length === 1) {
      return handleMatches[0]!.sessionId;
    }
    if (handleMatches.length > 1) {
      throw new Error(
        `ambiguous session handle "${rawTo}": matches multiple sessions (${handleMatches.map((m) => m.sessionId).join(", ")}); specify the full session UUID`,
      );
    }
    const allBoundSameName = [...sessionCandidates.values()].filter((c) => c.name === rawTo);
    const liveBoundSameName = allBoundSameName
      .filter((c) => c.online)
      .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    const ambiguousCandidates =
      liveBoundSameName.length > 1
        ? liveBoundSameName
        : allBoundSameName.length === 0 && !store.getAgent(repo, rawTo)
          ? [...sessionCandidates.values()]
              .filter((c) => c.online && c.harness === rawTo)
              .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
          : [];
    if (ambiguousCandidates.length > 1) {
      const list = ambiguousCandidates
        .map((c) => {
          const shortH = `${c.harness}-${c.sessionId.slice(0, 4).toLowerCase()}`;
          const label = c.name !== c.harness && c.name !== shortH ? `${c.name} (handle=${shortH}` : `${shortH} (`;
          const br = c.branch ? `, ${c.branch}` : "";
          return `${label}${c.name !== c.harness && c.name !== shortH ? ", " : ""}${c.role}${br}, session=${c.sessionId})`;
        })
        .join("; ");
      const first = ambiguousCandidates[0]!;
      const firstHandle = sessionHandle(first.name, first.sessionId, first.harness);
      throw new Error(
        `ambiguous target "${rawTo}": ${ambiguousCandidates.length} ${rawTo} sessions are online in this repo [${list}]. Specify a session handle (e.g. "${firstHandle}") or session UUID, or omit "to" on topic="repo" to broadcast.`,
      );
    }
    if (liveBoundSameName.length === 1 && allBoundSameName.length > 1) {
      return liveBoundSameName[0]!.sessionId;
    }
    return rawTo;
  }

  function deriveLaneName(opts: {
    name: string;
    harness: string;
    sessionId: string | null;
    cwd: string;
    branch: string | null;
    isOrchestrator: boolean;
    usedNames: Set<string>;
  }): string {
    if (opts.name !== opts.harness) {
      opts.usedNames.add(opts.name);
      return opts.name;
    }
    if (opts.isOrchestrator && !opts.usedNames.has("orch")) {
      opts.usedNames.add("orch");
      return "orch";
    }
    const rawBranch = opts.branch?.trim() || "";
    const ignoredBranches = new Set(["main", "master", "develop", "dev", "head", "detached", "trunk"]);
    let candidate = "";
    if (rawBranch && !ignoredBranches.has(rawBranch.toLowerCase())) {
      candidate = rawBranch
        .replace(/^(?:worktree-|feature\/|feat\/|chore\/|fix\/|bugfix\/|hotfix\/|ws\/|claude\/)+/i, "")
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 28)
        .replace(/-+$/g, "");
    }
    if (!candidate) {
      const wtMatch = /\/(?:\.claude\/worktrees|claude-ws\/[^/]+)\/([^/]+)$/.exec(opts.cwd);
      if (wtMatch?.[1]) {
        candidate = wtMatch[1]
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 28)
          .replace(/-+$/g, "");
      }
    }
    const shortSuffix = opts.sessionId
      ? UUID_RE.test(opts.sessionId)
        ? opts.sessionId.slice(0, 4).toLowerCase()
        : /^zellij:[^:]+:(\d+)$/.exec(opts.sessionId)?.[1]
          ? `p${/^zellij:[^:]+:(\d+)$/.exec(opts.sessionId)![1]}`
          : /^tmux:%(\d+)$/.exec(opts.sessionId)?.[1]
            ? `t${/^tmux:%(\d+)$/.exec(opts.sessionId)![1]}`
            : /^pty:.*sb-(\d+)\.sock$/.exec(opts.sessionId)?.[1]
              ? `p${/^pty:.*sb-(\d+)\.sock$/.exec(opts.sessionId)![1]!.slice(-4)}`
              : /^tty:\/dev\/ttys(\d+)$/.exec(opts.sessionId)?.[1]
                ? `tty${/^tty:\/dev\/ttys(\d+)$/.exec(opts.sessionId)![1]}`
                : ""
      : "";
    if (candidate && candidate !== opts.harness && NAME_RE.test(candidate)) {
      if (!opts.usedNames.has(candidate)) {
        opts.usedNames.add(candidate);
        return candidate;
      }
      if (shortSuffix) {
        const withSuffix = `${candidate.slice(0, 23)}-${shortSuffix}`;
        if (NAME_RE.test(withSuffix) && !opts.usedNames.has(withSuffix)) {
          opts.usedNames.add(withSuffix);
          return withSuffix;
        }
      }
    }
    if (shortSuffix) {
      const handle = `${opts.harness}-${shortSuffix}`;
      if (NAME_RE.test(handle) && !opts.usedNames.has(handle)) {
        opts.usedNames.add(handle);
        return handle;
      }
    }
    opts.usedNames.add(opts.name);
    return opts.name;
  }

  function allActiveRepos(conn: Conn): string[] {
    const repos = new Set<string>(store.listRepos());
    for (const peer of conns) {
      if (peer.authed && peer.repo && peer.repo !== UNIVERSAL_REPO) repos.add(peer.repo);
    }
    if (conn.repo && conn.repo !== UNIVERSAL_REPO) repos.add(conn.repo);
    repos.delete(UNIVERSAL_REPO);
    return [...repos].sort();
  }

  async function handleReinit(
    conn: Conn,
    frame: Extract<ClientFrame, { type: "reinit" }>,
    respond: Respond,
  ): Promise<void> {
    const assignNames = frame.assignNames !== false;
    const targetRepos =
      frame.universal || conn.cwd === "/" || !conn.repo ? allActiveRepos(conn) : [conn.repo];
    const updatedAgents: Array<{
      repo: string;
      sessionId: string | null;
      oldName: string;
      newName: string;
      handle: string;
      cwd: string;
      branch: string | null;
      role: Role;
    }> = [];
    let notifiedSockets = 0;

    for (const repo of targetRepos) {
      const currentOrch = store.getOrchestrator(repo);
      const storedRows = store.listAgents(repo, new Set());
      const usedNames = new Set<string>();
      for (const row of storedRows) {
        if (row.name !== row.harness) usedNames.add(row.name);
      }
      for (const peer of conns) {
        if (peer.authed && peer.repo === repo && peer.harness !== "cli" && peer.name !== peer.harness) {
          usedNames.add(peer.name);
        }
      }

      const sessionMap = new Map<
        string,
        {
          name: string;
          harness: string;
          sessionId: string;
          wakeSessionId: string | null;
          cwd: string;
          branch: string | null;
          head: string | null;
          wake: boolean;
          status: string;
          online: boolean;
        }
      >();
      for (const row of storedRows) {
        const sid = row.sessionId || row.wakeSessionId;
        if (!sid) continue;
        sessionMap.set(sid, {
          name: row.name,
          harness: row.harness,
          sessionId: sid,
          wakeSessionId: row.wakeSessionId ?? null,
          cwd: row.cwd,
          branch: row.branch ?? null,
          head: row.head ?? null,
          wake: row.wake,
          status: row.status,
          online: false,
        });
      }
      for (const peer of conns) {
        if (!peer.authed || peer.repo !== repo || peer.harness === "cli" || peer.waitOnly) continue;
        const sid = peer.sessionId || peer.wakeSessionId;
        if (!sid) continue;
        const prev = sessionMap.get(sid);
        sessionMap.set(sid, {
          name: peer.name,
          harness: peer.harness,
          sessionId: sid,
          wakeSessionId: peer.wakeSessionId ?? prev?.wakeSessionId ?? null,
          cwd: peer.cwd !== "/" ? peer.cwd : (prev?.cwd ?? peer.cwd),
          branch: peer.branch ?? prev?.branch ?? null,
          head: peer.head ?? prev?.head ?? null,
          wake: prev?.wake ?? peer.wake,
          status: peer.status || prev?.status || "online",
          online: true,
        });
      }

      // Sort so orchestrator is named first, then by sessionId for determinism
      const candidates = [...sessionMap.values()].sort((a, b) => {
        const aOrch = isOrchestratorTarget(repo, currentOrch, a) ? 0 : 1;
        const bOrch = isOrchestratorTarget(repo, currentOrch, b) ? 0 : 1;
        if (aOrch !== bOrch) return aOrch - bOrch;
        return a.sessionId.localeCompare(b.sessionId);
      });

      const harnessCounts = new Map<string, number>();
      for (const c of candidates) {
        harnessCounts.set(c.harness, (harnessCounts.get(c.harness) ?? 0) + 1);
      }

      for (const c of candidates) {
        const isOrch = isOrchestratorTarget(repo, currentOrch, c);
        const oldName = c.name;
        const shouldDerive =
          assignNames &&
          oldName === c.harness &&
          ((harnessCounts.get(c.harness) ?? 0) > 1 || Boolean(c.branch) || isOrch);
        const newName = shouldDerive
          ? deriveLaneName({
              name: oldName,
              harness: c.harness,
              sessionId: c.sessionId,
              cwd: c.cwd,
              branch: c.branch,
              isOrchestrator: isOrch,
              usedNames,
            })
          : oldName;
        if (newName !== oldName) {
          store.upsertAgent({
            repo,
            name: newName,
            harness: c.harness,
            sessionId: c.sessionId,
            wakeSessionId: c.wakeSessionId,
            cwd: c.cwd,
            branch: c.branch,
            head: c.head,
            wake: c.wake,
            status: c.status,
            bySession: true,
          });
          store.migrateSessionCursors(repo, oldName, newName, c.sessionId);
          for (const peer of conns) {
            if (
              peer.authed &&
              peer.repo === repo &&
              (peer.sessionId === c.sessionId || peer.declaredSession === c.sessionId)
            ) {
              peer.name = newName;
            }
          }
          if (currentOrch === oldName && isOrch) {
            store.setOrchestrator(repo, c.sessionId);
          }
        }
        const shortHandle = UUID_RE.test(c.sessionId)
          ? `${c.harness}-${c.sessionId.slice(0, 4).toLowerCase()}`
          : sessionHandle(newName, c.sessionId, c.harness);
        updatedAgents.push({
          repo,
          sessionId: c.sessionId,
          oldName,
          newName,
          handle: shortHandle,
          cwd: c.cwd,
          branch: c.branch,
          role: isOrch ? "orchestrator" : "worker",
        });
      }

      const repoAgents = updatedAgents.filter((a) => a.repo === repo);
      const rosterLines =
        repoAgents.length > 0
          ? [
              "Active session roster:",
              ...repoAgents.map(
                (a) =>
                  `- ${a.newName}${a.oldName !== a.newName ? ` (renamed from ${a.oldName})` : ""} handle=${a.handle} role=${a.role}${a.branch ? ` branch=${a.branch}` : ""} session=${a.sessionId}`,
              ),
            ]
          : [];
      const customNote = frame.message?.trim() ? `\n${frame.message.trim()}\n` : "";
      const body = [
        `[switchboard: SYSTEM RE-INIT] build=${BUILD.version}@${BUILD.commit_sha?.slice(0, 7) ?? "dev"}`,
        customNote.trim(),
        ...rosterLines,
        'Action: Your Switchboard session registration has been refreshed. Address peers by their lane name (e.g. "dark-factory-mode", "orch"), short handle (e.g. "claude-104c"), or session UUID in bus_ask and bus_publish. If your session is unbound or switched worktrees, call bus_register({ cwd: "<your-worktree-path>", name: "<your-lane-name>" }) now.',
      ]
        .filter(Boolean)
        .join("\n");

      const msg = store.insert({
        repo,
        id: randomUUID(),
        topic: "repo",
        fromId: conn.sessionId || conn.declaredSession || conn.name,
        fromName: conn.name,
        body,
        ts: Date.now(),
        kind: "pub",
        correlationId: null,
        to: null,
      });
      for (const peer of conns) {
        if (!peer.authed || peer.repo !== repo || peer.harness === "cli") continue;
        send(peer.socket, { type: "message", message: msg });
        notifiedSockets++;
      }
      await wakeFor(repo, msg);
    }

    // Also record in UNIVERSAL_REPO for audit/unbound visibility
    store.insert({
      repo: UNIVERSAL_REPO,
      id: randomUUID(),
      topic: "repo",
      fromId: conn.sessionId || conn.declaredSession || conn.name,
      fromName: conn.name,
      body: `[switchboard: SYSTEM RE-INIT] build=${BUILD.version}@${BUILD.commit_sha?.slice(0, 7) ?? "dev"} repos=${targetRepos.join(",")}${frame.message ? `\n${frame.message}` : ""}`,
      ts: Date.now(),
      kind: "pub",
      correlationId: null,
      to: null,
    });

    respond({
      type: "reinited",
      repos: targetRepos,
      updatedAgents,
      notifiedSockets,
      detail: `re-initialized ${updatedAgents.length} session(s) across ${targetRepos.length} repo(s); notified ${notifiedSockets} live socket(s)`,
    });
  }

  async function publish(
    conn: Conn,
    frame: { topic: string; body: string; id?: string; to?: string; universal?: boolean },
    respond: Respond,
    kind: BusMessage["kind"] = "pub",
    correlationId: string | null = null,
    extra?: { replyState?: ReplyState | null; supersedes?: string | null },
  ): Promise<void> {
    if (!frame.universal) {
      requireBoundRepo(conn);
    }
    requireTopic(frame.topic);
    requireBody(frame.body);
    if (frame.universal) {
      const targetRepos = allActiveRepos(conn);
      const universalMsg = store.insert({
        repo: UNIVERSAL_REPO,
        id: frame.id || randomUUID(),
        topic: frame.topic,
        fromId: conn.sessionId || conn.declaredSession || conn.name,
        fromName: conn.name,
        body: frame.body,
        ts: Date.now(),
        kind,
        correlationId,
        to: frame.to === "*" ? null : frame.to || null,
        replyState: extra?.replyState ?? null,
        supersedes: extra?.supersedes ?? null,
      });
      let lastWake: WakeInfo = {
        mode: "push",
        detail: `universal broadcast delivered across ${targetRepos.length} repo board(s)`,
      };
      for (const repo of targetRepos) {
        const repoMsg = store.insert({
          repo,
          id: randomUUID(),
          topic: frame.topic,
          fromId: conn.sessionId || conn.declaredSession || conn.name,
          fromName: conn.name,
          body: frame.body,
          ts: universalMsg.ts,
          kind,
          correlationId,
          to: frame.to === "*" ? null : frame.to || null,
          replyState: extra?.replyState ?? null,
          supersedes: extra?.supersedes ?? null,
        });
        fanout(repoMsg, conn);
        lastWake = await wakeFor(repo, repoMsg);
      }
      respond({
        type: "published",
        id: universalMsg.id,
        seq: universalMsg.seq,
        wake: {
          mode: lastWake.mode,
          detail: `universal broadcast across ${targetRepos.length} repo board(s) (${lastWake.detail})`,
        },
        correlationId: universalMsg.correlationId,
      });
      return;
    }
    const resolvedTo =
      frame.to !== undefined && frame.to !== "*" ? resolveRecipientTarget(conn.repo, frame.to) : frame.to;
    const message = store.insert({
      repo: conn.repo,
      id: frame.id || randomUUID(),
      topic: frame.topic,
      fromId: conn.sessionId || conn.declaredSession || conn.name,
      fromName: conn.name,
      body: frame.body,
      ts: Date.now(),
      kind,
      correlationId,
      to: resolvedTo === "*" ? null : resolvedTo || null,
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
    rawTo: string,
    body: string,
    topic: string | undefined,
    supersedes: string | undefined,
    ratioProject: string | undefined,
    respond: Respond,
  ): Promise<void> {
    requireBoundRepo(conn);
    const to = resolveRecipientTarget(conn.repo, rawTo);
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
    const boardExpectedRatio =
      ratioProject?.trim() ||
      extractStateRatioProject(store.listState(conn.repo)) ||
      readRepoConfigByKey(conn.repo)?.ratioProject?.trim() ||
      null;
    if (boardExpectedRatio) {
      const liveTargets = [...conns]
        .filter(
          (peer) =>
            peer.authed &&
            peer.repo === conn.repo &&
            peer.harness !== "cli" &&
            !peer.waitOnly &&
            (peer.name === to || peer.sessionId === to || peer.declaredSession === to),
        )
        .map((peer) => ({
          name: peer.name,
          harness: peer.harness,
          cwd: peer.cwd,
          sessionId: peer.sessionId,
        }));
      const fallbackTarget = describeTarget(conn.repo, to);
      const targetsToCheck =
        liveTargets.length > 0
          ? liveTargets
          : fallbackTarget
            ? [fallbackTarget]
            : [];
      for (const target of targetsToCheck) {
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
          const label =
            liveTargets.length > 1 && target.sessionId ? `${target.name} (session=${target.sessionId})` : target.name;
          throw new Error(
            `cannot ask ${label}: Ratio project mismatch (${target.name} has X-Ratio-Project=${targetRatio.project} in ${targetRatio.source} [configured MCP header], but this board/ask requires ${boardExpectedRatio})`,
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
      if (conn.role === "orchestrator" || isOrchestratorTarget(conn.repo, name, conn)) {
        throw new Error("the orchestrator reads reports in bus_inbox");
      }
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
    const isSender =
      conn.sessionId || conn.declaredSession
        ? conn.sessionId === askMessage.fromId ||
          conn.declaredSession === askMessage.fromId ||
          (askMessage.fromId === askMessage.fromName && conn.name === askMessage.fromName)
        : conn.name === askMessage.fromName;
    if (!isRecipient && !isSender) throw new Error("only ask participants may reply");
    const senderTarget =
      askMessage.fromId &&
      askMessage.fromId !== askMessage.fromName &&
      describeTarget(conn.repo, askMessage.fromId)
        ? askMessage.fromId
        : askMessage.fromName;
    const target =
      isSender && !isRecipient && askMessage.to ? askMessage.to : senderTarget;
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

  function clearPendingWakeTarget(repo: string, target: string | null | undefined, maxAckedSeq?: number): void {
    if (!target) return;
    const key = JSON.stringify([repo, target]);
    const entry = trailingWakes.get(key);
    if (entry && (maxAckedSeq === undefined || entry.message.seq <= maxAckedSeq || !isMessageUnreadForTarget(repo, entry.message))) {
      clearTimeout(entry.timer);
      trailingWakes.delete(key);
      store.clearDeferredWake(repo, target);
      return;
    }
    if (!entry) {
      store.clearDeferredWake(repo, target);
    }
  }

  function inbox(
    conn: Conn,
    since: number | undefined,
    topic: string | undefined,
    limit: number | undefined,
    ack: boolean | undefined,
    isHook: boolean,
    respond: Respond,
  ): void {
    requireBoundRepo(conn);
    if (topic) requireTopic(topic);
    const baseKey = clientKey(conn);
    const key = inboxCursorKey(baseKey, topic);
    const hookKey = `hook:${key}`;
    const isDefaultIncludedTopic =
      topic === "dm" ||
      topic === "repo" ||
      (conn.role === "orchestrator" && topic === "reports");
    const storedCursor = isHook
      ? Math.max(store.cursor(conn.repo, key), store.cursor(conn.repo, hookKey))
      : isDefaultIncludedTopic
        ? Math.max(store.cursor(conn.repo, key), store.cursor(conn.repo, baseKey))
        : store.cursor(conn.repo, key);
    const cursor = since ?? storedCursor;
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
      if (isHook) {
        store.ack(conn.repo, hookKey, next);
      } else {
        store.ack(conn.repo, key, next);
        store.ack(conn.repo, hookKey, next);
        if (!topic) {
          store.ack(conn.repo, inboxCursorKey(baseKey, "dm"), next);
          store.ack(conn.repo, inboxCursorKey(baseKey, "repo"), next);
          if (conn.role === "orchestrator") {
            store.ack(conn.repo, inboxCursorKey(baseKey, "reports"), next);
          }
        }
      }
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
        const companionHookKey = `hook:${companionKey}`;
        if (isHook) {
          if (store.cursor(conn.repo, companionHookKey) < next) {
            store.ack(conn.repo, companionHookKey, next);
          }
        } else {
          if (store.cursor(conn.repo, companionKey) < next) {
            store.ack(conn.repo, companionKey, next);
          }
          if (store.cursor(conn.repo, companionHookKey) < next) {
            store.ack(conn.repo, companionHookKey, next);
          }
          if (!topic) {
            store.ack(conn.repo, inboxCursorKey(companionBase, "dm"), next);
            store.ack(conn.repo, inboxCursorKey(companionBase, "repo"), next);
            if (conn.role === "orchestrator") {
              store.ack(conn.repo, inboxCursorKey(companionBase, "reports"), next);
            }
          }
        }
      }
      clearPendingWakeTarget(conn.repo, conn.name, next);
      if (conn.sessionId) clearPendingWakeTarget(conn.repo, conn.sessionId, next);
      if (primary) clearPendingWakeTarget(conn.repo, primary, next);
    }
    store.touchAgent(conn.repo, conn.name, undefined, conn.sessionId);
    const effectiveCursor = isHook
      ? Math.max(store.cursor(conn.repo, key), store.cursor(conn.repo, hookKey))
      : isDefaultIncludedTopic && since === undefined
        ? Math.max(store.cursor(conn.repo, key), store.cursor(conn.repo, baseKey))
        : store.cursor(conn.repo, key);
    const updatedCursor = shouldAck ? effectiveCursor : next;
    const pendingAsk = store.unansweredAsk(conn.repo, conn.name, updatedCursor, 0, conn.sessionId);
    respond({
      type: "inbox",
      messages,
      cursor: effectiveCursor,
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
    if (frame.role !== undefined && frame.role !== "orchestrator" && frame.role !== "worker") {
      throw new Error("role must be orchestrator or worker");
    }
    const checkRepo =
      conn.cwd === "/" || Boolean(frame.rebind && conn.harness !== "cli")
        ? (existsSync(frame.cwd) ? repoKey(frame.cwd) : conn.repo)
        : conn.repo;
    const hasSameNamePeer = [...conns].some(
      (peer) =>
        peer !== conn &&
        peer.authed &&
        peer.repo === checkRepo &&
        peer.harness !== "cli" &&
        !peer.waitOnly &&
        peer.name === frame.name,
    );
    const claimSessionId =
      frame.sessionId ||
      frame.wakeSessionId ||
      (conn.harness !== "cli" && conn.name === frame.name
        ? (conn.sessionId || conn.declaredSession || (conn.sessionBound ? conn.wakeSessionId : null))
        : null) ||
      (!hasSameNamePeer ? frame.name : null);
    if (frame.role === "orchestrator" && !claimSessionId) {
      throw new Error("cannot claim orchestrator without a bound session id when multiple sessions share the same agent name");
    }
    const isRebind = conn.cwd === "/" || Boolean(frame.rebind && conn.harness !== "cli");
    let nextCwd = frame.cwd;
    let nextRepo = conn.repo;
    if (isRebind) {
      const sharedRoot = gitRepoRoot(frame.cwd, "share");
      const splitRoot = gitRepoRoot(frame.cwd, "split");
      if (!existsSync(frame.cwd) || (!existsSync(`${sharedRoot}/.git`) && !existsSync(`${splitRoot}/.git`))) {
        throw new Error(`cannot bind repository: ${frame.cwd} is not a git checkout`);
      }
      nextCwd = splitRoot;
      nextRepo = repoKey(frame.cwd);
    } else {
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
      if (existsSync(frame.cwd) && (existsSync(`${gitRepoRoot(frame.cwd)}/.git`) || existsSync(`${gitRepoRoot(frame.cwd, "split")}/.git`))) {
        nextCwd = gitRepoRoot(frame.cwd, "split");
      }
      nextRepo = conn.repo;
    }
    if (isSessionLiveInOtherRepo(nextRepo, frame.sessionId, frame.wakeSessionId, conn)) {
      throw new Error("cannot register: session is currently active in another repository board");
    }
    const isOwnConn =
      conn.harness !== "cli" &&
      (conn.name === frame.name || Boolean(frame.sessionId && (conn.sessionId === frame.sessionId || conn.declaredSession === frame.sessionId)));
    const oldConnName = conn.name;
    const oldCwd = conn.cwd;
    const oldRepo = conn.repo;
    const nextDeclaredSession =
      isOwnConn && frame.sessionId
        ? frame.sessionId
        : conn.declaredSession;
    const groupChanged = oldRepo !== nextRepo || conn.declaredSession !== nextDeclaredSession || (isOwnConn && oldConnName !== frame.name);
    if (oldCwd !== "/" && groupChanged && conn.harness !== "cli") {
      presence(conn, "offline");
    }
    if (isRebind) {
      if (oldRepo && oldRepo !== nextRepo) {
        store.evictCrossRepoBinding(nextRepo, conn.sessionId, conn.wakeSessionId);
      }
      conn.cwd = nextCwd;
      conn.repo = nextRepo;
      conn.role = elect(conn.repo, frame.name, conn.role === "orchestrator", claimSessionId);
    }
    store.evictCrossRepoBinding(conn.repo, frame.sessionId, frame.wakeSessionId);
    const byName = store.getAgent(conn.repo, frame.name);
    const existing = frame.sessionId
      ? (store.getAgentBySession(conn.repo, frame.sessionId) ?? (!byName?.sessionId ? byName : undefined))
      : byName;
    if (frame.sessionId) {
      store.migrateSubscriptions(conn.repo, `name:${frame.name}`, frame.sessionId);
      if (existing && existing.name !== frame.name) {
        store.migrateSessionCursors(conn.repo, existing.name, frame.name, frame.sessionId);
      }
      if (isOwnConn && oldConnName !== frame.name) {
        store.migrateSessionCursors(conn.repo, oldConnName, frame.name, frame.sessionId);
      }
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
        : gitCheckoutInfo(nextCwd);
    const wake = frame.wake === undefined ? (existing ? existing.wake : true) : frame.wake;
    const existingStatus =
      existing?.status === "invited"
        ? (isOwnConn ? "online" : "registered")
        : existing?.status;
    const status =
      !isOwnConn
        ? (existingStatus || "registered")
        : (conn.status === "invited" ? "online" : (conn.status || "online"));
    const inheritedWakeSessionId =
      frame.wakeSessionId ??
      (!existing?.sessionId || existing.sessionId === frame.sessionId ? existing?.wakeSessionId : null) ??
      null;
    const saved = store.upsertAgent({
      repo: conn.repo,
      name: frame.name,
      harness: frame.harness,
      sessionId: frame.sessionId || null,
      wakeSessionId: inheritedWakeSessionId,
      cwd: nextCwd,
      branch: checkout.branch,
      head: checkout.head,
      wake,
      status,
      bySession: Boolean(frame.sessionId),
    });
    if (isOwnConn) {
      conn.name = frame.name;
      if (frame.sessionId) {
        conn.declaredSession = frame.sessionId;
        conn.sessionId = frame.sessionId;
        conn.sessionBound = true;
      } else if (isRebind && oldRepo !== nextRepo) {
        conn.declaredSession = null;
        conn.sessionId = null;
        conn.sessionBound = false;
      }
      conn.wakeSessionId =
        frame.wakeSessionId ||
        saved.wakeSessionId ||
        frame.sessionId ||
        (oldRepo === nextRepo ? conn.wakeSessionId : null);
      conn.branch = checkout.branch ?? (oldRepo === nextRepo ? conn.branch : null);
      conn.head = checkout.head ?? (oldRepo === nextRepo ? conn.head : null);
      conn.wake = wake;
      conn.status = status;
      restoreSubscriptions(conn);
      if (conn.cwd !== "/" && (oldCwd === "/" || groupChanged)) {
        presence(conn, "online");
        replayDeferredWakes(conn.repo);
      }
    } else {
      for (const peer of conns) {
        if (!peer.authed || peer.repo !== conn.repo || peer.harness === "cli") continue;
        if (peer.name !== frame.name && !(frame.sessionId && (peer.sessionId === frame.sessionId || peer.declaredSession === frame.sessionId))) {
          continue;
        }
        peer.name = frame.name;
        if (!peer.sessionBound && frame.sessionId) {
          peer.declaredSession = frame.sessionId;
          peer.sessionId = frame.sessionId;
          peer.sessionBound = true;
        }
        if (frame.wakeSessionId || saved.wakeSessionId || frame.sessionId) {
          peer.wakeSessionId = frame.wakeSessionId || saved.wakeSessionId || frame.sessionId || peer.wakeSessionId;
        }
        peer.branch = checkout.branch ?? peer.branch;
        peer.head = checkout.head ?? peer.head;
        peer.wake = wake;
        restoreSubscriptions(peer);
      }
    }
    let claimRejected: boolean | undefined;
    let claimDetail: string | undefined;
    if (frame.role === "orchestrator" && claimSessionId) {
      const currentOrch = store.getOrchestrator(conn.repo);
      const canClaim =
        !currentOrch ||
        currentOrch === claimSessionId ||
        (!isSessionOrchestratorValue(conn.repo, currentOrch) && currentOrch === frame.name) ||
        !hasLiveOrchestratorSocket(conn.repo, currentOrch);
      if (canClaim) {
        store.setOrchestrator(conn.repo, claimSessionId);
        syncOrchestratorRoles(conn.repo);
      } else {
        claimRejected = true;
        claimDetail = `orchestrator role is already claimed by ${currentOrch} (online); registered as worker — do not retry claiming orchestrator`;
        syncOrchestratorRoles(conn.repo);
      }
    } else if (frame.role === "worker") {
      const currentOrch = store.getOrchestrator(conn.repo);
      if (claimSessionId && currentOrch === claimSessionId) {
        store.setOrchestrator(conn.repo, "");
      }
      syncOrchestratorRoles(conn.repo);
      if (conn.harness !== "cli" && conn.name === frame.name) {
        conn.role = "worker";
      }
    } else {
      syncOrchestratorRoles(conn.repo);
    }
    const savedRole: Role = isOrchestratorTarget(conn.repo, store.getOrchestrator(conn.repo), {
      name: saved.name,
      sessionId: saved.sessionId,
      declaredSession: saved.sessionId,
      wakeSessionId: saved.wakeSessionId,
    })
      ? "orchestrator"
      : "worker";
    respond({
      type: "registered",
      name: frame.name,
      agent: { ...saved, role: savedRole },
      created: !existing,
      role: conn.harness === "cli" ? savedRole : conn.role,
      orchestrator: store.getOrchestrator(conn.repo) || null,
      ...(claimRejected ? { claimRejected, claimDetail } : {}),
    });
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
      applyOrchestrator(conn, frame.orchestrator, true);
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
          !existingOffline.sessionId.startsWith("pty:") &&
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
    const row = store.getAgent(repo, message.to);
    const isDirectSession = looksLikeSessionTarget(message.to);
    const cursorKeys = new Set<string>([target.name, message.to]);
    if (target.declaredSession && !target.declaredSession.startsWith("zellij:")) {
      cursorKeys.add(`${target.name}:${target.declaredSession}`);
    }
    if (row?.sessionId && !row.sessionId.startsWith("zellij:")) {
      cursorKeys.add(`${target.name}:${row.sessionId}`);
    }
    for (const peer of conns) {
      if (!peer.authed || peer.repo !== repo || peer.harness === "cli") continue;
      const matchesPeer = isDirectSession
        ? peer.sessionId === message.to || peer.declaredSession === message.to || (!peer.sessionBound && peer.name === target.name)
        : peer.name === target.name || peer.sessionId === message.to || peer.declaredSession === message.to;
      if (matchesPeer) {
        cursorKeys.add(clientKey(peer));
      }
    }
    for (const cKey of cursorKeys) {
      if (store.cursor(repo, cKey) >= message.seq) return false;
      if (store.cursor(repo, `hook:${cKey}`) >= message.seq) return false;
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
    const existing = trailingWakes.get(key);
    let effectiveMessage = message;
    if (existing) {
      clearTimeout(existing.timer);
      if (
        existing.message.kind === "ask" &&
        message.kind !== "ask" &&
        isMessageUnreadForTarget(repo, existing.message)
      ) {
        effectiveMessage = existing.message;
      }
    }
    if (effectiveMessage.to) {
      store.saveDeferredWake(repo, effectiveMessage.to, effectiveMessage.seq);
    }
    const elapsed = Date.now() - (lastWake.get(key) ?? 0);
    const remainingCooldown = wakeCooldownMs - Math.max(0, elapsed);
    const delay =
      remainingCooldown > 0
        ? Math.max(25, remainingCooldown)
        : Math.max(25, Math.min(wakeCooldownMs, 1000));
    const timer = setTimeout(() => {
      trailingWakes.delete(key);
      if (stopping) return;
      if (!isMessageUnreadForTarget(repo, effectiveMessage)) {
        if (effectiveMessage.to) store.clearDeferredWake(repo, effectiveMessage.to);
        return;
      }
      void wakeFor(repo, effectiveMessage);
    }, delay);
    timer.unref?.();
    trailingWakes.set(key, { timer, message: effectiveMessage });
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
    const hasActiveWaiter = [...conns].some(
      (c) =>
        c.authed &&
        c.repo === repo &&
        c.waitOnly &&
        (c.name === target.name ||
          (target.declaredSession && (c.sessionId === target.declaredSession || c.declaredSession === target.declaredSession)) ||
          (target.sessionId && (c.sessionId === target.sessionId || c.declaredSession === target.sessionId))),
    );
    const info = decideWake({
      directed: true,
      online: target.online,
      harness: target.harness,
      sessionId: target.sessionId,
      wakeEnabled: target.wake,
      recipient: target.name,
      hasActiveWaiter,
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
      store.clearDeferredWake(repo, message.to);
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
      ? (live.wakeSessionId ||
        ((!live.sessionBound || live.sessionId === row?.sessionId || !row?.sessionId) ? row?.wakeSessionId : null) ||
        (live.sessionBound ? live.sessionId : null))
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
          ((!conn.sessionBound || conn.sessionId === registered?.sessionId || !registered?.sessionId)
            ? registered?.wakeSessionId
            : null) ||
          (conn.sessionBound ? conn.sessionId : registered?.sessionId ?? null),
        cwd: conn.cwd,
        branch: conn.branch ?? registered?.branch ?? null,
        head: conn.head ?? registered?.head ?? null,
        wake: registered?.wake ?? conn.wake,
        lastSeen: Math.max(...members.map((member) => member.lastSeen)),
        online: true,
        status: conn.status === "invited" ? "online" : (conn.status || "online"),
        role: isOrchestratorTarget(repo, orchestrator, conn) ? "orchestrator" : "worker",
        connectionCount: counted.length,
        connectionIds: counted.map((member) => member.agentId),
        builds: counted.flatMap((member) => (member.build ? [member.build] : [])),
        ratio: discoverRatioBinding({ cwd: conn.cwd, harness: conn.harness, name: conn.name }),
      };
    });
    const includeAllOffline = Boolean(opts?.includeAllOffline);
    const liveNames = new Set(rows.map((row) => row.name));
    const liveSessions = new Set(
      rows.flatMap((row) => [
        ...(row.sessionId ? [row.sessionId] : []),
        ...(row.wakeSessionId ? [row.wakeSessionId] : []),
      ]),
    );
    const seenOfflineByName = new Set<string>();
    const staleCutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const row of store.listAgents(repo, new Set())) {
      const represented = row.sessionId
        ? liveSessions.has(row.sessionId) || rows.some((live) => live.online && live.name === row.name && !live.sessionId)
        : liveNames.has(row.name) || (row.wakeSessionId ? liveSessions.has(row.wakeSessionId) : false);
      if (represented) continue;
      if (!includeAllOffline && row.status !== "invited") {
        if (liveNames.has(row.name)) continue;
        if (seenOfflineByName.has(row.name)) continue;
        if (!row.wake && row.lastSeen < staleCutoff) continue;
        seenOfflineByName.add(row.name);
      }
      rows.push({
        ...row,
        wakeSessionId:
          row.status === "invited" || (row.wakeSessionId && paneTarget(row.wakeSessionId))
            ? (row.wakeSessionId || row.sessionId || null)
            : (row.sessionId || row.wakeSessionId || null),
        connectionCount: 0,
        role: isOrchestratorTarget(repo, orchestrator, row) ? "orchestrator" : "worker",
        ratio: discoverRatioBinding({ cwd: row.cwd, harness: row.harness, name: row.name }),
      });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name) || (a.sessionId ?? "").localeCompare(b.sessionId ?? ""));
    return rows;
  }

  function requireBoundRepo(conn: Conn): void {
    if (!conn.cwd || conn.cwd === "/" || !conn.repo) {
      const activeCwds = new Set<string>();
      for (const peer of conns) {
        if (peer.authed && peer.cwd && peer.cwd !== "/") activeCwds.add(peer.cwd);
      }
      for (const r of store.listRepos()) {
        for (const a of store.listAgents(r, new Set())) {
          if (a.cwd && a.cwd !== "/") activeCwds.add(a.cwd);
        }
      }
      const hint = activeCwds.size > 0 ? ` (active checkouts: ${[...activeCwds].sort().join(", ")})` : "";
      throw new Error(
        `session is not bound to a repository checkout (cwd is "/"); call bus_register({ cwd: "<absolute-repo-path>" }) first to bind this session to your current workspace${hint}`,
      );
    }
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
        for (const entry of trailingWakes.values()) clearTimeout(entry.timer);
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

function looksLikeSessionTarget(to: string): boolean {
  return (
    UUID_RE.test(to) ||
    TTY_RE.test(to) ||
    to.startsWith("zellij:") ||
    to.startsWith("pty:") ||
    to.startsWith("tmux:") ||
    /^%\d+$/.test(to)
  );
}

function looksLikePaneOrTtyTarget(id: string): boolean {
  return Boolean(paneTarget(id) || TTY_RE.test(id));
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


