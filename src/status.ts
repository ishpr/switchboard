import type { PendingAsk, AgentMetrics, StateEntry } from "./types.ts";

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

export function extractStateHead(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed && typeof parsed.head === "string" && parsed.head.trim()) {
      return parsed.head.trim();
    }
  } catch {
    // Fall back to token regex
  }
  const m = /(?:^|\s)head=([0-9a-f]{7,40})(?:\s|$)/i.exec(value);
  return m?.[1] ?? null;
}

export function extractStateRatioProject(entries: StateEntry[]): string | null {
  const direct = entries.find((e) => e.key === "ratio:project");
  if (direct?.value?.trim()) return direct.value.trim();
  const contract = entries.find((e) => e.key === "contract");
  if (!contract?.value) return null;
  try {
    const parsed = JSON.parse(contract.value) as Record<string, unknown>;
    const proj = parsed?.ratio_project ?? parsed?.ratioProject;
    if (typeof proj === "string" && proj.trim()) return proj.trim();
  } catch {
    const m = /(?:^|\s)ratio_project=([^\s,]+)/.exec(contract.value);
    if (m?.[1]) return m[1];
  }
  return null;
}

export function formatBoardState(entries: StateEntry[], currentHead?: string | null): string {
  if (!entries || entries.length === 0) return "";
  const contractEntry = entries.find((e) => e.key === "contract");
  const expectedHead = (contractEntry ? extractStateHead(contractEntry.value) : null) || currentHead || null;
  const lines = ["board_state:"];
  for (const entry of entries) {
    let staleNote = "";
    if (
      (entry.key.startsWith("verdict:") || entry.key.startsWith("verdict/")) &&
      expectedHead
    ) {
      const verdictHead = extractStateHead(entry.value);
      if (verdictHead && verdictHead !== expectedHead && !expectedHead.startsWith(verdictHead) && !verdictHead.startsWith(expectedHead)) {
        staleNote = ` WARNING: stale verdict head (${verdictHead} != ${expectedHead})`;
      }
    }
    lines.push(
      `${entry.key} rev=${entry.rev} updated_by=${entry.updatedBy}${staleNote}: ${entry.value}`,
    );
  }
  return lines.join("\n");
}
