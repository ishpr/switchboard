import type { PendingAsk } from "./types.ts";

export function formatPendingAsks(asks: PendingAsk[]): string {
  if (asks.length === 0) return "pending_asks: none";
  return [
    `pending_asks (most recent ${asks.length}):`,
    ...asks.map((ask) => `id=${ask.id} correlation_id=${ask.correlation_id} seq=${ask.seq} from=${ask.from} to=${ask.to ?? "none"} topic=${ask.topic} age_seconds=${ask.age_seconds} preview=${JSON.stringify(ask.preview)}`),
  ].join("\n");
}
