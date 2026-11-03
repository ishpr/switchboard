import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildAccountProfile,
  discoverClaudeAccounts,
  provisionClaudeAccount,
} from "../src/accounts.ts";
import {
  chosenIds,
  claudeAccountPanes,
  gridPlan,
  harnessPanes,
  panesFor,
  readRepoConfig,
  resolveAccountProfiles,
  resolveOrchestratorName,
  resolveShimCwd,
  switchboardLayout,
  upsertZshBlock,
  writeRepoConfig,
  zshLauncher,
  type PaneChoice,
} from "../src/init.ts";

test("the grid layout opens every harness in the repo", () => {
  const layout = switchboardLayout("/Users/ishprasad/Switchboard");
  assert.match(layout, /tab name="switchboard" cwd="\/Users\/ishprasad\/Switchboard"/);
  for (const name of ["Orchestrator", "Grok", "Claude", "Codex", "Kimi", "Muse", "Antigravity", "Bus"]) {
    assert.match(layout, new RegExp(`pane name="${name}"`));
  }
  assert.doesNotMatch(layout, /pane name="Cursor"/);
  assert.match(layout, /pane name="Orchestrator" command="\/Users\/ishprasad\/\.local\/bin\/cursor-agent"/);
  assert.match(layout, /split_direction="horizontal"/);
  assert.doesNotMatch(layout, /--continue/);
  assert.match(layout, /args "--yolo" "--approve-mcps" "--trust"/);
  assert.match(layout, /args "--yolo"/);
  assert.match(layout, /args "--dangerously-skip-permissions" "--mode" "auto"/);
});

test("resume layout continues the latest session of each harness", () => {
  const layout = switchboardLayout("/Users/ishprasad/Switchboard", harnessPanes(true));
  assert.match(layout, /args "--always-approve" "--model" "grok-4.7" "--reasoning-effort" "xhigh" "--continue"/);
  assert.match(layout, /args "--dangerously-bypass-approvals-and-sandbox" "--model" "gpt-6.1-sol" "resume" "--last"/);
  assert.match(layout, /args "--yolo" "--approve-mcps" "--trust" "--continue"/);
  assert.match(layout, /args "--yolo" "--continue"/);
  assert.match(layout, /args "--dangerously-skip-permissions" "--mode" "auto" "--continue"/);
});

test("init keeps the panes found here and skips a CLI that is not installed", () => {
  const choices: PaneChoice[] = [
    { index: 1, id: "orchestrator", pane: "Orchestrator", found: true, command: "/bin/cursor-agent" },
    { index: 2, id: "claude", pane: "Claude", found: false, command: null },
    { index: 3, id: "antigravity", pane: "Antigravity", found: true, command: "/bin/agy" },
    { index: 4, id: "bus", pane: "Bus", found: true, command: null },
  ];
  assert.deepEqual(chosenIds("", choices), ["orchestrator", "antigravity", "bus"]);
  assert.deepEqual(chosenIds("all", choices), ["orchestrator", "claude", "antigravity", "bus"]);
  assert.deepEqual(chosenIds("2, cursor agy", choices), ["claude", "orchestrator", "antigravity"]);

  const panes = panesFor(["orchestrator", "claude", "bus"], true, choices);
  assert.deepEqual(
    panes.map((pane) => pane.name),
    ["Orchestrator", "Bus"],
  );
  assert.equal(panes[0]?.command, "/bin/cursor-agent");
  assert.deepEqual(panes[0]?.args?.slice(-1), ["--continue"]);

  const layout = switchboardLayout("/work", panesFor(["claude"], false, choices));
  assert.match(layout, /pane name="Bus"/);
  assert.doesNotMatch(layout, /pane name="Claude"/);
  assert.equal(layout.match(/split_direction="vertical"/g)?.length, 1);
});

test("an open grid is attached, and a dead one is replaced by the resume layout", () => {
  const dir = "/Users/ishprasad/.config/zellij/layouts";
  assert.deepEqual(gridPlan(true, "switchboard [Created 1m ago]", dir), {
    action: "attach",
    session: "switchboard",
  });
  assert.deepEqual(gridPlan(true, "switchboard [Created 1m ago] (EXITED - attach to resurrect)", dir), {
    action: "start",
    session: "switchboard",
    layout: "/Users/ishprasad/.config/zellij/layouts/switchboard-resume.kdl",
    deleteFirst: true,
  });
  assert.deepEqual(gridPlan(false, null, dir), {
    action: "start",
    session: "switchboard",
    layout: "/Users/ishprasad/.config/zellij/layouts/switchboard.kdl",
    deleteFirst: false,
  });
});

test("the zshrc block is replaced instead of duplicated", () => {
  const body = zshLauncher("/Users/ishprasad/Switchboard/dist/cli.js");
  const first = upsertZshBlock("export PATH=old\n", body);
  const second = upsertZshBlock(first, body);
  assert.equal(second, first);
  assert.equal(second.match(/# >>> switchboard >>>/g)?.length, 1);
  assert.match(second, /command node '\/Users\/ishprasad\/Switchboard\/dist\/cli.js'/);
  assert.match(second, /switchboard-resume\.kdl/);
  assert.match(second, /\$1 == --resume/);
  assert.match(second, /^export PATH=old\n/);
});

test("per-repo config persists different orchestrators for different repos", () => {
  const home = mkdtempSync(path.join(tmpdir(), "sb-repo-cfg-"));
  const dirA = mkdtempSync(path.join(tmpdir(), "sb-repo-a-"));
  const dirB = mkdtempSync(path.join(tmpdir(), "sb-repo-b-"));

  assert.equal(resolveOrchestratorName("argon4"), "agy");
  assert.equal(resolveOrchestratorName("antigravity"), "agy");
  assert.equal(resolveOrchestratorName("cursor-agent"), "cursor");
  assert.equal(resolveOrchestratorName("", "agy"), "agy");

  writeRepoConfig(dirA, { orchestrator: "agy", panes: ["antigravity", "claude"] }, home);
  writeRepoConfig(dirB, { orchestrator: "cursor", panes: ["orchestrator", "codex"] }, home);

  const cfgA = readRepoConfig(dirA, home);
  const cfgB = readRepoConfig(dirB, home);
  assert.equal(cfgA?.orchestrator, "agy");
  assert.deepEqual(cfgA?.panes, ["antigravity", "claude"]);
  assert.equal(cfgB?.orchestrator, "cursor");
  assert.deepEqual(cfgB?.panes, ["orchestrator", "codex"]);

  // Desktop GUI shims started with cwd="/" fall back to a configured repoRoot
  assert.ok([cfgA?.repoRoot, cfgB?.repoRoot].includes(resolveShimCwd("/", home)));
});

test("multi-account Claude resolution and isolated environment provisioning are completely generic", () => {
  const fakeHome = mkdtempSync(path.join(tmpdir(), "sb-acct-home-"));
  const fakeSbHome = mkdtempSync(path.join(tmpdir(), "sb-acct-sbhome-"));
  const baseClaude = path.join(fakeHome, ".claude");
  mkdirSync(baseClaude, { recursive: true });
  writeFileSync(path.join(baseClaude, "settings.json"), '{"hooks":{}}\n');
  writeFileSync(path.join(baseClaude, "CLAUDE.md"), "# shared\n");

  // 1. Numeric count generates generic acct1..acctN when none exist
  const byCount = resolveAccountProfiles("3", true, [], fakeHome);
  assert.equal(byCount.length, 3);
  assert.deepEqual(
    byCount.map((p) => p.id),
    ["acct1", "acct2", "acct3"],
  );

  // 2. Custom id:email:plan specification
  const custom = resolveAccountProfiles(
    "work:alice@corp.com:team,personal:alice@gmail.com:max",
    true,
    [],
    fakeHome,
  );
  assert.equal(custom.length, 2);
  assert.equal(custom[0]?.id, "work");
  assert.equal(custom[0]?.email, "alice@corp.com");
  assert.equal(custom[0]?.plan, "team");
  assert.equal(custom[1]?.id, "personal");

  // 3. Provisioning creates ~/.claude-<id>, symlinks shared config, and injects Switchboard MCP
  const profile = buildAccountProfile("alpha:alpha@example.com:max", [], fakeHome);
  provisionClaudeAccount(profile, {
    cliPath: "/opt/switchboard/dist/cli.js",
    nodePath: "/usr/local/bin/node",
    home: fakeHome,
  });

  assert.ok(existsSync(profile.configDir));
  assert.ok(lstatSync(path.join(profile.configDir, "settings.json")).isSymbolicLink());
  assert.ok(lstatSync(path.join(profile.configDir, "CLAUDE.md")).isSymbolicLink());

  const claudeJson = JSON.parse(readFileSync(path.join(profile.configDir, ".claude.json"), "utf8"));
  assert.deepEqual(claudeJson.mcpServers.switchboard, {
    type: "stdio",
    command: "/usr/local/bin/node",
    args: ["/opt/switchboard/dist/cli.js", "mcp"],
    env: {
      SWITCHBOARD_NAME: "alpha",
      SWITCHBOARD_HARNESS: "claude",
      SWITCHBOARD_SCOPE: "share",
    },
  });

  // 4. Discovery picks up ~/.claude-<id> from disk
  const discovered = discoverClaudeAccounts(fakeHome, fakeSbHome);
  assert.deepEqual(
    discovered.map((d) => d.id),
    ["alpha"],
  );

  // 5. Pane generation supports both fresh and --resume via native claude-pane
  const fresh = claudeAccountPanes("/Users/ishprasad/code/servone", false, custom, "/opt/switchboard/dist/cli.js");
  assert.equal(fresh.length, 2);
  assert.ok(fresh[0]?.args?.includes("claude-pane"));
  assert.ok(!fresh[0]?.args?.includes("--resume"));

  const resumed = claudeAccountPanes("/Users/ishprasad/code/servone", true, custom, "/opt/switchboard/dist/cli.js");
  assert.equal(resumed.length, 2);
  for (const pane of resumed) {
    assert.equal(pane.args?.at(-1), "--resume");
  }

  const dir = "/Users/ishprasad/.config/zellij/layouts";
  assert.deepEqual(gridPlan(true, "switchboard [Created 1m ago]", dir, { restart: true }), {
    action: "start",
    session: "switchboard",
    layout: "/Users/ishprasad/.config/zellij/layouts/switchboard-resume.kdl",
    deleteFirst: true,
  });
});
