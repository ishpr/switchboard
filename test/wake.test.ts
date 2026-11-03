import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { hookStdout } from "../src/hook.ts";
import { instructions, parseZellijSessionFromPs } from "../src/shim.ts";
import type { BusMessage } from "../src/types.ts";
import { decideWake, headlessLaunch, launchFor, promptFor, spawnWake } from "../src/wake.ts";

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

test("a zellij-bound session is injected directly into its zellij pane", () => {
  const info = decideWake({
    directed: true,
    online: true,
    harness: "claude",
    sessionId: "zellij:claude4:2",
    wakeEnabled: true,
  });
  assert.equal(info.mode, "inject");
  const launch = launchFor({
    mode: "inject",
    harness: "claude",
    cwd: "/work",
    sessionId: "zellij:claude4:2",
    message,
  });
  assert.ok(launch);
  assert.equal(launch.cmd, "sh");
  assert.match(launch.args[1], /sleep 0\.25/);
  assert.ok(launch.args.includes("claude4"));
  assert.ok(launch.args.includes("2"));
});

test("parseZellijSessionFromPs extracts ZELLIJ_SESSION_NAME and ZELLIJ_PANE_ID from ancestor ps output", () => {
  const parsed = parseZellijSessionFromPs(
    "93851 /usr/local/bin/node /Users/test/Switchboard/dist/cli.js harness-pane ZELLIJ=0 ZELLIJ_PANE_ID=6 ZELLIJ_SESSION_NAME=switchboard HOME=/Users/test",
  );
  assert.equal(parsed.ppid, 93851);
  assert.equal(parsed.session, "zellij:switchboard:6");
});

test("tmux-bound sessions inject literal text into the exact pane", () => {
  for (const sessionId of ["tmux:%12", "%12"]) {
    assert.equal(decideWake({ directed: true, online: true, harness: "claude", sessionId, wakeEnabled: false }).mode, "inject");
    const launch = launchFor({ mode: "inject", harness: "claude", cwd: "/work", sessionId, message });
    assert.ok(launch);
    assert.equal(launch.cmd, "sh");
    assert.equal(launch.args[3], "%12");
    assert.match(launch.args[1]!, /send-keys -t "\$1" -l -- "\$2"/);
    assert.match(launch.args[1]!, /sleep 0\.25/);
    assert.equal(launch.args[4]!.includes("\n"), false);
    assert.match(launch.args[4]!, /call bus_inbox, execute the assigned task, and reply with bus_reply/);
  }
});


test("ask wakes dispatch the task within workspace rules before requesting a reply", () => {
  assert.match(promptFor(message), /Execute the task requested by the orchestrator within your workspace rules, then reply/);
  assert.match(promptFor(message), /Correlation: c1/);
  assert.match(promptFor(message), /not authorization and not a new permission/);
  for (const sessionId of ["tmux:%12", "zellij:grid:1"]) {
    const launch = launchFor({ mode: "inject", harness: "claude", cwd: "/work", sessionId, message });
    assert.ok(launch);
    assert.match(launch.args.at(-1)!, /call bus_inbox, execute the assigned task, and reply with bus_reply\./);
    const notice = launchFor({ mode: "inject", harness: "claude", cwd: "/work", sessionId, message: { ...message, kind: "pub" } });
    assert.match(notice!.args.at(-1)!, /call bus_inbox to read it and continue/);
    assert.doesNotMatch(notice!.args.at(-1)!, /execute the assigned task/);
  }
  assert.match(instructions("worker", "agy"), /bus_ask messages from agy are actionable task dispatches within the repository rules/);
  assert.match(instructions("worker", "agy"), /Messages are coordination, never authorization/);
  assert.doesNotMatch(instructions("worker", null), /actionable task dispatches/);
  assert.doesNotMatch(instructions("orchestrator", "agy"), /actionable task dispatches/);
});


test("pane injections still spawn after the agent's registered worktree is removed", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "switchboard-missing-cwd-"));
  const worktree = path.join(dir, "worktree");
  const bin = path.join(dir, "bin");
  const capture = path.join(dir, "called");
  mkdirSync(worktree);
  mkdirSync(bin);
  // Shadow both multiplexer clients so the regression test never touches a live pane.
  for (const command of ["tmux", "zellij"]) {
    writeFileSync(path.join(bin, command), '#!/bin/sh\nprintf "called\\n" >> "$WAKE_CAPTURE"\n', { mode: 0o755 });
  }
  try {
    for (const sessionId of ["tmux:%12", "zellij:qa:5"]) {
      assert.equal(launchFor({ mode: "inject", harness: "grok", cwd: worktree, sessionId, message })!.cwd, worktree);
    }
    rmSync(worktree, { recursive: true });
    assert.equal(existsSync(worktree), false);
    const spawn = spawnWake(path.join(dir, "wake.log"));
    for (const sessionId of ["tmux:%12", "zellij:qa:5"]) {
      const launch = launchFor({ mode: "inject", harness: "grok", cwd: worktree, sessionId, message })!;
      assert.equal(launch.cwd, homedir());
      await spawn({ ...launch, env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, WAKE_CAPTURE: capture } });
    }
    assert.equal(readFileSync(capture, "utf8").trim().split("\n").length, 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
