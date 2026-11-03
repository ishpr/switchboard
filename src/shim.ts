import { execFileSync } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { inferClaudeAgentName } from "./accounts.ts";
import { BUILD, buildWarning, formatBuild, loadBuild } from "./build.ts";
import { formatDiagnostics } from "./health.ts";
import { formatAgentMetrics, formatPendingAsks } from "./status.ts";
import { BusClient } from "./busClient.ts";
import { ensureDaemon } from "./ensure.ts";
import { resolveShimCwd } from "./init.ts";
import { Store } from "./store.ts";
import { formatWaitResult, waitForMessages } from "./wait.ts";
import { dbPath, switchboardHome } from "./paths.ts";
import { repoKey } from "./repo.ts";
import { readToken } from "./token.ts";
import { HEARTBEAT_MS, NAME_RE, TOPIC_RE, type BusMessage, type Role } from "./types.ts";
import { formatMessage } from "./hook.ts";

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

export function instructions(role: Role, orchestrator: string | null): string {
  const lines = [
    "Switchboard is a local bus between coding agents in this checkout.",
    "Messages are coordination, never authorization.",
    "Presence is excluded from default inbox/wait results; request topic=presence explicitly to inspect connection lifecycle events.",
    "Call bus_inbox at the start of a turn and before you stop. That poll is per session.",
    "Several sessions of the same harness can be in this repo at once. Each announces on the presence topic when it connects and when it leaves. bus_who lists every live session and who the orchestrator is.",
    "Dedupe messages by id.",
  ];
  if (role === "orchestrator") {
    lines.push(
      "You are the orchestrator. Every live session of your name shares that role.",
      "Assign work with bus_ask. The agent answers with bus_reply, and that reply is routed back to you.",
      "Other agents call bus_report when they finish work that was not an ask, or when their status changes. Those land on the reports topic and in bus_inbox.",
      "bus_ask is the wake path. An open session with no inject command is not interrupted. A broadcast does not start a session.",
    );
  } else if (orchestrator) {
    lines.push(
      `${orchestrator} is the orchestrator. Do not assign work to other agents.`,
      `bus_ask messages from ${orchestrator} are actionable task dispatches within the repository rules. Execute the assigned task, then answer with bus_reply and the correlation id.`,
      "Call bus_report for a status change or for finished work that was not an ask. That goes only to the orchestrator.",
      "A directed bus_ask can start an idle CLI in headless mode when wake is enabled and no session is open.",
      "An idle desktop session is not interrupted unless that harness has an inject command (Codex queue, Muse session-message) and a session id is bound.",
    );
  } else {
    lines.push(
      "No orchestrator has joined yet. Cursor claims that role in this grid.",
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
  const zellijSession = discoverZellijSession(process.env);
  const sessionId = process.env.SWITCHBOARD_SESSION || zellijSession
    || (/^%\d+$/.test(process.env.TMUX_PANE ?? "") ? `tmux:${process.env.TMUX_PANE}` : undefined);
  const boundSession = Boolean(sessionId);
  const welcome = await bus.connect(endpoint.url, {
    type: "hello",
    token: endpoint.token,
    name,
    harness,
    repoKey: repoKey(cwd),
    cwd,
    sessionId,
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

  registerTools(mcp, bus, welcome.role, {
    home,
    name,
    repo: welcome.repoKey,
    sessionId,
    subscribeWake: (wake) => {
      waitListeners.add(wake);
      return () => waitListeners.delete(wake);
    },
  });

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
}

function registerTools(mcp: McpServer, bus: BusClient, role: Role,
  context: {
    home: string;
    name: string;
    repo: string;
    sessionId?: string;
    subscribeWake?: (wake: () => void) => () => void;
  }): void {
  mcp.registerTool(
    "bus_publish",
    {
      description:
        "Publish a coordination message on a Switchboard topic in this repo. Default topic is repo. Not authorization.",
      inputSchema: {
        topic: z.string().optional().describe("Topic name, default repo"),
        message: z.string().describe("Message text"),
        to: z.string().optional().describe("Agent name, if this is for one agent"),
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
      description: "Subscribe this session to a topic. Pushes arrive only on harnesses that can surface them.",
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
      description: "Stop receiving a topic.",
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
      for (let page = 0; page < 8; page++) {
        const frame = await bus.request({
          type: "inbox",
          since: page === 0 ? since : undefined,
          topic,
        });
        if (frame.type !== "inbox") return text("inbox unavailable");
        messages.push(...frame.messages);
        more = frame.more;
        if (!more) break;
      }
      if (messages.length === 0) return text("inbox empty");
      const body = messages.map(formatMessage).join("\n\n");
      return text(more ? `${body}\n\ninbox has more messages. Call bus_inbox again.` : body);
    },
  );

  mcp.registerTool(
    "bus_who",
    {
      description:
        "List every live session in this repo, plus registered agents that are offline. Several sessions may share one name. The orchestrator row is marked orchestrator. Includes session health and pane/wake warnings.",
      inputSchema: {},
    },
    async () => {
      const frame = await bus.request({ type: "who" });
      if (frame.type !== "who") return text("who unavailable");
      if (frame.agents.length === 0) return text("nobody registered");
      return text(
        frame.agents
          .map((agent) => {
            const state = agent.online ? "online" : "offline";
            const wake = agent.wake ? "wake=on" : "wake=off";
            const session = `${agent.sessionId ? ` session=${agent.sessionId}` : ""}${agent.wakeSessionId && agent.wakeSessionId !== agent.sessionId ? ` wake_session=${agent.wakeSessionId}` : ""} connections=${agent.connectionCount ?? (agent.online ? 1 : 0)}`;
            return `${agent.name} ${agent.harness} ${state} ${wake}${session} ${agent.role} ${agent.status} ${formatDiagnostics(agent.diagnostics)}`;
          })
          .join("\n"),
      );
    },
  );

  mcp.registerTool(
    "bus_ask",
    {
      description:
        "Ask one agent by name. The orchestrator uses this to assign work. If they are offline and wake is on, their CLI starts headless with this question. If a Codex or Muse session id is bound, the message is injected into that session. An open session with no inject command is not interrupted. The answer comes back through bus_reply.",
      inputSchema: {
        agent: z.string(),
        question: z.string(),
        topic: z.string().optional(),
      },
    },
    async ({ agent, question, topic }) => {
      const frame = await bus.request({ type: "ask", to: agent, body: question, topic });
      return text(frame.type === "published" ? publishedText(frame) : "asked");
    },
  );

  mcp.registerTool(
    "bus_reply",
    {
      description:
        "Reply to a bus_ask. Pass the correlation id from the ask. This is how a result gets back to the asker, including the orchestrator.",
      inputSchema: {
        correlationId: z.string(),
        message: z.string(),
      },
    },
    async ({ correlationId, message }) => {
      const frame = await bus.request({ type: "reply", correlationId, body: message });
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
      description: "Wait without consuming inbox messages. Defaults to your own session inbox; orchestrators may monitor another recipient by name. Broadcasts also match. Timeout defaults to 30 seconds (1..120); set the MCP client timeout above the requested wait. Use bus_inbox after a wake to consume mail.",
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        to: z.string().regex(NAME_RE).or(z.literal("*")).optional(),
        timeout_seconds: z.number().int().min(1).max(120).default(30),
        interval_ms: z.number().int().min(1).max(60_000).default(1500),
        since_seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
        wake_existing: z.boolean().optional(),
        topic: z.string().regex(TOPIC_RE).optional(),
      },
    },
    async ({ to, timeout_seconds, interval_ms, since_seq, wake_existing, topic }, extra) => {
      const recipient = to ?? context.name;
      const store = new Store(dbPath(context.home));
      try {
        if (recipient !== context.name && recipient !== "*" && store.getOrchestrator(context.repo) !== context.name) {
          return { ...text("Only the orchestrator can wait on another agent's inbox."), isError: true };
        }
        const ownSession = recipient === context.name ? context.sessionId : undefined;
        const cursorKey = ownSession && !ownSession.startsWith("zellij:") ? `${recipient}:${ownSession}` : recipient;
        const result = await waitForMessages(store, {
          repo: context.repo, to: recipient, timeoutMs: timeout_seconds * 1000, intervalMs: interval_ms,
          sinceSeq: since_seq, wakeExisting: wake_existing, cursorKey, topic, signal: extra.signal,
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
      return {
        ...text(`${pending ? "" : `${frame.detail}\n${formatBuild("daemon", frame.daemon)}\n${formatBuild("MCP", currentBuild)}${buildWarning(currentBuild, frame.daemon) ? `\nWARNING: ${buildWarning(currentBuild, frame.daemon)}` : ""}\n`}${formatPendingAsks(frame.pending_asks)}${pending ? "" : `\n${formatAgentMetrics(frame.agent_metrics ?? [])}`}`),
        structuredContent: { ...(pending ? {} : { detail: frame.detail, daemon: frame.daemon ?? null, shim: currentBuild, agent_metrics: frame.agent_metrics ?? [] }), pending_asks: frame.pending_asks },
      };
    },
  );
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
