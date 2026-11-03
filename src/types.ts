/** Wire types shared by the daemon, the MCP shim, and the CLI. */

export const PROTOCOL_VERSION = 2;
export const TOPIC_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/;
export const NAME_RE = /^[a-zA-Z0-9%][a-zA-Z0-9._:%-]{0,63}$/;
export const BODY_MAX = 32 * 1024;
export const DEFAULT_PORT = 8787;
export const HEARTBEAT_MS = 10_000;
export const PRESENCE_TTL_MS = 30_000;
export const WAKE_COOLDOWN_MS = 3_000;

export type Kind = "pub" | "ask" | "reply";
export type Role = "orchestrator" | "worker";

export type BusMessage = {
  id: string;
  seq: number;
  repo: string;
  topic: string;
  fromId: string;
  fromName: string;
  body: string;
  ts: number;
  kind: Kind;
  correlationId: string | null;
  to: string | null;
};

export type SessionDiagnostics = {
  health: "online" | "offline" | "stale" | "dead_pane";
  wakeMode: WakeMode;
  warnings: string[];
};

export type BuildInfo = {
  version: string;
  protocol_version: number;
  commit_sha: string | null;
  dirty: boolean;
  built_at: string | null;
  source: "source" | "built";
};
export type RuntimeInfo = BuildInfo & { pid: number; started_at: number };

export type AgentRecord = {
  connectionCount?: number;
  connectionIds?: string[];
  wakeSessionId?: string | null;
  builds?: BuildInfo[];
  diagnostics?: SessionDiagnostics;
  repo: string;
  name: string;
  harness: string;
  sessionId: string | null;
  cwd: string;
  branch?: string | null;
  head?: string | null;
  wake: boolean;
  lastSeen: number;
  online: boolean;
  status: string;
  role: Role;
};

export type PendingAsk = {
  id: string;
  correlation_id: string;
  seq: number;
  from: string;
  to: string | null;
  topic: string;
  age_seconds: number;
  preview: string;
};

export type AgentMetrics = {
  agent: string;
  asks_received: number;
  replies_sent: number;
  pending_asks_count: number;
  avg_reply_latency_seconds: number | null;
  last_reply_at: number | null;
};

export type PrunedAgent = {
  repo: string;
  name: string;
  sessionId: string | null;
  reason: "dead_pane" | "stale";
};

export type WakeMode = "push" | "inject" | "headless" | "skip";

export type ClientHello = {
  build?: BuildInfo;
  type: "hello";
  token: string;
  name: string;
  harness: string;
  repoKey: string;
  cwd: string;
  branch?: string | null;
  head?: string | null;
  sessionId?: string;
  /** Optional live wake target (e.g. tty:/dev/ttysNNN) when sessionId is a harness UUID. */
  wakeSessionId?: string;
  /** Persist sessionId for inject. A generated id is this connection only. */
  boundSession?: boolean;
  /** True when the connection is held by a `switchboard wait` monitor rather than an MCP shim. */
  waitOnly?: boolean;
  status?: string;
  wake?: boolean;
  /** Claim the orchestrator role. A different name cannot take it once one is set. */
  role?: Role;
};

export type ClientFrame = (
  | ClientHello
  | { type: "publish"; topic: string; body: string; id?: string; to?: string }
  | { type: "subscribe"; topics: string[] }
  | { type: "unsubscribe"; topics: string[] }
  | { type: "inbox"; since?: number; topic?: string; limit?: number }
  | { type: "ack"; cursor: number }
  | { type: "who" }
  | { type: "doctor"; all?: boolean; prune?: boolean }
  | { type: "ask"; to: string; body: string; topic?: string }
  | { type: "reply"; correlationId: string; body: string }
  | { type: "report"; body: string }
  | { type: "status"; status?: string; pending?: boolean; limit?: number }
  | { type: "orchestrator"; name?: string }
  | {
      type: "register";
      name: string;
      harness: string;
      cwd: string;
      sessionId?: string;
      wakeSessionId?: string;
      branch?: string | null;
      head?: string | null;
      wake?: boolean;
    }
  | { type: "heartbeat" }
) & { reqId?: string };

export type WakeInfo = {
  mode: WakeMode;
  detail: string;
};

export type ServerFrame = (
  | {
      type: "welcome";
      daemon?: RuntimeInfo;
      agentId: string;
      repoKey: string;
      cursor: number;
      role: Role;
      orchestrator: string | null;
    }
  | { type: "published"; id: string; seq: number; wake: WakeInfo; correlationId?: string | null }
  | { type: "ok"; detail: string; pending_asks?: PendingAsk[]; agent_metrics?: AgentMetrics[]; daemon?: RuntimeInfo }
  | { type: "message"; message: BusMessage }
  | { type: "inbox"; messages: BusMessage[]; cursor: number; more: boolean; pendingAsk?: BusMessage | null }
  | { type: "who"; agents: AgentRecord[]; daemon?: RuntimeInfo }
  | { type: "doctor"; agents: AgentRecord[]; pruned: PrunedAgent[]; daemon?: RuntimeInfo }
  | { type: "orchestrator"; orchestrator: string | null }
  | { type: "registered"; name: string; agent?: AgentRecord; created?: boolean }
  | { type: "error"; error: string }
) & { reqId?: string };

export type WakeLaunch = {
  completion?: "spawn" | "exit";
  cmd: string;
  args: string[];
  cwd: string;
  stdin?: string;
  env?: Record<string, string>;
};
