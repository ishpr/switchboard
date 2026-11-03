import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { BusClient } from "../src/busClient.ts";
import { startDaemon } from "../src/daemon.ts";
import { createPaneProbe, paneTarget, sessionDiagnostics, SESSION_STALE_MS } from "../src/health.ts";
import { repoKey } from "../src/repo.ts";
import { Store } from "../src/store.ts";
import { ensureToken } from "../src/token.ts";
import type { AgentRecord } from "../src/types.ts";

const now = 2_000_000;
const agent: AgentRecord = { repo: "repo", name: "codex", harness: "codex", sessionId: null,
  cwd: "/work", wake: true, lastSeen: now, online: true, status: "working", role: "worker" };

test("health respects the ten-minute boundary and distinguishes offline from stale", async () => {
  const probe = async () => { throw new Error("non-pane sessions must not be probed"); };
  assert.equal((await sessionDiagnostics(agent, probe, now)).health, "online");
  assert.equal((await sessionDiagnostics({ ...agent, online: false }, probe, now)).health, "offline");
  assert.equal((await sessionDiagnostics(agent, probe, now + SESSION_STALE_MS)).health, "online");
  const stale = await sessionDiagnostics(agent, probe, now + SESSION_STALE_MS + 1);
  assert.equal(stale.health, "stale");
  assert.match(stale.warnings.join(), /10 minutes/);
});

test("dead panes override fresh heartbeats and staleness; unknown panes warn without declaring death", async () => {
  for (const sessionId of ["tmux:%12", "%12", "zellij:grid:2"]) {
    const dead = await sessionDiagnostics({ ...agent, sessionId }, async () => false, now);
    assert.equal(dead.health, "dead_pane");
    assert.equal(dead.wakeMode, "inject");
    assert.match(dead.warnings.join(), /wake=inject targets missing/);
    assert.equal((await sessionDiagnostics({ ...agent, sessionId }, async () => false, now + SESSION_STALE_MS + 1)).health, "dead_pane");
    const unknown = await sessionDiagnostics({ ...agent, sessionId }, async () => null, now);
    assert.equal(unknown.health, "online");
    assert.match(unknown.warnings.join(), /could not verify/);
  }
  const off = await sessionDiagnostics({ ...agent, wake: false }, async () => true, now);
  assert.match(off.warnings.join(), /wake=off on an active agent/);
  assert.deepEqual((await sessionDiagnostics({ ...agent, online: false, wake: false }, async () => true, now)).warnings, []);
});

test("pane bindings require exact terminal ids", () => {
  assert.deepEqual(paneTarget("tmux:%12"), { kind: "tmux", pane: "%12" });
  assert.deepEqual(paneTarget("zellij:grid:0"), { kind: "zellij", session: "grid", pane: "0" });
  for (const id of [null, "thread-12", "zellij:grid:plugin_1", "tmux:%12;exit"]) assert.equal(paneTarget(id), null);
});

test("tmux snapshot checks all panes once and excludes retained dead panes", async () => {
  let calls = 0;
  const probe = createPaneProbe(async (command, args) => {
    calls++;
    assert.equal(command, "tmux");
    assert.deepEqual(args, ["list-panes", "-a", "-F", "#{pane_id} #{pane_dead}"]);
    return "%12 0\n%13 1\n";
  });
  assert.deepEqual(await Promise.all(["%12", "%13", "%1"].map((pane) => probe({ kind: "tmux", pane }))), [true, false, false]);
  assert.equal(calls, 1);
});

test("Zellij snapshots are session-specific and exclude plugins and exited terminals", async () => {
  let calls = 0;
  const probe = createPaneProbe(async (command, args) => {
    assert.equal(command, "zellij");
    calls++;
    if (args[0] === "list-sessions") return "grid [Created 1h ago]\nold [EXITED - attach to resurrect]\nother [Created 2h ago]\n";
    assert.deepEqual(args.slice(2), ["action", "list-panes", "--json"]);
    return JSON.stringify(args[1] === "grid"
      ? [{ id: 0, is_plugin: true, exited: false }, { id: 1, is_plugin: false, exited: false }, { id: 2, is_plugin: false, exited: true }]
      : [{ id: 0, is_plugin: false, exited: false }]);
  });
  assert.equal(await probe({ kind: "zellij", session: "grid", pane: "0" }), false);
  assert.equal(await probe({ kind: "zellij", session: "grid", pane: "1" }), true);
  assert.equal(await probe({ kind: "zellij", session: "grid", pane: "2" }), false);
  assert.equal(await probe({ kind: "zellij", session: "old", pane: "1" }), false);
  assert.equal(await probe({ kind: "zellij", session: "gone", pane: "1" }), false);
  assert.equal(await probe({ kind: "zellij", session: "other", pane: "0" }), true);
  assert.equal(calls, 6);
});

test("missing tools, denied access, timeouts and unsupported/malformed output are unverified", async () => {
  for (const output of ["invalid", "{}", '[{"id":1}]']) {
    const probe = createPaneProbe(async (_cmd, args) => args[0] === "list-sessions" ? "grid [Created 1h ago]" : output);
    assert.equal(await probe({ kind: "zellij", session: "grid", pane: "1" }), null);
  }
  for (const code of ["ENOENT", "EACCES", "ETIMEDOUT"]) {
    const probe = createPaneProbe(async () => { throw Object.assign(new Error(code), { code }); });
    assert.equal(await probe({ kind: "tmux", pane: "%1" }), null);
    assert.equal(await probe({ kind: "zellij", session: "grid", pane: "1" }), null);
  }
  const noServer = createPaneProbe(async () => { throw { stderr: "no server running on /tmp/tmux-501/default" }; });
  assert.equal(await noServer({ kind: "tmux", pane: "%1" }), false);
});

test("who, status and doctor expose registered and live session diagnostics without mutating status", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "switchboard-doctor-"));
  const dbFile = path.join(home, "bus.db");
  const token = ensureToken(home);
  const cwd = process.cwd();
  const repo = repoKey(cwd);
  const store = new Store(dbFile);
  store.upsertAgent({ ...agent, repo, name: "old", status: "old-task" });
  store.db.prepare("UPDATE agents SET last_seen = ? WHERE name = ?").run(Date.now() - SESSION_STALE_MS - 1000, "old");
  const daemon = await startDaemon({ port: 0, dbFile, token, paneProbe: async () => false });
  const client = new BusClient();
  try {
    await client.connect(daemon.url, { type: "hello", token, name: "codex", harness: "codex", repoKey: repo, cwd,
      sessionId: "tmux:%12", boundSession: true, wake: false });
    const who = await client.request({ type: "who" });
    assert.equal(who.type, "who");
    if (who.type !== "who") return;
    assert.equal(who.agents.find((a) => a.name === "old")?.diagnostics?.health, "stale");
    assert.equal(who.agents.find((a) => a.name === "codex")?.diagnostics?.health, "dead_pane");
    const status = await client.request({ type: "status", status: "investigating" });
    assert.equal(status.type, "ok");
    if (status.type === "ok") {
      assert.match(status.detail, /health=dead_pane/);
      assert.match(status.detail, /wake=off on an active agent/);
    }
    assert.equal(store.getAgent(repo, "codex")?.status, "investigating");
    writeFileSync(path.join(home, "daemon.json"), JSON.stringify({ port: daemon.port, url: daemon.url }));
    const exec = promisify(execFile);
    const opts = { cwd, env: { ...process.env, SWITCHBOARD_HOME: home, SWITCHBOARD_NO_AUTOSTART: "1" } };
    await assert.rejects(exec(process.execPath, ["--experimental-strip-types", "src/cli.ts", "doctor", "--json"], opts), (error: any) => {
      assert.equal(error.code, 1);
      const report = JSON.parse(error.stdout);
      assert.equal(report.find((a: AgentRecord) => a.name === "codex").diagnostics.health, "dead_pane");
      assert.equal(report.find((a: AgentRecord) => a.name === "old").diagnostics.health, "stale");
      return true;
    });
    await assert.rejects(exec(process.execPath, ["--experimental-strip-types", "src/cli.ts", "doctor"], opts), (error: any) => {
      assert.equal(error.code, 1);
      assert.match(error.stdout, /health=dead_pane.*WARNING:/);
      return true;
    });
  } finally {
    client.close();
    await daemon.close();
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a failing injected probe is reported as unverified", async () => {
  const result = await sessionDiagnostics({ ...agent, sessionId: "tmux:%12" }, async () => { throw new Error("probe failed"); }, now);
  assert.equal(result.health, "online");
  assert.match(result.warnings.join(), /could not verify/);
});

test("doctor exits successfully for an empty board and a healthy session", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "switchboard-doctor-ok-"));
  const token = ensureToken(home);
  const cwd = process.cwd();
  const daemon = await startDaemon({ port: 0, dbFile: path.join(home, "bus.db"), token, paneProbe: async () => true });
  const client = new BusClient();
  try {
    writeFileSync(path.join(home, "daemon.json"), JSON.stringify({ port: daemon.port, url: daemon.url }));
    const opts = { cwd, env: { ...process.env, SWITCHBOARD_HOME: home, SWITCHBOARD_NO_AUTOSTART: "1" } };
    const exec = promisify(execFile);
    const empty = await exec(process.execPath, ["--experimental-strip-types", "src/cli.ts", "doctor", "--json"], opts);
    assert.deepEqual(JSON.parse(empty.stdout), []);
    await client.connect(daemon.url, { type: "hello", token, name: "grok", harness: "grok", repoKey: repoKey(cwd), cwd,
      sessionId: "zellij:grid:1", boundSession: true, wake: true });
    const healthy = await exec(process.execPath, ["--experimental-strip-types", "src/cli.ts", "doctor", "--json"], opts);
    const rows = JSON.parse(healthy.stdout);
    assert.equal(rows[0].diagnostics.health, "online");
    assert.deepEqual(rows[0].diagnostics.warnings, []);
  } finally {
    client.close();
    await daemon.close();
    rmSync(home, { recursive: true, force: true });
  }
});
