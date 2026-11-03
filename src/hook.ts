import type { BusMessage } from "./types.ts";

/**
 * When Switchboard wakes an interactive pane, it injects a prompt starting with `[switchboard]`
 * instructing the agent to call `bus_inbox`. Skip consuming the inbox in `UserPromptSubmit`
 * on that wake prompt so the agent's explicit `bus_inbox` tool call receives the message.
 */
export function shouldSkipHookForPrompt(
  event: string,
  stdinJson: Record<string, unknown> | null,
): boolean {
  if (event === "Stop" && stdinJson && stdinJson.stop_hook_active === true) {
    return true;
  }
  if (event !== "UserPromptSubmit" || !stdinJson) return false;
  const prompt = typeof stdinJson.prompt === "string" ? stdinJson.prompt.trimStart() : "";
  return prompt.startsWith("[switchboard]");
}

export function supportsHookOutput(harness: string, event: string): boolean {
  if (event === "Stop") return ["claude", "codex", "grok"].includes(harness);
  if (["claude", "codex"].includes(harness)) return ["UserPromptSubmit", "SessionStart", "PostToolUse"].includes(event);
  return harness === "cursor" && ["postToolUse", "PostToolUse"].includes(event);
}

/** Hooks cannot wake an idle agent. They attach mail to a running turn or block Stop when a reply is owed. */
export function hookStdout(
  harness: string,
  event: string,
  messages: BusMessage[],
  pendingAsk: BusMessage | null = null,
  stopHookActive = false,
): string {
  if (!supportsHookOutput(harness, event)) return "";
  if (event === "Stop") {
    if (stopHookActive) return "";
    if (messages.length > 0 && (harness === "claude" || harness === "codex" || harness === "grok")) {
      const text = messages.map(formatMessage).join("\n\n");
      return `${JSON.stringify({
        decision: "block",
        reason: `Switchboard has unread message(s) from another agent:\n\n${text}`,
        hookSpecificOutput: {
          hookEventName: "Stop",
          additionalContext: text,
        },
      })}\n`;
    }
    if (
      pendingAsk &&
      pendingAsk.correlationId &&
      (harness === "claude" || harness === "codex" || harness === "grok")
    ) {
      const reason = `[switchboard] You finished your turn without replying to bus_ask from ${pendingAsk.fromName} (correlationId="${pendingAsk.correlationId}"). Inline terminal output is NOT delivered over Switchboard. Call bus_reply with correlationId="${pendingAsk.correlationId}" now to send your response.`;
      return `${JSON.stringify({
        decision: "block",
        reason,
        hookSpecificOutput: {
          hookEventName: "Stop",
          additionalContext: reason,
        },
      })}\n`;
    }
    return "";
  }

  if (messages.length === 0) return "";
  const text = messages.map(formatMessage).join("\n\n");
  if (
    (harness === "claude" || harness === "codex") &&
    (event === "UserPromptSubmit" || event === "SessionStart" || event === "PostToolUse")
  ) {
    return `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: text,
      },
    })}\n`;
  }
  if (harness === "cursor" && (event === "postToolUse" || event === "PostToolUse")) {
    return `${JSON.stringify({ additional_context: text })}\n`;
  }
  return "";
}

export function formatMessage(message: BusMessage): string {
  const head = `[switchboard] ${message.fromName} on ${message.topic} id=${message.id}${
    message.correlationId ? ` correlation=${message.correlationId}` : ""
  }`;
  const footer =
    message.kind === "ask" && message.correlationId
      ? `\n[switchboard: REQUIRED — when finished, call bus_reply with correlationId="${message.correlationId}" to deliver your response to ${message.fromName}. Inline terminal output is not sent over the bus.]`
      : "";
  return `${head}\n${message.body}${footer}`;
}
