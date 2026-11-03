import type { BusMessage } from "./types.ts";

/** Hooks cannot wake an idle agent. They only attach mail to a turn that is already running. */
export function hookStdout(harness: string, event: string, messages: BusMessage[]): string {
  if (messages.length === 0) return "";
  const text = messages.map(formatMessage).join("\n\n");
  if ((harness === "claude" || harness === "codex") && event === "UserPromptSubmit") {
    return `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: text,
      },
    })}\n`;
  }
  if (harness === "grok" && event === "Stop") {
    return `${JSON.stringify({
      decision: "block",
      reason: "Switchboard has a message from another agent.",
      hookSpecificOutput: {
        hookEventName: "Stop",
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
  return `${head}\n${message.body}`;
}
