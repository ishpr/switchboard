import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { hookStdout, shouldSkipHookForPrompt } from "../src/hook.ts";
import {
  discoverCodexThread,
  discoverGrokSession,
  discoverHarnessSession,
  instructions,
  missingSessionSource,
  parseTerminalTtyFromPs,
  parseZellijSessionFromPs,
} from "../src/shim.ts";
import { DatabaseSync } from "node:sqlite";
import type { BusMessage } from "../src/types.ts";
import { decideWake, headlessLaunch, isCodexTurnInProgress, launchFor, promptFor, spawnWake } from "../src/wake.ts";

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

test("a bound Codex session with a valid UUID is injected even while that session is open, and non-UUIDs are rejected", () => {
  const validUuid = "01a175cd-251c-7571-abb3-21ea77b5d73d";
  const info = decideWake({
    directed: true,
    online: true,
    harness: "codex",
    sessionId: validUuid,
    wakeEnabled: false,
  });
  assert.equal(info.mode, "inject");
  const launch = launchFor({
    mode: "inject",
    harness: "codex",
    cwd: "/work",
    sessionId: validUuid,
    message,
  });
  assert.ok(launch);
  assert.deepEqual(launch.args.slice(0, 4), ["queue", "--thread", validUuid, "--message"]);
  assert.ok(launch.args.includes("--resume"));

  // A random non-UUID string must not be passed to codex queue --thread
  assert.equal(
    decideWake({
      directed: true,
      online: true,
      harness: "codex",
      sessionId: "thread-1",
      wakeEnabled: false,
    }).mode,
    "push",
  );
  assert.equal(
    launchFor({
      mode: "inject",
      harness: "codex",
      cwd: "/work",
      sessionId: "thread-1",
      message,
    }),
    null,
  );
});

test("a plain Muse UUID session is not treated as injectable unless bound to a pane or explicitly enabled", () => {
  const uuid = "01a1957b-9e69-7b90-aa4b-d1f30c47dc47";
  assert.equal(
    decideWake({ directed: true, online: true, harness: "muse", sessionId: uuid, wakeEnabled: false }).mode,
    "push",
  );
  assert.equal(
    decideWake({ directed: true, online: false, harness: "muse", sessionId: uuid, wakeEnabled: false }).mode,
    "skip",
  );
  assert.equal(
    decideWake({ directed: true, online: false, harness: "muse", sessionId: uuid, wakeEnabled: true }).mode,
    "headless",
  );
  assert.equal(
    launchFor({ mode: "inject", harness: "muse", cwd: "/work", sessionId: uuid, message }),
    null,
  );
  assert.equal(
    decideWake({ directed: true, online: true, harness: "muse", sessionId: "zellij:switchboard:5", wakeEnabled: false }).mode,
    "inject",
  );
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

  const codexStop = JSON.parse(hookStdout("codex", "Stop", [message]));
  assert.equal(codexStop.decision, "block");
  assert.match(codexStop.reason, /correlation=c1/);
  assert.equal(codexStop.hookSpecificOutput, undefined);

  const codexPost = JSON.parse(hookStdout("codex", "PostToolUse", [message]));
  assert.equal(codexPost.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(codexPost.hookSpecificOutput.additionalContext, /look at the test/);

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
  assert.match(promptFor(message), /^\[switchboard\] Switchboard message\./);
  assert.equal(shouldSkipHookForPrompt("UserPromptSubmit", { prompt: promptFor(message) }), true);
  assert.match(promptFor(message), /Execute the task requested by the orchestrator within your workspace rules, then reply/);
  assert.match(promptFor(message), /Correlation: c1/);
  assert.match(promptFor(message), /not authorization and not a new permission/);
  const nonAskPrompt = promptFor({ ...message, kind: "reply" });
  assert.match(nonAskPrompt, /Do not send a pure acknowledgment message/);
  assert.doesNotMatch(nonAskPrompt, /acknowledge it with bus_publish/);
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

test("recorded Terminal.app tty injects via osascript do script, and offline Muse resumes known session UUID", () => {
  const museUuid = "01a1957b-b088-76e1-b08b-ad1ac5ed8594";
  const parsed = parseTerminalTtyFromPs(
    "2536 ttys007 /Users/test/.local/bin/muse-bin resume 01a1957b TERM_PROGRAM=Apple_Terminal __CFBundleIdentifier=com.apple.Terminal",
  );
  assert.equal(parsed.ppid, 2536);
  assert.equal(parsed.tty, "tty:/dev/ttys007");
  assert.equal(parsed.appleTerminal, true);

  assert.equal(
    decideWake({ directed: true, online: true, harness: "muse", sessionId: "tty:/dev/ttys007", wakeEnabled: false }).mode,
    "inject",
  );
  const ttyLaunch = launchFor({
    mode: "inject",
    harness: "muse",
    cwd: "/work",
    sessionId: "tty:/dev/ttys007",
    message,
  });
  assert.ok(ttyLaunch);
  assert.equal(ttyLaunch.cmd, "osascript");
  assert.ok(ttyLaunch.args.includes("/dev/ttys007"));
  assert.match(ttyLaunch.args[1]!, /tell application "Terminal"/);

  // Offline Muse with a known UUID resumes that session via muse exec --session-id
  const resumeLaunch = headlessLaunch("muse", "/work", museUuid, "hello");
  assert.deepEqual(resumeLaunch, {
    cmd: "muse",
    args: ["exec", "--session-id", museUuid, "hello"],
    cwd: "/work",
  });
  // Offline Muse without a UUID starts fresh
  assert.deepEqual(headlessLaunch("muse", "/work", null, "hello"), {
    cmd: "muse",
    args: ["exec", "hello"],
    cwd: "/work",
  });
});

test("discoverHarnessSession reads MUSE_SESSION_ID, CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID, and ~/.codex/state_5.sqlite when cwd is a real repo", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sb-codex-sqlite-"));
  const repoDir = path.join(dir, "repo");
  const otherDir = path.join(dir, "other");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(otherDir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "state_5.sqlite"));
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      thread_source TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
  `);
  const oldUserThread = "01a10000-0000-7000-8000-000000000001";
  const newestUserThread = "01a175cd-251c-7571-abb3-21ea77b5d73d";
  const newerSubagentThread = "01a19999-9999-7999-8999-999999999999";
  const otherRepoThread = "01a18888-8888-7888-8888-888888888888";
  db.prepare("INSERT INTO threads (id, cwd, thread_source, archived, updated_at) VALUES (?, ?, ?, ?, ?)").run(
    oldUserThread,
    repoDir,
    "user",
    0,
    100,
  );
  db.prepare("INSERT INTO threads (id, cwd, thread_source, archived, updated_at) VALUES (?, ?, ?, ?, ?)").run(
    newestUserThread,
    repoDir,
    "user",
    0,
    200,
  );
  db.prepare("INSERT INTO threads (id, cwd, thread_source, archived, updated_at) VALUES (?, ?, ?, ?, ?)").run(
    newerSubagentThread,
    repoDir,
    "subagent",
    0,
    300,
  );
  db.prepare("INSERT INTO threads (id, cwd, thread_source, archived, updated_at) VALUES (?, ?, ?, ?, ?)").run(
    otherRepoThread,
    otherDir,
    "user",
    0,
    400,
  );
  db.close();

  try {
    // Picks newest thread_source='user' for repoDir, ignoring newer subagent and other repos
    assert.equal(discoverCodexThread(repoDir, dir), newestUserThread);
    // A shim started at "/" must NEVER take the newest thread on the machine
    assert.equal(discoverCodexThread("/", dir), undefined);
    assert.equal(
      discoverHarnessSession({ cwd: "/", harness: "codex", env: {}, codexHome: dir }).sessionId,
      undefined,
    );
    assert.equal(
      discoverHarnessSession({ cwd: repoDir, harness: "codex", env: {}, codexHome: dir }).sessionId,
      newestUserThread,
    );
    assert.equal(
      discoverHarnessSession({
        cwd: repoDir,
        harness: "muse",
        env: { MUSE_SESSION_ID: "01a1957b-b088-76e1-b08b-ad1ac5ed8594" },
      }).sessionId,
      "01a1957b-b088-76e1-b08b-ad1ac5ed8594",
    );
    assert.equal(
      discoverHarnessSession({
        cwd: repoDir,
        harness: "claude",
        env: { CLAUDE_CODE_SESSION_ID: "01a11111-2222-7333-8444-555555555555" },
      }).sessionId,
      "01a11111-2222-7333-8444-555555555555",
    );
    assert.match(missingSessionSource("muse", repoDir), /MUSE_SESSION_ID/);
    assert.match(missingSessionSource("claude", repoDir), /CLAUDE_CODE_SESSION_ID/);
    assert.match(missingSessionSource("codex", repoDir), /CODEX_THREAD_ID.*state_5\.sqlite/);
    assert.match(missingSessionSource("grok", repoDir), /GROK_SESSION_ID.*active_sessions\.json/);
    assert.match(missingSessionSource("codex", "/"), /cwd="\/"/);

    const grokUuid = "01a19edf-a7b1-7720-b9fb-77e45edc7b47";
    const otherGrokUuid = "01a19fbd-4072-75d0-8058-d2f4627dffb3";
    writeFileSync(
      path.join(dir, "active_sessions.json"),
      JSON.stringify([
        { session_id: grokUuid, pid: 12345, cwd: repoDir, opened_at: "2026-11-03T00:47:00Z" },
        { session_id: otherGrokUuid, pid: 67890, cwd: otherDir, opened_at: "2026-11-03T04:49:00Z" },
      ]),
    );
    assert.equal(discoverGrokSession(repoDir, dir), grokUuid);
    assert.equal(discoverGrokSession("/", dir), undefined);
    assert.equal(
      discoverHarnessSession({ cwd: repoDir, harness: "grok", env: {}, grokHome: dir }).sessionId,
      grokUuid,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isCodexTurnInProgress reads latest rollout_ordinal status from ~/.codex/thread_history_1.sqlite", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sb-codex-turn-"));
  const codexDir = path.join(dir, ".codex");
  mkdirSync(codexDir, { recursive: true });
  const dbPath = path.join(codexDir, "thread_history_1.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE thread_turns (
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      rollout_ordinal INTEGER NOT NULL,
      status TEXT NOT NULL
    );
  `);
  const threadId = "01a175cd-251c-7571-abb3-21ea77b5d73d";
  db.prepare("INSERT INTO thread_turns (thread_id, turn_id, rollout_ordinal, status) VALUES (?, ?, ?, ?)").run(
    threadId,
    "turn-1",
    10,
    "completed",
  );
  db.prepare("INSERT INTO thread_turns (thread_id, turn_id, rollout_ordinal, status) VALUES (?, ?, ?, ?)").run(
    threadId,
    "turn-2",
    20,
    "inProgress",
  );
  db.close();

  try {
    assert.equal(isCodexTurnInProgress(threadId, codexDir), true);
    assert.equal(isCodexTurnInProgress("01a175cd-0000-7000-8000-000000000000", codexDir), false);
    assert.equal(isCodexTurnInProgress("not-a-uuid", codexDir), false);

    const db2 = new DatabaseSync(dbPath);
    db2.prepare("INSERT INTO thread_turns (thread_id, turn_id, rollout_ordinal, status) VALUES (?, ?, ?, ?)").run(
      threadId,
      "turn-3",
      30,
      "completed",
    );
    db2.close();
    assert.equal(isCodexTurnInProgress(threadId, codexDir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
