import type { PendingAsk, AgentMetrics } from "./types.ts";

export function formatPendingAsks(asks: PendingAsk[]): string {
  if (asks.length === 0) return "pending_asks: none";
  return [
    `pending_asks (most recent ${asks.length}):`,
    ...asks.map(
      (ask) =>
        `id=${ask.id} correlation_id=${ask.correlation_id} seq=${ask.seq} from=${ask.from} to=${ask.to ?? "none"} topic=${ask.topic}${ask.last_reply_state ? ` state=${ask.last_reply_state}` : ""} age_seconds=${ask.age_seconds} preview=${JSON.stringify(ask.preview)}`,
    ),
  ].join("\n");
}

export function formatAgentMetrics(metrics: AgentMetrics[]): string {
  if (metrics.length === 0) return "agent_metrics: none";
  return [
    "agent_metrics:",
    ...metrics.map((row) => `agent=${row.agent} asks_received=${row.asks_received} replies_sent=${row.replies_sent} pending_asks_count=${row.pending_asks_count} avg_reply_latency_seconds=${row.avg_reply_latency_seconds ?? "none"} last_reply_at=${row.last_reply_at ?? "none"}`),
  ].join("\n");
}
