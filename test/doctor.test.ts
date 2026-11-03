import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { BusClient } from "../src/busClient.ts";
import { startDaemon } from "../src/daemon.ts";
import { SESSION_STALE_MS, type PaneProbe } from "../src/health.ts";
import { repoKey } from "../src/repo.ts";
import { Store } from "../src/store.ts";
import { ensureToken } from "../src/token.ts";
import type { AgentRecord } from "../src/types.ts";

async function fixture(probe: PaneProbe = async () => false) {
  const home = mkdtempSync(path.join(tmpdir(), "switchboard-prune-"));
  const token = ensureToken(home);
  const dbFile = path.join(home, "bus.db");
  const store = new Store(dbFile);
  const daemon = await startDaemon({ port: 0, dbFile, token, paneProbe: probe });
  writeFileSync(path.join(home, "daemon.json"), JSON.stringify({ port: daemon.port, url: daemon.url }));
  const clients: BusClient[] = [];
  return {
    home, store, daemon,
    add(repo: string, name: string, sessionId: string | null, stale = false) {
      store.upsertAgent({ repo, name, harness: "grok", sessionId, cwd: "/work", wake: true, status: "working" });
      if (stale) store.db.prepare("UPDATE agents SET last_seen = ? WHERE repo = ? AND name = ?")
        .run(Date.now() - SESSION_STALE_MS - 1000, repo, name);
    },
    async join(repo = "repo-a", name = "cli", sessionId?: string) {
      const client = new BusClient();
      clients.push(client);
      await client.connect(daemon.url, { type: "hello", token, name, harness: name === "cli" ? "cli" : "grok",
        repoKey: repo, cwd: "/work", sessionId, boundSession: Boolean(sessionId), wake: true });
      return client;
    },
    async close() {
      for (const client of clients) client.close();
      await daemon.close();
      store.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

async function doctor(client: BusClient, extra: { all?: boolean; prune?: boolean } = {}) {
  const frame = await client.request({ type: "doctor", ...extra });
  assert.equal(frame.type, "doctor");
  if (frame.type !== "doctor") throw new Error("unexpected response");
  return frame;
}

test("prune clears dead bindings and marks stale records offline, preserving healthy and unverified records", async () => {
  const fx = await fixture(async (target) => target.pane === "%1" ? false : target.pane === "%2" ? true : null);
  try {
    fx.add("repo-a", "dead", "tmux:%1");
    fx.add("repo-a", "healthy", "tmux:%2");
    fx.add("repo-a", "unknown", "tmux:%3");
    fx.add("repo-a", "stale", "thread-stale", true);
    fx.add("repo-b", "dead", "tmux:%1");
    const staleSeen = fx.store.getAgent("repo-a", "stale")!.lastSeen;
    const client = await fx.join();
    const scan = await doctor(client);
    assert.equal(scan.agents.length, 4);
    assert.deepEqual(scan.pruned, []);
    assert.equal(fx.store.getAgent("repo-a", "dead")!.sessionId, "tmux:%1");
    const result = await doctor(client, { prune: true });
    assert.deepEqual(result.pruned.map((p) => [p.name, p.reason]), [["dead", "dead_pane"], ["stale", "stale"]]);
    assert.equal(fx.store.getAgent("repo-a", "dead")!.sessionId, null);
    assert.equal(fx.store.getAgent("repo-a", "dead")!.status, "offline");
    assert.equal(fx.store.getAgent("repo-a", "stale")!.status, "offline");
    assert.equal(fx.store.getAgent("repo-a", "stale")!.sessionId, "thread-stale");
    assert.equal(fx.store.getAgent("repo-a", "stale")!.lastSeen, staleSeen);
    assert.equal(fx.store.getAgent("repo-a", "healthy")!.status, "working");
    assert.equal(fx.store.getAgent("repo-a", "unknown")!.status, "working");
    assert.equal(fx.store.getAgent("repo-b", "dead")!.sessionId, "tmux:%1");
    assert.deepEqual((await doctor(client, { prune: true })).pruned, []);
    assert.equal((await doctor(client, { all: true })).agents.length, 5);
    assert.deepEqual((await doctor(client, { all: true, prune: true })).pruned.map((p) => p.repo), ["repo-b"]);
  } finally { await fx.close(); }
});

test("pruning a live dead pane removes injection binding without closing the shim", async () => {
  const fx = await fixture();
  try {
    const live = await fx.join("repo-a", "grok", "zellij:grid:1");
    const result = await doctor(await fx.join(), { prune: true });
    assert.equal(result.pruned.length, 1);
    assert.equal(fx.store.getAgent("repo-a", "grok")!.sessionId, null);
    const who = await live.request({ type: "who" });
    assert.equal(who.type, "who");
    if (who.type !== "who") return;
    assert.equal(who.agents[0]!.online, true);
    assert.equal(who.agents[0]!.diagnostics!.wakeMode, "push");
    assert.equal(who.agents[0]!.diagnostics!.health, "online");
  } finally { await fx.close(); }
});

test("prune preserves a healthy same-name session's newer registration", async () => {
  const fx = await fixture(async (target) => target.pane === "%2");
  try {
    await fx.join("repo-a", "grok", "tmux:%1");
    await fx.join("repo-a", "grok", "tmux:%2");
    const result = await doctor(await fx.join(), { prune: true });
    assert.equal(result.agents.length, 2);
    assert.deepEqual(result.pruned.map((p) => p.sessionId), ["tmux:%1"]);
    assert.equal(fx.store.getAgent("repo-a", "grok")!.sessionId, "tmux:%2");
    assert.equal(fx.store.getAgent("repo-a", "grok")!.status, "online");
  } finally { await fx.close(); }
});

test("prune skips a registration changed while its pane was being checked", async () => {
  let release!: (value: boolean) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const fx = await fixture(async () => { entered(); return new Promise<boolean>((resolve) => { release = resolve; }); });
  try {
    fx.add("repo-a", "grok", "tmux:%1");
    const client = await fx.join();
    const pending = doctor(client, { prune: true });
    await started;
    fx.store.upsertAgent({ repo: "repo-a", name: "grok", harness: "grok", sessionId: "tmux:%2", cwd: "/work", wake: true, status: "reconnected" });
    release(false);
    assert.deepEqual((await pending).pruned, []);
    assert.equal(fx.store.getAgent("repo-a", "grok")!.sessionId, "tmux:%2");
    assert.equal(fx.store.getAgent("repo-a", "grok")!.status, "reconnected");
  } finally { await fx.close(); }
});

test("CLI doctor --all --prune JSON reports mutations across boards and text reports pruned agents", async () => {
  const fx = await fixture();
  const exec = promisify(execFile);
  const cli = path.resolve("src/cli.ts");
  try {
    fx.add("repo-a", "old", null, true);
    fx.add("repo-b", "old", "tmux:%1");
    const opts = { env: { ...process.env, SWITCHBOARD_HOME: fx.home, SWITCHBOARD_NO_AUTOSTART: "1" } };
    await assert.rejects(exec(process.execPath, ["--experimental-strip-types", cli, "doctor", "--all", "--prune", "--json"], opts), (error: any) => {
      assert.equal(error.code, 1);
      const report = JSON.parse(error.stdout);
      assert.equal(report.agents.length, 2);
      assert.deepEqual(report.pruned.map((p: AgentRecord) => p.repo), ["repo-a", "repo-b"]);
      return true;
    });
    fx.add("repo-b", "old", "tmux:%1");
    await assert.rejects(exec(process.execPath, ["--experimental-strip-types", cli, "doctor", "--all", "--prune"], opts), (error: any) => {
      assert.match(error.stdout, /pruned 1 agent\(s\)/);
      assert.match(error.stdout, /pruned repo-b old session=tmux:%1 reason=dead_pane/);
      return true;
    });
  } finally { await fx.close(); }
});

test("CLI --share and --scope select shared/split worktree boards independently of the default", async () => {
  const fx = await fixture();
  const cli = path.resolve("src/cli.ts");
  const exec = promisify(execFile);
  const main = path.join(fx.home, "project");
  const worktree = path.join(fx.home, "worktree");
  try {
    mkdirSync(main);
    execFileSync("git", ["init", "--quiet", main]);
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "--allow-empty", "-m", "initial"], { cwd: main });
    execFileSync("git", ["worktree", "add", "--quiet", "-b", "lane", worktree], { cwd: main });
    fx.add(repoKey(worktree, "share"), "shared", null);
    fx.add(repoKey(worktree, "split"), "split", null);
    const env = { ...process.env, SWITCHBOARD_HOME: fx.home, SWITCHBOARD_NO_AUTOSTART: "1", SWITCHBOARD_SCOPE: "split" };
    for (const flags of [["--share"], ["--scope", "share"]]) {
      const output = await exec(process.execPath, ["--experimental-strip-types", cli, "doctor", "--cwd", worktree, "--json", ...flags], { env });
      assert.deepEqual(JSON.parse(output.stdout).map((a: AgentRecord) => a.name), ["shared"]);
    }
    const output = await exec(process.execPath, ["--experimental-strip-types", cli, "doctor", "--cwd", worktree, "--json", "--scope", "split"], { env });
    assert.deepEqual(JSON.parse(output.stdout).map((a: AgentRecord) => a.name), ["split"]);
    for (const flags of [["--all", "--share"], ["--scope", "invalid"], ["--share", "--scope", "split"]]) {
      await assert.rejects(exec(process.execPath, ["--experimental-strip-types", cli, "doctor", ...flags], { env }), (error: any) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /conflict|--scope must|cannot be combined/);
        return true;
      });
    }
  } finally { await fx.close(); }
});
