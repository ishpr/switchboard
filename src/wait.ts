import { setTimeout as sleep } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import type { Store } from "./store.ts";
import { NAME_RE, TOPIC_RE } from "./types.ts";
import type { BusMessage } from "./types.ts";

export type WaitOptions = {
  repo: string;
  to: string;
  timeoutMs?: number;
  intervalMs?: number;
  sinceSeq?: number;
  wakeExisting?: boolean;
  cursorKey?: string;
  topic?: string;
  sessionId?: string | null;
  subscriptionKey?: string;
  isOrchestrator?: boolean;
  signal?: AbortSignal;
};

export type WaitSummary = {
  seq: number;
  from: string;
  to: string;
  topic: string;
  kind: BusMessage["kind"];
  correlation_id: string | null;
  preview: string;
};

export type WaitResult = {
  status: "MESSAGES" | "TIMEOUT";
  since_seq: number;
  messages: WaitSummary[];
};

type WaitClock = {
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
  onReady?: (baseline: number) => void;
  subscribeWake?: (wake: () => void) => () => void;
};

export async function waitForMessages(store: Store, options: WaitOptions, clock: WaitClock = {}): Promise<WaitResult> {
  const timeoutMs = options.timeoutMs ?? 240_000;
  const intervalMs = options.intervalMs ?? 1500;
  if (options.to !== "*" && !NAME_RE.test(options.to)) throw new Error("--to requires a valid agent name or '*'");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > Number.MAX_SAFE_INTEGER) {
    throw new Error("--timeout must be a finite non-negative number of seconds");
  }
  if (!Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 2_147_483_647) {
    throw new Error("--interval-ms must be an integer from 1 to 2147483647");
  }
  if (options.sinceSeq !== undefined && (!Number.isSafeInteger(options.sinceSeq) || options.sinceSeq < 0)) {
    throw new Error("--since-seq must be a non-negative safe integer");
  }
  if (options.topic !== undefined && !TOPIC_RE.test(options.topic)) throw new Error("invalid wait topic");
  const now = clock.now ?? (() => performance.now());
  options.signal?.throwIfAborted();
  const pause = clock.sleep ?? ((ms: number) => {
    if (!clock.subscribeWake) return sleep(ms, undefined, { signal: options.signal });
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        options.signal?.removeEventListener("abort", onAbort);
      };
      const onWake = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(options.signal?.reason ?? new Error("aborted"));
      };
      const unsubscribe = clock.subscribeWake!(onWake);
      const timer = setTimeout(onWake, ms);
      if (options.signal) {
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  });
  const deadline = now() + timeoutMs;
  const waitOpts = {
    subscriptionKey: options.subscriptionKey,
    isOrchestrator: options.isOrchestrator,
  };
  const baseline =
    options.sinceSeq ??
    (options.wakeExisting
      ? 0
      : store.latestUnreadSeq(options.repo, options.to, options.cursorKey, options.topic, options.sessionId, waitOpts));
  clock.onReady?.(baseline);
  while (true) {
    options.signal?.throwIfAborted();
    const messages = store.unreadForWait(
      options.repo,
      options.to,
      baseline,
      options.cursorKey,
      options.topic,
      options.sessionId,
      waitOpts,
    );
    if (messages.length) {
      return { status: "MESSAGES", since_seq: baseline, messages: messages.map((message) => ({
        seq: message.seq, from: message.fromName, to: message.to ?? "*", topic: message.topic,
        kind: message.kind, correlation_id: message.correlationId,
        preview: message.body.replace(/\s+/g, " ").trim().slice(0, 160),
      })) };
    }
    const remaining = deadline - now();
    if (remaining <= 0) return { status: "TIMEOUT", since_seq: baseline, messages: [] };
    await pause(Math.min(intervalMs, remaining));
  }
}

export function formatWaitResult(result: WaitResult): string {
  if (result.status === "TIMEOUT") return "TIMEOUT";
  return result.messages.map((message) =>
    `seq=${message.seq} from=${message.from} to=${message.to} topic=${message.topic} kind=${message.kind} correlation_id=${message.correlation_id ?? "none"} preview=${JSON.stringify(message.preview)}`,
  ).join("\n");
}
