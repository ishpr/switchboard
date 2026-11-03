/** Wire types shared by the daemon, the MCP shim, and the CLI. */

export const TOPIC_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/;
export const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/;
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

export type AgentRecord = {
  repo: string;
  name: string;
  harness: string;
  sessionId: string | null;
  cwd: string;
  wake: boolean;
  lastSeen: number;
  online: boolean;
  status: string;
  role: Role;
};

export type WakeMode = "push" | "inject" | "headless" | "skip";

export type ClientHello = {
  type: "hello";
  token: string;
  name: string;
  harness: string;
  repoKey: string;
  cwd: string;
  sessionId?: string;
  /** Persist sessionId for inject. A generated id is this connection only. */
  boundSession?: boolean;
  status?: string;
  wake?: boolean;
  /** Claim the orchestrator role. A different name cannot take it once one is set. */
  role?: Role;
};

export type ClientFrame =
  | ClientHello
  | { type: "publish"; topic: string; body: string; id?: string; to?: string }
  | { type: "subscribe"; topics: string[] }
  | { type: "unsubscribe"; topics: string[] }
  | { type: "inbox"; since?: number; topic?: string; limit?: number }
  | { type: "ack"; cursor: number }
  | { type: "who" }
  | { type: "ask"; to: string; body: string; topic?: string }
  | { type: "reply"; correlationId: string; body: string }
  | { type: "report"; body: string }
  | { type: "status"; status: string }
  | { type: "orchestrator"; name?: string }
  | { type: "register"; name: string; harness: string; cwd: string; sessionId?: string; wake: boolean }
  | { type: "heartbeat" };

export type WakeInfo = {
  mode: WakeMode;
  detail: string;
};

export type ServerFrame =
  | {
      type: "welcome";
      agentId: string;
      repoKey: string;
      cursor: number;
      role: Role;
      orchestrator: string | null;
    }
  | { type: "published"; id: string; seq: number; wake: WakeInfo; correlationId?: string | null }
  | { type: "ok"; detail: string }
  | { type: "message"; message: BusMessage }
  | { type: "inbox"; messages: BusMessage[]; cursor: number; more: boolean; pendingAsk?: BusMessage | null }
  | { type: "who"; agents: AgentRecord[] }
  | { type: "orchestrator"; orchestrator: string | null }
  | { type: "registered"; name: string }
  | { type: "error"; error: string };

export type WakeLaunch = {
  cmd: string;
  args: string[];
  cwd: string;
  stdin?: string;
  env?: Record<string, string>;
};
