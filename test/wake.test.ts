import assert from "node:assert/strict";
import test from "node:test";
import { hookStdout } from "../src/hook.ts";
import type { BusMessage } from "../src/types.ts";
import { decideWake, headlessLaunch, launchFor } from "../src/wake.ts";

const message: BusMessage = {
  id: "m1",
  seq: 1,
  repo: "abc",
  topic: "dm",
  fromId: "a",
  fromName: "claude",
  body: "look at the test",
  ts: 1,
  kind: "ask",
  correlationId: "c1",
  to: "codex",
};

test("a broadcast does not wake anyone", () => {
  const info = decideWake({
    directed: false,
    online: false,
    harness: "codex",
    sessionId: "thread-1",
    wakeEnabled: true,
  });
  assert.equal(info.mode, "skip");
});

test("a bound Codex session is injected even while that session is open", () => {
  const info = decideWake({
    directed: true,
    online: true,
    harness: "codex",
    sessionId: "thread-1",
    wakeEnabled: false,
  });
  assert.equal(info.mode, "inject");
  const launch = launchFor({
    mode: "inject",
    harness: "codex",
    cwd: "/work",
    sessionId: "thread-1",
    message,
  });
  assert.ok(launch);
  assert.deepEqual(launch.args.slice(0, 4), ["queue", "--thread", "thread-1", "--message"]);
  assert.ok(launch.args.includes("--resume"));
});

test("an open session with no inject command is not given a second process", () => {
  const info = decideWake({
    directed: true,
    online: true,
    harness: "grok",
    sessionId: null,
    wakeEnabled: true,
  });
  assert.equal(info.mode, "push");
  assert.equal(launchFor({ mode: "push", harness: "grok", cwd: "/work", sessionId: null, message }), null);
});

test("an offline agent with wake on gets a headless CLI", () => {
  const info = decideWake({
    directed: true,
    online: false,
    harness: "claude",
    sessionId: null,
    wakeEnabled: true,
  });
  assert.equal(info.mode, "headless");
  const launch = headlessLaunch("claude", "/work", null, "hello");
  assert.ok(launch);
  assert.equal(launch.cmd, "claude");
  assert.deepEqual(launch.args, ["-p", "hello"]);
  assert.equal(headlessLaunch("other", "/work", null, "hello"), null);
});

test("offline without wake stays in the log", () => {
  const info = decideWake({
    directed: true,
    online: false,
    harness: "kimi",
    sessionId: null,
    wakeEnabled: false,
  });
  assert.equal(info.mode, "skip");
});

test("hook stdout is empty when there is no mail", () => {
  assert.equal(hookStdout("grok", "Stop", []), "");
});

test("hook stdout matches the harness that can actually attach context", () => {
  const claude = JSON.parse(hookStdout("claude", "UserPromptSubmit", [message]));
  assert.equal(claude.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(claude.hookSpecificOutput.additionalContext, /look at the test/);

  const claudePost = JSON.parse(hookStdout("claude", "PostToolUse", [message]));
  assert.equal(claudePost.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(claudePost.hookSpecificOutput.additionalContext, /look at the test/);

  const grok = JSON.parse(hookStdout("grok", "Stop", [message]));
  assert.equal(grok.decision, "block");
  assert.match(grok.hookSpecificOutput.additionalContext, /correlation=c1/);

  const cursor = JSON.parse(hookStdout("cursor", "postToolUse", [message]));
  assert.match(cursor.additional_context, /look at the test/);

  assert.equal(hookStdout("kimi", "UserPromptSubmit", [message]), "");
});
