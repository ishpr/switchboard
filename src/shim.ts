import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { inferClaudeAgentName } from "./accounts.ts";
import { BUILD, buildWarning, formatBuild, loadBuild } from "./build.ts";
import { formatDiagnostics } from "./health.ts";
import { formatAgentMetrics, formatBoardState, formatPendingAsks } from "./status.ts";
import { BusClient } from "./busClient.ts";
import { ensureDaemon } from "./ensure.ts";
import { formatRatioBinding, resolveShimCwd } from "./init.ts";
import { Store } from "./store.ts";
import { formatWaitResult, waitForMessages } from "./wait.ts";
import { dbPath, switchboardHome } from "./paths.ts";
import { gitCheckoutInfo, gitRepoRoot, repoKey } from "./repo.ts";
import { readToken } from "./token.ts";
import { HEARTBEAT_MS, NAME_RE, STATE_KEY_RE, TOPIC_RE, type BusMessage, type Role } from "./types.ts";
import { formatMessage } from "./hook.ts";
import { UUID_RE } from "./wake.ts";

export function parseZellijSessionFromPs(output: string): { ppid: number; session: string | null } {
  const trimmed = output.trim();
  const match = /^(\d+)\s+(.*)$/s.exec(trimmed);
  if (!match) return { ppid: 0, session: null };
  const ppid = Number(match[1]);
  const cmd = match[2];
  const sMatch = /(?:^|\s)ZELLIJ_SESSION_NAME=([^\s]+)/.exec(cmd);
  const pMatch = /(?:^|\s)ZELLIJ_PANE_ID=(\d+)/.exec(cmd);
  if (sMatch && pMatch) {
    return { ppid, session: `zellij:${sMatch[1]}:${pMatch[1]}` };
  }
  return { ppid, session: null };
}

export function discoverZellijSession(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.ZELLIJ_SESSION_NAME && env.ZELLIJ_PANE_ID) {
    return `zellij:${env.ZELLIJ_SESSION_NAME}:${env.ZELLIJ_PANE_ID}`;
  }
  let pid = process.ppid;
  for (let depth = 0; depth < 4 && pid > 1; depth++) {
    try {
      const out = execFileSync("ps", ["eww", "-o", "ppid=,command=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const parsed = parseZellijSessionFromPs(out);
      if (parsed.session) return parsed.session;
      pid = parsed.ppid;
    } catch {
      break;
    }
  }
  return undefined;
}

export function parseTerminalTtyFromPs(output: string): {
  ppid: number;
  tty: string | null;
  appleTerminal: boolean;
} {
  const trimmed = output.trim();
  const match = /^(\d+)\s+([^\s]+)\s+(.*)$/s.exec(trimmed);
  if (!match) return { ppid: 0, tty: null, appleTerminal: false };
  const ppid = Number(match[1]);
  const rawTty = match[2]!;
  const cmd = match[3]!;
  const tty = /^ttys\d+$/.test(rawTty)
    ? `tty:/dev/${rawTty}`
    : /^\/dev\/ttys\d+$/.test(rawTty)
      ? `tty:${rawTty}`
      : null;
  const appleTerminal =
    /(?:^|\s)TERM_PROGRAM=Apple_Terminal(?:\s|$)/.test(cmd) ||
    /(?:^|\s)__CFBundleIdentifier=com.apple.Terminal(?:\s|$)/.test(cmd);
  return { ppid, tty, appleTerminal };
}

export function discoverTerminalTty(
  env: NodeJS.ProcessEnv = process.env,
  harness = env.SWITCHBOARD_HARNESS || "unknown",
): string | undefined {
  if (harness === "codex") return undefined;
  if (env.ZELLIJ_SESSION_NAME || env.ZELLIJ_PANE_ID || env.TMUX_PANE) return undefined;
  let appleTerminal =
    env.TERM_PROGRAM === "Apple_Terminal" ||
    env.__CFBundleIdentifier === "com.apple.Terminal";
  let recordedTty: string | undefined;
  let pid = process.ppid;
  for (let depth = 0; depth < 4 && pid > 1; depth++) {
    try {
      const out = execFileSync("ps", ["eww", "-o", "ppid=,tty=,command=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const parsed = parseTerminalTtyFromPs(out);
      if (!recordedTty && parsed.tty) recordedTty = parsed.tty;
      if (parsed.appleTerminal) appleTerminal = true;
      if (recordedTty && appleTerminal) return recordedTty;
      pid = parsed.ppid;
    } catch {
      break;
    }
  }
  return appleTerminal ? recordedTty : undefined;
}

export function discoverCodexThread(
  cwd: string,
  codexHome = process.env.CODEX_HOME || path.join(homedir(), ".codex"),
): string | undefined {
  if (!cwd || cwd === "/" || !existsSync(cwd)) return undefined;
  const dbFile = path.join(codexHome, "state_5.sqlite");
  if (!existsSync(dbFile)) return undefined;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbFile, { open: true, readOnly: true });
    const stmt = db.prepare(
      `SELECT id FROM threads
       WHERE cwd = ? AND thread_source = 'user' AND archived = 0
       ORDER BY updated_at DESC
       LIMIT 1`,
    );
    const exact = stmt.get(cwd) as { id?: string } | undefined;
    if (exact?.id && UUID_RE.test(exact.id)) return exact.id;
    const root = gitRepoRoot(cwd, "split");
    if (root && root !== "/" && root !== cwd) {
      const byRoot = stmt.get(root) as { id?: string } | undefined;
      if (byRoot?.id && UUID_RE.test(byRoot.id)) return byRoot.id;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore close errors on read-only lookup
    }
  }
}

export function discoverGrokSession(
  cwd: string,
  grokHome = process.env.GROK_HOME || path.join(homedir(), ".grok"),
): string | undefined {
  if (!cwd || cwd === "/" || !existsSync(cwd)) return undefined;
  const activeFile = path.join(grokHome, "active_sessions.json");
  if (!existsSync(activeFile)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(activeFile, "utf8")) as Array<{
      session_id?: string;
      pid?: number;
      cwd?: string;
      opened_at?: string;
    }>;
    if (!Array.isArray(raw)) return undefined;
    const root = gitRepoRoot(cwd, "split");
    const matching = raw
      .filter((entry) => {
        if (!entry?.session_id || !UUID_RE.test(entry.session_id) || !entry.cwd) return false;
        if (entry.cwd === cwd) return true;
        return root !== "/" && gitRepoRoot(entry.cwd, "split") === root;
      })
      .sort((a, b) => String(b.opened_at ?? "").localeCompare(String(a.opened_at ?? "")));
    const byPpid = matching.find((entry) => entry.pid === process.ppid);
    if (byPpid?.session_id) return byPpid.session_id;
    return matching[0]?.session_id;
  } catch {
    return undefined;
  }
}

export function discoverHarnessSession(opts: {
  cwd: string;
  harness: string;
  env?: NodeJS.ProcessEnv;
  codexHome?: string;
  grokHome?: string;
}): { sessionId?: string; wakeSessionId?: string } {
  const env = opts.env ?? process.env;
  const explicit = env.SWITCHBOARD_SESSION?.trim() || undefined;
  const zellijSession = discoverZellijSession(env);
  const tmuxSession = /^%\d+$/.test(env.TMUX_PANE ?? "") ? `tmux:${env.TMUX_PANE}` : undefined;
  const paneSession = zellijSession || tmuxSession;
  const envSession =
    env.CODEX_THREAD_ID?.trim() ||
    env.MUSE_SESSION_ID?.trim() ||
    env.CLAUDE_CODE_SESSION_ID?.trim() ||
    env.GROK_SESSION_ID?.trim() ||
    undefined;
  const codexThread =
    !explicit && !paneSession && !envSession && opts.harness === "codex"
      ? discoverCodexThread(opts.cwd, opts.codexHome)
      : undefined;
  const grokSession =
    !explicit && !paneSession && !envSession && opts.harness === "grok"
      ? discoverGrokSession(opts.cwd, opts.grokHome)
      : undefined;
  const ttySession =
    !explicit && !paneSession && opts.harness !== "codex"
      ? discoverTerminalTty(env, opts.harness)
      : undefined;
  const sessionId = explicit || paneSession || envSession || codexThread || grokSession || undefined;
  const wakeSessionId = explicit || paneSession || ttySession || sessionId || undefined;
  return { sessionId, wakeSessionId };
}

export function missingSessionSource(harness: string, cwd: string): string {
  if (!cwd || cwd === "/") {
    return 'cannot register: shim started with cwd="/" and could not resolve a single repository checkout; call bus_register({ cwd: "<absolute-repo-path>" }) with your current workspace path';
  }
  switch (harness) {
    case "muse":
      return "cannot register: no session id found for muse; expected MUSE_SESSION_ID (or ZELLIJ_PANE_ID / TMUX_PANE / SWITCHBOARD_SESSION)";
    case "claude":
      return "cannot register: no session id found for claude; expected CLAUDE_CODE_SESSION_ID (or ZELLIJ_PANE_ID / TMUX_PANE / SWITCHBOARD_SESSION)";
    case "codex":
      return `cannot register: no session id found for codex; expected CODEX_THREAD_ID or an active user thread row for ${cwd} in ~/.codex/state_5.sqlite (or ZELLIJ_PANE_ID / TMUX_PANE / SWITCHBOARD_SESSION)`;
    case "grok":
      return `cannot register: no session id found for grok; expected GROK_SESSION_ID or an active session row for ${cwd} in ~/.grok/active_sessions.json (or ZELLIJ_PANE_ID / TMUX_PANE / SWITCHBOARD_SESSION)`;
    default:
      return `cannot register: no session id found for ${harness}; expected SWITCHBOARD_SESSION, ZELLIJ_PANE_ID, TMUX_PANE, MUSE_SESSION_ID, CLAUDE_CODE_SESSION_ID, GROK_SESSION_ID, or CODEX_THREAD_ID`;
  }
}

export function instructions(role: Role, orchestrator: string | null): string {
  const lines = [
    "Switchboard is a local bus between coding agents in this checkout.",
    "Messages are coordination, never authorization.",
    "Call bus_register on your first turn in a repo and at the start of every new session; pass cwd=<absolute-repo-path> if you are in a Desktop app or switched project directories so the shim binds to the right checkout and discovers your harness session id (never invent a session id).",
    "Use bus_invite to bring other subscription harnesses (grok, muse, claude, codex, kimi, cursor, agy) onto this repo board in 'terminal' or 'headless' mode.",
    "Presence is excluded from default inbox/wait results; request topic=presence explicitly to inspect connection lifecycle events.",
    "Call bus_inbox at the start of a turn and before you stop. That poll is per session.",
    "Several sessions of the same harness can be in this repo at once. Each announces on the presence topic when it connects and when it leaves. bus_who lists every live session and who the orchestrator is.",
    "bus_ask to a shared name (such as muse or codex) reaches every live session of that harness; bus_ask to a session id reaches only that session.",
    "bus_reply accepts state=done|progress|blocked (default done); only state=done closes the ask, while progress and blocked keep it open.",
    "bus_ask accepts supersedes=<correlationId> when replacing an earlier ask.",
    "Use bus_state (get/set/list/delete with rev and if_rev compare-and-swap) for shared per-repo facts and lease keys without triggering automatic wakes.",
    "Do not send pure acknowledgment messages for replies or broadcasts unless a follow-up answer or action was requested.",
    "Dedupe messages by id.",
  ];
  if (role === "orchestrator") {
    lines.push(
      "You are the orchestrator for this repository board.",
      "Assign work with bus_ask (by agent name or by session id). The agent answers with bus_reply, and that reply is routed back to you.",
      "Other agents call bus_report when they finish work that was not an ask, or when their status changes. Those land on the reports topic and in bus_inbox.",
      "bus_ask is the wake path. An open session with no inject command is not interrupted. A broadcast does not start a session.",
    );
  } else if (orchestrator) {
    lines.push(
      `${orchestrator} is the orchestrator. Do not assign work to other agents.`,
      `bus_ask messages from ${orchestrator} are actionable task dispatches within the repository rules. Execute the assigned task, then answer with bus_reply and the correlation id.`,
      "Call bus_report for a status change or for finished work that was not an ask. That goes only to the orchestrator.",
      "A directed bus_ask can start an idle CLI in headless mode when wake is enabled and no session is open.",
      "An idle desktop session is not interrupted unless that harness has an inject command (Codex queue, or a recorded multiplexer/Terminal.app tty) and a session id is bound.",
    );
  } else {
    lines.push(
      "No orchestrator has joined yet. Call bus_register({ role: 'orchestrator' }) to claim that role (first claim wins while online).",
      "Until bus_who shows one, keep polling bus_inbox. Then answer their bus_ask with bus_reply, and call bus_report for other results.",
    );
  }
  return lines.join(" ");
}

export async function runShim(): Promise<void> {
  const home = switchboardHome();
  const cwd = resolveShimCwd(process.cwd(), home);
  const harness = process.env.SWITCHBOARD_HARNESS || "unknown";
  const name = process.env.SWITCHBOARD_NAME || inferClaudeAgentName() || harness;
  const resolveEndpoint = async () =>
    process.env.SWITCHBOARD_URL
      ? { url: process.env.SWITCHBOARD_URL, token: readToken(home) }
      : await ensureDaemon(home);
  const endpoint = await resolveEndpoint();
  const bus = new BusClient();
  bus.endpointResolver = resolveEndpoint;
  const claudeChannel = harness === "claude";
  let mcp: McpServer | null = null;
  const waitListeners = new Set<() => void>();

  bus.onMessage = (frame) => {
    for (const wake of waitListeners) wake();
    if (!claudeChannel || !mcp) return;
    const text = formatMessage(frame.message);
    void mcp.server
      .notification({
        method: "notifications/claude/channel",
        params: {
          content: text,
          meta: {
            topic: frame.message.topic,
            from_name: frame.message.fromName,
            message_id: frame.message.id,
          },
        },
      })
      .catch(() => {
        // The session is not listening for channel events. The log still has the message.
      });
  };

  // Omit wake unless the env var is set, so `agent add --wake` survives a later connect.
  const wakeFlag = process.env.SWITCHBOARD_WAKE;
  const discovered = discoverHarnessSession({ cwd, harness, env: process.env });
  const sessionId = discovered.sessionId;
  const wakeSessionId = discovered.wakeSessionId;
  const boundSession = Boolean(sessionId);
  const checkout = gitCheckoutInfo(cwd);
  const welcome = await bus.connect(endpoint.url, {
    type: "hello",
    token: endpoint.token,
    name,
    harness,
    repoKey: repoKey(cwd),
    cwd,
    branch: checkout.branch,
    head: checkout.head,
    sessionId,
    wakeSessionId,
    boundSession,
    ...(wakeFlag === "1" ? { wake: true } : wakeFlag === "0" ? { wake: false } : {}),
    ...(process.env.SWITCHBOARD_ROLE === "orchestrator" ? { role: "orchestrator" as const } : {}),
    status: "online",
  });

  mcp = new McpServer(
    { name: "switchboard", version: `${BUILD.version}+${BUILD.commit_sha?.slice(0, 8) ?? "unknown"}` },
    {
      instructions: instructions(welcome.role, welcome.orchestrator),
      capabilities: {
        tools: {},
        logging: {},
        experimental: claudeChannel ? { "claude/channel": {} } : {},
      },
    },
  );

  const heartbeat = setInterval(() => {
    bus.send({ type: "heartbeat" });
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  let activeBuild = BUILD;
  let currentRole: Role = welcome.role;
  const toolContext = {
    home,
    name,
    harness,
    cwd,
    repo: welcome.repoKey,
    orchestrator: welcome.orchestrator,
    sessionId,
    wakeSessionId,
    subscribeWake: (wake: () => void) => {
      waitListeners.add(wake);
      return () => waitListeners.delete(wake);
    },
  };

  bus.onWelcome = (w) => {
    currentRole = w.role;
    toolContext.orchestrator = w.orchestrator;
    if (mcp) {
      (mcp.server as unknown as { _instructions?: string })._instructions = instructions(w.role, w.orchestrator);
    }
  };

  registerTools(mcp, bus, currentRole, toolContext);

  bus.reloadOnReconnect = async () => {
    const diskBuild = loadBuild();
    if (!mcp) return activeBuild;
    if (diskBuild.commit_sha && diskBuild.commit_sha !== activeBuild.commit_sha) {
      const freshModule = (await import(`${import.meta.url}?v=${diskBuild.commit_sha}_${Date.now()}`)) as {
        registerTools?: typeof registerTools;
      };
      if (typeof freshModule.registerTools === "function") {
        const regMap = (mcp as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools;
        if (regMap) {
          for (const key of Object.keys(regMap)) delete regMap[key];
        }
        freshModule.registerTools(mcp, bus, currentRole, toolContext);
        mcp.sendToolListChanged();
        activeBuild = diskBuild;
      }
    }
    return activeBuild;
  };

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
}

export function registerTools(mcp: McpServer, bus: BusClient, role: Role,
  context: {
    home: string;
    name: string;
    harness: string;
    cwd: string;
    repo: string;
    orchestrator: string | null;
    sessionId?: string;
    wakeSessionId?: string;
    subscribeWake?: (wake: () => void) => () => void;
  }): void {
  mcp.registerTool(
    "bus_register",
    {
      description:
        "Register this session on the repo board. Pass cwd=<absolute-repo-path> when starting in a Desktop app (whose MCP shim starts at cwd=\"/\") or when switching project checkouts so the shim binds to that checkout and discovers your harness session id (MUSE_SESSION_ID, CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID, ~/.codex/state_5.sqlite, or ~/.grok/active_sessions.json) plus git branch and HEAD. Pass role='orchestrator' to claim the orchestrator role for this session (first claim wins while online).",
      inputSchema: {
        cwd: z
          .string()
          .min(1)
          .optional()
          .describe("Absolute path to the git checkout this session is working in (required when MCP shim started at cwd=\"/\" or switched repos)"),
        role: z
          .enum(["orchestrator", "worker"])
          .optional()
          .describe("Optional role to claim for this session ('orchestrator' or 'worker'). First claim wins while that orchestrator session is online."),
        wake: z
          .boolean()
          .optional()
          .describe("Enable or disable offline headless wake for this session (defaults to true for a new registration; preserves existing setting when omitted)"),
      },
    },
    async ({ cwd, role: requestedRole, wake }) => {
      let rebind = false;
      let targetCwd = context.cwd;
      let targetRepo = context.repo;
      if (cwd !== undefined) {
        const trimmed = cwd.trim();
        if (!trimmed || trimmed === "/" || !existsSync(trimmed)) {
          return { ...text(`cannot register: invalid cwd "${cwd}"`), isError: true };
        }
        const sharedRoot = gitRepoRoot(trimmed, "share");
        const splitRoot = gitRepoRoot(trimmed, "split");
        if (!existsSync(path.join(sharedRoot, ".git")) && !existsSync(path.join(splitRoot, ".git"))) {
          return { ...text(`cannot register: "${cwd}" is not inside a git repository`), isError: true };
        }
        rebind = splitRoot !== context.cwd || context.cwd === "/";
        targetCwd = splitRoot;
        targetRepo = repoKey(trimmed);
      }
      const fresh = discoverHarnessSession({ cwd: targetCwd, harness: context.harness, env: process.env });
      const resolvedSessionId = fresh.sessionId || (rebind ? undefined : context.sessionId);
      const resolvedWakeSessionId =
        fresh.wakeSessionId || (rebind ? undefined : context.wakeSessionId) || resolvedSessionId;
      if (!targetCwd || targetCwd === "/" || (!resolvedSessionId && !cwd)) {
        return { ...text(missingSessionSource(context.harness, targetCwd)), isError: true };
      }
      const { branch, head } = gitCheckoutInfo(targetCwd);
      const frame = await bus.request({
        type: "register",
        name: context.name,
        harness: context.harness,
        cwd: targetCwd,
        rebind: Boolean(cwd),
        sessionId: resolvedSessionId,
        wakeSessionId: resolvedWakeSessionId,
        branch,
        head,
        ...(wake !== undefined ? { wake } : {}),
        ...(requestedRole !== undefined ? { role: requestedRole } : {}),
      });
      if (frame.type !== "registered") return { ...text("registration failed"), isError: true };
      const agent = frame.agent;
      const effectiveSessionId = agent?.sessionId ?? resolvedSessionId;
      const effectiveWakeSessionId = agent?.wakeSessionId ?? resolvedWakeSessionId;
      context.cwd = targetCwd;
      context.repo = targetRepo;
      context.sessionId = effectiveSessionId ?? undefined;
      context.wakeSessionId = effectiveWakeSessionId ?? undefined;
      if (frame.role) role = frame.role;
      if (frame.orchestrator !== undefined) context.orchestrator = frame.orchestrator;
      bus.updateHello({
        cwd: context.cwd,
        repoKey: context.repo,
        role,
        branch,
        head,
        sessionId: context.sessionId,
        wakeSessionId: context.wakeSessionId,
        boundSession: Boolean(context.sessionId),
        ...(agent?.wake !== undefined ? { wake: agent.wake } : {}),
      });
      const statusLabel = frame.created ? "new" : "existing";
      const wakeFlagLabel = agent?.wake !== undefined ? ` wake=${agent.wake ? "on" : "off"}` : "";
      const wakePart =
        !context.sessionId && !context.wakeSessionId
          ? " wake=push (no injectable session id discovered; messages arrive via hooks/bus_inbox while open)"
          : context.wakeSessionId && context.wakeSessionId !== context.sessionId
            ? `${wakeFlagLabel} wake_session=${context.wakeSessionId}`
            : wakeFlagLabel;
      const gitPart =
        (agent?.branch ?? branch) || (agent?.head ?? head)
          ? ` branch=${agent?.branch ?? branch ?? "detached"} head=${agent?.head ?? head ?? "unknown"}`
          : "";
      const extraLines: string[] = [];
      if (frame.claimRejected) {
        extraLines.push(
          `WARNING: ${frame.claimDetail || `orchestrator role is already claimed by ${context.orchestrator}; registered as worker — do not retry claiming orchestrator`}`,
        );
      } else if (!context.orchestrator) {
        extraLines.push(
          'Tip: no orchestrator is set for this repo; call bus_register({ role: "orchestrator" }) to claim it (first claim wins).',
        );
      }
      return text(
        [
          `registered (${statusLabel})`,
          `name=${context.name} harness=${context.harness} session=${context.sessionId ?? "unbound"}${wakePart}`,
          `checkout=${context.cwd}${gitPart}`,
          `role=${role} orchestrator=${context.orchestrator ?? "none"}`,
          ...extraLines,
          "Call bus_who to list every other live or registered session in this repository.",
        ].join("\n"),
      );
    },
  );
  mcp.registerTool(
    "bus_publish",
    {
      description:
        "Publish a coordination message on a Switchboard topic in this repo. Default topic is repo. When 'to' is an agent name or exact session id, the directed message is delivered to that recipient's default bus_inbox regardless of topic. Not authorization.",
      inputSchema: {
        topic: z.string().optional().describe("Topic name, default repo"),
        message: z.string().describe("Message text"),
        to: z
          .string()
          .optional()
          .describe("Agent name (e.g. muse, claude) or exact session id. Directed messages appear in the recipient's default bus_inbox regardless of topic."),
      },
    },
    async ({ topic, message, to }) => {
      const frame = await bus.request({
        type: "publish",
        topic: topic || "repo",
        body: message,
        to,
      });
      return text(frame.type === "published" ? publishedText(frame) : "published");
    },
  );

  mcp.registerTool(
    "bus_subscribe",
    {
      description:
        "Subscribe this session to a topic. The topic is live from now on in pushes and default bus_inbox; read older mail on that topic with bus_inbox and topic=<name>. Subscriptions persist for this session across reconnects.",
      inputSchema: { topic: z.string() },
    },
    async ({ topic }) => {
      const frame = await bus.request({ type: "subscribe", topics: [topic] });
      return text(frame.type === "ok" ? frame.detail : "subscribed");
    },
  );

  mcp.registerTool(
    "bus_unsubscribe",
    {
      description:
        "Stop receiving a custom topic in pushes and default bus_inbox. repo and presence cannot be removed.",
      inputSchema: { topic: z.string() },
    },
    async ({ topic }) => {
      const frame = await bus.request({ type: "unsubscribe", topics: [topic] });
      return text(frame.type === "ok" ? frame.detail : "unsubscribed");
    },
  );

  mcp.registerTool(
    "bus_inbox",
    {
      description:
        "Poll this session's inbox. Call it at the start of a turn and before you stop. One call reads every full page, so a later ask is not left behind a page of older mail. Each session has its own cursor, so one Grok reading mail does not hide it from another Grok. Dedupe by id. If the result says the inbox has more, call bus_inbox again.",
      inputSchema: {
        since: z.number().optional().describe("Return messages with seq greater than this"),
        topic: z.string().optional(),
      },
    },
    async ({ since, topic }) => {
      const messages: BusMessage[] = [];
      let more = false;
      let pendingAsk: BusMessage | null = null;
      for (let page = 0; page < 8; page++) {
        const frame = await bus.request({
          type: "inbox",
          since: page === 0 ? since : undefined,
          topic,
        });
        if (frame.type !== "inbox") return text("inbox unavailable");
        messages.push(...frame.messages);
        if (frame.pendingAsk !== undefined) pendingAsk = frame.pendingAsk ?? null;
        more = frame.more;
        if (!more) break;
      }
      if (
        !topic &&
        since === undefined &&
        pendingAsk &&
        !messages.some((m) => m.id === pendingAsk!.id)
      ) {
        messages.push(pendingAsk);
      }
      if (messages.length === 0) return text("inbox empty");
      const body = messages.map(formatInboxMessage).join("\n\n");
      return text(more ? `${body}\n\ninbox has more messages. Call bus_inbox again.` : body);
    },
  );

  mcp.registerTool(
    "bus_who",
    {
      description:
        "List every live session in this repo, plus registered agents that are offline. Several sessions may share one name. The orchestrator row is marked orchestrator. Includes session health, pane/wake warnings, and each agent's configured Ratio MCP header (ratio=<project>(<profile>)[<source>]; note: reflects the MCP config file header, not live OAuth token state).",
      inputSchema: {},
    },
    async () => {
      const frame = await bus.request({ type: "who" });
      if (frame.type !== "who") return text("who unavailable");
      if (frame.orchestrator !== undefined) {
        context.orchestrator = frame.orchestrator;
      }
      if (frame.agents.length === 0) return text("nobody registered");
      const orchHeader = `orchestrator=${frame.orchestrator || "none"}${!frame.orchestrator ? " (claim with bus_register({ role: 'orchestrator' }))" : ""}`;
      return text(
        [
          orchHeader,
          ...frame.agents.map((agent) => {
            const state = agent.online ? "online" : "offline";
            const wake = agent.wake ? "headless_wake=on" : "headless_wake=off";
            const session = `${agent.sessionId ? ` session=${agent.sessionId}` : ""}${agent.wakeSessionId && agent.wakeSessionId !== agent.sessionId ? ` wake_session=${agent.wakeSessionId}` : ""} connections=${agent.connectionCount ?? (agent.online ? 1 : 0)}`;
            const git = agent.branch || agent.head ? ` git=${agent.branch ?? "detached"}@${agent.head ?? "unknown"}` : "";
            const ratioStr = formatRatioBinding(agent.ratio);
            const ratio = ratioStr ? ` ${ratioStr}` : "";
            return `${agent.name} ${agent.harness} ${state} ${wake}${session}${git}${ratio} ${agent.role} ${agent.status} ${formatDiagnostics(agent.diagnostics)}`;
          }),
        ].join("\n"),
      );
    },
  );

  mcp.registerTool(
    "bus_ask",
    {
      description:
        "Ask one agent by shared name (reaches all live sessions of that harness) or by session id (reaches only that session). Wake and inject use the bound session id. Pass supersedes to replace and close an earlier open ask. The answer comes back through bus_reply.",
      inputSchema: {
        agent: z.string().describe("Agent name (e.g. muse, codex) or exact session id"),
        question: z.string(),
        topic: z.string().optional(),
        supersedes: z.string().optional().describe("Correlation id of an earlier ask that this ask replaces and closes"),
        ratio_project: z.string().optional().describe("Optional expected Ratio project id (e.g. 'p-serveone') that the target must match"),
      },
    },
    async ({ agent, question, topic, supersedes, ratio_project }) => {
      const frame = await bus.request({
        type: "ask",
        to: agent,
        body: question,
        topic,
        supersedes,
        ratioProject: ratio_project,
      });
      return text(frame.type === "published" ? publishedText(frame) : "asked");
    },
  );

  mcp.registerTool(
    "bus_reply",
    {
      description:
        "Reply to a bus_ask. Pass the correlation id from the ask. state defaults to done (closes the ask); pass state=progress or state=blocked to send an update while keeping the ask open.",
      inputSchema: {
        correlationId: z.string(),
        message: z.string(),
        state: z.enum(["done", "progress", "blocked"]).optional().describe("done (default, closes ask), progress (keeps ask open), or blocked (keeps ask open)"),
      },
    },
    async ({ correlationId, message, state }) => {
      const frame = await bus.request({ type: "reply", correlationId, body: message, state });
      return text(frame.type === "published" ? publishedText(frame) : "replied");
    },
  );

  mcp.registerTool(
    "bus_report",
    {
      description:
        "Send a result or a status change to the orchestrator only. Use this for finished work that was not a bus_ask. Answer a bus_ask with bus_reply instead. Coordination, not authorization.",
      inputSchema: { message: z.string().describe("What the orchestrator should know") },
    },
    async ({ message }) => {
      const frame = await bus.request({ type: "report", body: message });
      return text(frame.type === "published" ? publishedText(frame) : "reported");
    },
  );

  mcp.registerTool(
    "bus_wait",
    {
      description:
        "Wait for unread inbox messages (seq > your current inbox cursor) without consuming them. Already-read messages are never returned by bus_wait; to inspect already-read history, call bus_inbox({ since: 0 }). Defaults to your own session inbox; orchestrators may monitor another recipient by name or session id. Broadcasts also match. Timeout defaults to 30 seconds (1..600); if your MCP client enforces a 120s tool timeout (e.g. Claude Code), pass timeout_seconds <= 90 so bus_wait returns before the client backgrounds the tool call. Use bus_inbox after a wake to consume mail.",
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        to: z.string().regex(NAME_RE).or(z.literal("*")).optional(),
        timeout_seconds: z.number().int().min(1).max(600).default(30),
        interval_ms: z.number().int().min(1).max(60_000).default(1500),
        since_seq: z
          .number()
          .int()
          .min(0)
          .max(Number.MAX_SAFE_INTEGER)
          .optional()
          .describe("Additional lower-bound sequence number; only unread messages with seq > max(since_seq, your_inbox_cursor) match"),
        wake_existing: z.boolean().optional(),
        topic: z.string().regex(TOPIC_RE).optional(),
      },
    },
    async ({ to, timeout_seconds, interval_ms, since_seq, wake_existing, topic }, extra) => {
      const isOwnSessionTarget = Boolean(context.sessionId && to === context.sessionId);
      const rawRecipient = isOwnSessionTarget ? context.name : (to ?? context.name);
      const store = new Store(dbPath(context.home));
      try {
        const currentOrch = store.getOrchestrator(context.repo);
        const callerIsOrchestrator =
          role === "orchestrator" ||
          currentOrch === context.name ||
          (Boolean(context.sessionId) && currentOrch === context.sessionId);
        if (rawRecipient !== context.name && !isOwnSessionTarget && rawRecipient !== "*" && !callerIsOrchestrator) {
          return { ...text("Only the orchestrator can wait on another agent's inbox."), isError: true };
        }
        const bySession = rawRecipient !== "*" ? store.getAgentBySession(context.repo, rawRecipient) : undefined;
        const recipient = bySession ? bySession.name : rawRecipient;
        const ownSession =
          rawRecipient === context.name
            ? context.sessionId
            : bySession?.sessionId ?? (UUID_RE.test(rawRecipient) ? rawRecipient : undefined);
        const cursorKey =
          ownSession && !ownSession.startsWith("zellij:") ? `${recipient}:${ownSession}` : recipient;
        const storedRecipient =
          rawRecipient !== "*" ? (bySession ?? store.getAgent(context.repo, ownSession || recipient)) : undefined;
        const subscriptionKey = ownSession || storedRecipient?.sessionId || `name:${recipient}`;
        const isOrchestrator =
          currentOrch === recipient || (Boolean(ownSession) && currentOrch === ownSession);
        const result = await waitForMessages(store, {
          repo: context.repo, to: recipient, timeoutMs: timeout_seconds * 1000, intervalMs: interval_ms,
          sinceSeq: since_seq, wakeExisting: wake_existing, cursorKey, topic,
          sessionId: ownSession, subscriptionKey, isOrchestrator, signal: extra.signal,
        }, {
          subscribeWake: context.subscribeWake,
        });
        return { ...text(formatWaitResult(result)), structuredContent: { ...result } };
      } finally {
        store.close();
      }
    },
  );

  mcp.registerTool(
    "bus_status",
    {
      description: "Show workspace status, per-agent orchestration metrics, and the most recent unanswered asks with reply correlation IDs. Optionally set this agent's status (shown by bus_who). pending filters out session diagnostics and metrics; limit defaults to 50 (max 200).",
      inputSchema: {
        status: z.string().optional(),
        pending: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ status, pending, limit }) => {
      const frame = await bus.request({ type: "status", status, pending, limit });
      if (frame.type !== "ok" || !frame.pending_asks) return text("pending-ask tracking unavailable; restart the daemon after upgrading");
      const currentBuild = loadBuild();
      const boardStateText = pending ? "" : formatBoardState(frame.board_state ?? [], gitCheckoutInfo(context.cwd).head);
      return {
        ...text(`${pending ? "" : `${frame.detail}\n${formatBuild("daemon", frame.daemon)}\n${formatBuild("MCP", currentBuild)}${buildWarning(currentBuild, frame.daemon) ? `\nWARNING: ${buildWarning(currentBuild, frame.daemon)}` : ""}\n`}${formatPendingAsks(frame.pending_asks)}${pending ? "" : `\n${formatAgentMetrics(frame.agent_metrics ?? [])}`}${boardStateText ? `\n${boardStateText}` : ""}`),
        structuredContent: { ...(pending ? {} : { detail: frame.detail, daemon: frame.daemon ?? null, shim: currentBuild, agent_metrics: frame.agent_metrics ?? [], board_state: frame.board_state ?? [] }), pending_asks: frame.pending_asks },
      };
    },
  );

  mcp.registerTool(
    "bus_state",
    {
      description:
        "Read or write shared per-repo key-value state with compare-and-swap (rev / if_rev). Canonical coordination keys: 'contract' (active task summary, git head/branch, declared paths, ratio_project) and 'verdict:<agent>' (each reviewer/lens verdict, git head, lens, summary). Does not trigger automatic wakes.",
      inputSchema: {
        action: z.enum(["get", "set", "list", "delete"]),
        key: z.string().regex(STATE_KEY_RE).optional().describe("State key (required for get, set, delete; e.g. 'contract', 'verdict:grok', 'ratio:project')"),
        value: z.string().optional().describe("State value (required for set unless structured contract/verdict fields are passed)"),
        prefix: z.string().optional().describe("Optional key prefix filter for list (e.g. 'verdict:')"),
        if_rev: z.number().int().min(0).optional().describe("Compare-and-swap expected revision (0 for create-only, N to update/delete only if current rev == N)"),
        head: z.string().optional().describe("Optional git HEAD SHA for structured 'contract' or 'verdict:<agent>' entries (auto-detected from checkout if omitted when structured fields are used)"),
        paths: z.array(z.string()).optional().describe("Optional declared file/module paths for 'contract'"),
        ratio_project: z.string().optional().describe("Optional expected Ratio project id (e.g. 'p-serveone') for 'contract'"),
        verdict: z.enum(["pass", "fail", "blocked"]).optional().describe("Optional structured verdict status for 'verdict:<agent>'"),
        lens: z.string().optional().describe("Optional review lens name (e.g. 'correctness', 'security') for 'verdict:<agent>'"),
      },
    },
    async ({ action, key, value, prefix, if_rev, head, paths, ratio_project, verdict, lens }) => {
      let resolvedValue = value;
      if (
        action === "set" &&
        (head !== undefined ||
          paths !== undefined ||
          ratio_project !== undefined ||
          verdict !== undefined ||
          lens !== undefined)
      ) {
        const git = gitCheckoutInfo(context.cwd);
        const payload: Record<string, unknown> = {};
        if (value !== undefined) payload.summary = value;
        if (verdict !== undefined) payload.verdict = verdict;
        if (lens !== undefined) payload.lens = lens;
        if (paths !== undefined) payload.paths = paths;
        if (ratio_project !== undefined) payload.ratio_project = ratio_project;
        payload.head = head ?? git.head ?? "unknown";
        if (git.branch) payload.branch = git.branch;
        resolvedValue = JSON.stringify(payload);
      }
      const frame = await bus.request({
        type: "state",
        action,
        key,
        value: resolvedValue,
        prefix,
        ifRev: if_rev,
      });
      if (frame.type !== "state") return { ...text("state unavailable"), isError: true };
      if (frame.conflict) {
        return {
          ...text(frame.detail || "state revision conflict"),
          structuredContent: {
            action: frame.action,
            conflict: true,
            entry: frame.entry ?? null,
          },
          isError: true,
        };
      }
      if (frame.action === "list") {
        const entries = frame.entries ?? [];
        const body =
          entries.length === 0
            ? "state empty"
            : entries
                .map((e) => `${e.key} rev=${e.rev} updated_by=${e.updatedBy} ts=${e.ts}\n${e.value}`)
                .join("\n\n");
        return {
          ...text(body),
          structuredContent: { action: "list", entries },
        };
      }
      if (frame.action === "delete") {
        return {
          ...text(frame.deleted ? `deleted ${key}` : `not found ${key}`),
          structuredContent: { action: "delete", key, deleted: Boolean(frame.deleted) },
        };
      }
      if (!frame.entry) {
        return {
          ...text(`not found ${key}`),
          structuredContent: { action: frame.action, entry: null },
        };
      }
      const e = frame.entry;
      return {
        ...text(`${e.key} rev=${e.rev} updated_by=${e.updatedBy} ts=${e.ts}\n${e.value}`),
        structuredContent: { action: frame.action, entry: e },
      };
    },
  );

  mcp.registerTool(
    "bus_invite",
    {
      description:
        "Invite one or more agent harnesses (grok, muse, claude, codex, kimi, cursor, agy) onto this repository's Switchboard board. If an invited agent is already online in this repo, returns its live session without spawning a duplicate. In 'terminal' mode (default), opens a macOS Terminal tab in this repo's checkout and registers its tty:/dev/ttysNNN for instant injection. In 'headless' mode, registers wake=true so the next bus_ask runs a headless subscription CLI turn in this repo without opening a window.",
      inputSchema: {
        agents: z
          .array(z.string().min(1))
          .min(1)
          .describe("Agent or harness names to invite onto this repo board (e.g. ['grok', 'muse'])"),
        mode: z
          .enum(["terminal", "headless"])
          .optional()
          .describe("'terminal' opens an interactive Terminal.app tab bound to tty:/dev/ttysNNN; 'headless' registers wake=true for on-demand CLI turns"),
        orchestrator: z
          .string()
          .optional()
          .describe("Optional orchestrator name to set for this repo board"),
      },
    },
    async ({ agents, mode, orchestrator }) => {
      const frame = await bus.request({
        type: "invite",
        agents,
        mode,
        orchestrator,
      });
      if (frame.type !== "invited") return { ...text("invite unavailable"), isError: true };
      context.orchestrator = frame.orchestrator;
      role =
        frame.orchestrator === context.name ||
        (Boolean(context.sessionId) && frame.orchestrator === context.sessionId)
          ? "orchestrator"
          : "worker";
      bus.updateHello({ role });
      const lines = [
        `repo=${frame.repoKey} cwd=${frame.cwd} orchestrator=${frame.orchestrator ?? "none"}`,
        ...frame.invited.map(
          (item) =>
            `${item.name}\t${item.harness}\t${item.action}\twake=${item.wakeMode}${item.wakeSessionId ? ` wake_session=${item.wakeSessionId}` : ""}\t${item.detail}`,
        ),
      ];
      return {
        ...text(lines.join("\n")),
        structuredContent: {
          repo_key: frame.repoKey,
          cwd: frame.cwd,
          orchestrator: frame.orchestrator,
          invited: frame.invited,
        },
      };
    },
  );
}

function formatInboxMessage(message: BusMessage): string {
  const fromSessionTag =
    message.fromId && message.fromId !== message.fromName ? ` from_session=${message.fromId}` : "";
  const stateTag =
    (message.kind === "reply" || message.kind === "ask") && message.replyState
      ? ` state=${message.replyState}`
      : "";
  const supersedesTag =
    message.kind === "ask" && message.supersedes ? ` supersedes=${message.supersedes}` : "";
  const head = `[switchboard] ${message.fromName} on ${message.topic} id=${message.id}${fromSessionTag}${
    message.correlationId ? ` correlation=${message.correlationId}` : ""
  }${stateTag}${supersedesTag}`;
  const footer =
    message.kind === "ask" && message.correlationId && message.replyState !== "done"
      ? `\n[switchboard: REQUIRED — when finished, call bus_reply with correlationId="${message.correlationId}" to deliver your response to ${message.fromName}. Inline terminal output is not sent over the bus.]`
      : "";
  return `${head}\n${message.body}${footer}`;
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

function publishedText(frame: {
  id: string;
  seq: number;
  correlationId?: string | null;
  wake: { mode: string; detail: string };
}): string {
  const correlation = frame.correlationId ? ` correlation=${frame.correlationId}` : "";
  return `id=${frame.id} seq=${frame.seq}${correlation}\nwake=${frame.wake.mode}: ${frame.wake.detail}`;
}

export type { BusMessage };
