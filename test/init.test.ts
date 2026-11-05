import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  configureHarnessConfigs,
  discoverRatioBinding,
  formatRatioBinding,
  gridPlan,
  gridSessionName,
  harnessPanes,
  isActiveZellijGridSession,
  isHarnessProcessInPsOutput,
  panesFor,
  parseZellijPaneForInvitedAgent,
  readRepoConfig,
  resolveAccountProfiles,
  resolveInvitedAgentSpec,
  resolveOrchestratorName,
  resolveShimCwd,
  switchboardLayout,
  upsertCodexHooks,
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
  assert.match(layout, /args "--always-approve" "--continue"/);
  assert.match(layout, /args "--dangerously-bypass-approvals-and-sandbox" "resume" "--last"/);
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
  const cfgA = readRepoConfig(dirA, home);
  // Desktop GUI shims started with cwd="/" fall back when exactly one repo is configured
  assert.equal(resolveShimCwd("/", home), cfgA?.repoRoot);

  writeRepoConfig(dirB, { orchestrator: "cursor", panes: ["orchestrator", "codex"] }, home);
  const cfgB = readRepoConfig(dirB, home);
  assert.equal(cfgA?.orchestrator, "agy");
  assert.deepEqual(cfgA?.panes, ["antigravity", "claude"]);
  assert.equal(cfgB?.orchestrator, "cursor");
  assert.deepEqual(cfgB?.panes, ["orchestrator", "codex"]);

  // When more than one repo is configured, a shim started at "/" stays unbound on "/"
  assert.equal(resolveShimCwd("/", home), "/");
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

  // 1b. Multiple numbers ("1 3") pick 1-based indexes from the discovered list
  const pickedByIndex = resolveAccountProfiles("1 3", true, byCount, fakeHome);
  assert.deepEqual(
    pickedByIndex.map((p) => p.id),
    ["acct1", "acct3"],
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

  // 3. Provisioning creates ~/.claude-<id>, symlinks shared config, injects Switchboard MCP,
  //    and attaches a worktree even when branch ws/<id> already exists in the git repo.
  const fakeRepo = path.join(fakeHome, "sample-repo");
  mkdirSync(fakeRepo, { recursive: true });
  execFileSync("git", ["-C", fakeRepo, "init"], { stdio: "ignore" });
  execFileSync("git", ["-C", fakeRepo, "config", "user.email", "test@example.com"], { stdio: "ignore" });
  execFileSync("git", ["-C", fakeRepo, "config", "user.name", "Test"], { stdio: "ignore" });
  writeFileSync(path.join(fakeRepo, "README.md"), "# sample\n");
  execFileSync("git", ["-C", fakeRepo, "add", "README.md"], { stdio: "ignore" });
  execFileSync("git", ["-C", fakeRepo, "commit", "-m", "init"], { stdio: "ignore" });
  execFileSync("git", ["-C", fakeRepo, "branch", "ws/alpha"], { stdio: "ignore" });

  const profile = buildAccountProfile("alpha:alpha@example.com:max", [], fakeHome);
  const { worktreeDir } = provisionClaudeAccount(profile, {
    targetRepo: fakeRepo,
    cliPath: "/opt/switchboard/dist/cli.js",
    nodePath: "/usr/local/bin/node",
    home: fakeHome,
  });

  assert.ok(existsSync(profile.configDir));
  assert.ok(existsSync(path.join(worktreeDir, "README.md")));
  assert.equal(worktreeDir, path.join(profile.workspaceRoot, "sample-repo"));
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

test("upsertCodexHooks installs and merges SessionStart, UserPromptSubmit, PostToolUse, and Stop hooks idempotently", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sb-codex-hooks-"));
  const hooksFile = path.join(dir, ".codex", "hooks.json");
  mkdirSync(path.dirname(hooksFile), { recursive: true });
  writeFileSync(
    hooksFile,
    JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "echo custom-stop" }] }],
      },
    }),
  );

  upsertCodexHooks("/opt/switchboard/dist/cli.js", hooksFile);
  upsertCodexHooks("/opt/switchboard/dist/cli.js", hooksFile);

  const parsed = JSON.parse(readFileSync(hooksFile, "utf8"));
  assert.equal(parsed.hooks.SessionStart.length, 1);
  assert.equal(parsed.hooks.UserPromptSubmit.length, 1);
  assert.equal(parsed.hooks.PostToolUse.length, 1);
  assert.equal(parsed.hooks.PostToolUse[0].matcher, ".*");
  assert.equal(parsed.hooks.Stop.length, 2);
  assert.match(parsed.hooks.PostToolUse[0].hooks[0].command, /hook --harness codex --event PostToolUse/);
  assert.match(parsed.hooks.Stop[1].hooks[0].command, /hook --harness codex --event Stop/);
});

test("per-repo gridSessionName isolates concurrent project Zellij grids and resolveInvitedAgentSpec normalizes harnesses", () => {
  const sA = gridSessionName("/Users/ishprasad/dunkbot");
  const sB = gridSessionName("/Users/ishprasad/Switchboard");
  assert.match(sA, /^switchboard-dunkbot-[0-9a-f]{6}$/);
  assert.match(sB, /^switchboard-switchboard-[0-9a-f]{6}$/);
  assert.notEqual(sA, sB);
  assert.equal(gridSessionName("/"), "switchboard");

  const dir = "/Users/ishprasad/.config/zellij/layouts";
  const planA = gridPlan(true, `${sA} [Created 1m ago]`, dir, { cwd: "/Users/ishprasad/dunkbot" });
  assert.equal(planA.action, "attach");
  assert.equal(planA.session, sA);

  assert.equal(resolveInvitedAgentSpec("grok")?.harness, "grok");
  assert.equal(resolveInvitedAgentSpec("muse")?.harness, "muse");
  assert.equal(resolveInvitedAgentSpec("argon4")?.name, "agy");
  assert.equal(resolveInvitedAgentSpec("cursor-agent")?.name, "cursor");

  assert.equal(isHarnessProcessInPsOutput("login\n-zsh\n", "/Users/ishprasad/.grok/bin/grok", "grok"), false);
  assert.equal(isHarnessProcessInPsOutput("login\n-zsh\nnode /tmp/zsh-helper.js\n", "/Users/ishprasad/.grok/bin/grok", "grok"), false);
  assert.equal(isHarnessProcessInPsOutput("zsh -lc cd /repo && exec /Users/ishprasad/.grok/bin/grok\n", "/Users/ishprasad/.grok/bin/grok", "grok"), false);
  assert.equal(isHarnessProcessInPsOutput("login\n-zsh\n/Users/ishprasad/.grok/bin/grok\n", "/Users/ishprasad/.grok/bin/grok", "grok"), true);
  assert.equal(isHarnessProcessInPsOutput("login\n-zsh\nnode /Users/ishprasad/.local/bin/muse --yolo\n", "/Users/ishprasad/.local/bin/muse", "muse"), true);

  assert.equal(isActiveZellijGridSession(`${sB} [Created 2m ago]\n`, sB), true);
  assert.equal(isActiveZellijGridSession(`${sB} [Created 2m ago] (EXITED - attach to resurrect)\n`, sB), false);
  assert.equal(
    parseZellijPaneForInvitedAgent(
      `zsh -lc exec muse SWITCHBOARD_NAME=muse ZELLIJ_SESSION_NAME=${sB} ZELLIJ_PANE_ID=4\nnode /Users/ishprasad/.local/bin/muse --yolo SWITCHBOARD_NAME=muse ZELLIJ_SESSION_NAME=${sB} ZELLIJ_PANE_ID=4\n`,
      sB,
      "muse",
      "/Users/ishprasad/.local/bin/muse",
      "muse",
    ),
    `zellij:${sB}:4`,
  );
});

test("discoverRatioBinding resolves repo-local and home-level Ratio project/profile across harnesses", () => {
  const fakeHome = mkdtempSync(path.join(tmpdir(), "switchboard-ratio-home-"));
  const repoDir = mkdtempSync(path.join(tmpdir(), "switchboard-ratio-repo-"));
  execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });

  // 1. User-level configs: Cursor -> p-serveone, Codex -> p-ratio, isolated Claude 'pi' -> p-dunkbot
  mkdirSync(path.join(fakeHome, ".cursor"), { recursive: true });
  writeFileSync(
    path.join(fakeHome, ".cursor", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        ratio: { url: "https://ratio.servsys.com", headers: { "X-Ratio-Project": "p-serveone" } },
      },
    }),
  );

  mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
  writeFileSync(
    path.join(fakeHome, ".codex", "config.toml"),
    `[mcp_servers.ratio]\nurl = "https://ratio.servsys.com/"\nhttp_headers = { "X-Ratio-Project" = "p-ratio" }\n`,
  );

  mkdirSync(path.join(fakeHome, ".claude-pi"), { recursive: true });
  writeFileSync(
    path.join(fakeHome, ".claude-pi", ".claude.json"),
    JSON.stringify({
      mcpServers: {
        ratio: { url: "https://ratio.servsys.com", headers: { "X-Ratio-Project": "p-dunkbot" } },
      },
    }),
  );

  const curGlobal = discoverRatioBinding({ cwd: repoDir, harness: "cursor", name: "cursor", env: {}, home: fakeHome });
  assert.deepEqual(curGlobal, { project: "p-serveone", profile: null, source: "home:.cursor/mcp.json" });
  assert.equal(formatRatioBinding(curGlobal), "ratio=p-serveone[home:.cursor/mcp.json]");

  const cdxGlobal = discoverRatioBinding({
    cwd: repoDir,
    harness: "codex",
    name: "codex",
    env: { CODEX_HOME: path.join(fakeHome, ".codex") },
    home: fakeHome,
  });
  assert.deepEqual(cdxGlobal, { project: "p-ratio", profile: null, source: "home:.codex/config.toml" });

  // Subtable [mcp_servers.ratio.http_headers] and unpinned [mcp_servers.ratio] shapes
  writeFileSync(
    path.join(fakeHome, ".codex", "config.toml"),
    `[mcp_servers.ratio]\nurl = "https://ratio.servsys.com/"\n\n[mcp_servers.ratio.http_headers]\n"X-Ratio-Project" = "p-subtable"\n`,
  );
  const cdxSubtable = discoverRatioBinding({
    cwd: repoDir,
    harness: "codex",
    name: "codex",
    env: { CODEX_HOME: path.join(fakeHome, ".codex") },
    home: fakeHome,
  });
  assert.deepEqual(cdxSubtable, { project: "p-subtable", profile: null, source: "home:.codex/config.toml" });

  writeFileSync(
    path.join(fakeHome, ".codex", "config.toml"),
    `[mcp_servers.ratio]\nurl = "https://ratio.servsys.com/"\n`,
  );
  const cdxUnpinned = discoverRatioBinding({
    cwd: repoDir,
    harness: "codex",
    name: "codex",
    env: { CODEX_HOME: path.join(fakeHome, ".codex") },
    home: fakeHome,
  });
  assert.deepEqual(cdxUnpinned, { project: "unpinned", profile: null, source: "home:.codex/config.toml(no-header)" });

  const piGlobal = discoverRatioBinding({ cwd: repoDir, harness: "claude", name: "pi", env: {}, home: fakeHome });
  assert.deepEqual(piGlobal, { project: "p-dunkbot", profile: "pi", source: "home:.claude-pi" });
  assert.equal(formatRatioBinding(piGlobal), "ratio=p-dunkbot(pi)[home:.claude-pi]");

  // 2. Repo-local .mcp.json overrides global config
  writeFileSync(
    path.join(repoDir, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        ratio: { url: "https://ratio.servsys.com", headers: { "X-Ratio-Project": "p-repo-local" } },
      },
    }),
  );
  const curLocal = discoverRatioBinding({ cwd: repoDir, harness: "cursor", name: "cursor", env: {}, home: fakeHome });
  assert.deepEqual(curLocal, { project: "p-repo-local", profile: null, source: "repo:.mcp.json" });

  // 3. Linked git worktree inherits main checkout .mcp.json and allows worktree-local override
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=t@e.com", "commit", "--allow-empty", "-m", "init"], {
    cwd: repoDir,
    stdio: "ignore",
  });
  const worktreeDir = path.join(mkdtempSync(path.join(tmpdir(), "switchboard-ratio-wt-")), "wt");
  execFileSync("git", ["worktree", "add", "-b", "wt-branch", worktreeDir], { cwd: repoDir, stdio: "ignore" });
  const wtInherited = discoverRatioBinding({
    cwd: worktreeDir,
    harness: "cursor",
    name: "cursor",
    env: {},
    home: fakeHome,
  });
  assert.deepEqual(wtInherited, { project: "p-repo-local", profile: null, source: "repo:.mcp.json" });

  writeFileSync(
    path.join(worktreeDir, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        ratio: { url: "https://ratio.servsys.com", headers: { "X-Ratio-Project": "p-wt-override" } },
      },
    }),
  );
  const wtOverridden = discoverRatioBinding({
    cwd: worktreeDir,
    harness: "cursor",
    name: "cursor",
    env: {},
    home: fakeHome,
  });
  assert.deepEqual(wtOverridden, { project: "p-wt-override", profile: null, source: "repo:.mcp.json" });

  // 4. parseZellijPaneForInvitedAgent matches single-quoted env values and filters ignorePids
  const quotedPs = [
    "101 zsh -lc cd '/tmp/a' && export SWITCHBOARD_NAME='grok' ZELLIJ_SESSION_NAME='switchboard-a' ZELLIJ_PANE_ID='3' && exec '/bin/grok'",
    "202 /bin/grok --always-approve SWITCHBOARD_NAME='grok' ZELLIJ_SESSION_NAME='switchboard-a' ZELLIJ_PANE_ID='3'",
    "303 /bin/grok --always-approve SWITCHBOARD_NAME='grok' ZELLIJ_SESSION_NAME='switchboard-a' ZELLIJ_PANE_ID='8'",
  ].join("\n");
  assert.equal(
    parseZellijPaneForInvitedAgent(quotedPs, "switchboard-a", "grok", "/bin/grok", "grok", new Set([202])),
    "zellij:switchboard-a:8",
  );

  // 5. switchboardLayout escapes quotes and backslashes in KDL strings
  const layoutKdl = switchboardLayout('/tmp/my "repo"\\path', [
    { name: 'Pane "A"', command: '/bin/my "cmd"', args: ["--flag"] },
  ]);
  assert.ok(layoutKdl.includes('cwd="/tmp/my \\"repo\\"\\\\path"'));
  assert.ok(layoutKdl.includes('pane name="Pane \\"A\\"" command="/bin/my \\"cmd\\""'));
});

test("configureHarnessConfigs idempotently wires MCP servers and hooks across Desktop and CLI harnesses", () => {
  const fakeHome = mkdtempSync(path.join(tmpdir(), "sb-all-harnesses-"));
  for (const dir of [
    ".claude",
    path.join("Library", "Application Support", "Claude"),
    ".codex",
    ".cursor",
    ".grok",
    path.join(".config", "muse"),
    ".kimi",
    path.join(".gemini", "antigravity"),
  ]) {
    mkdirSync(path.join(fakeHome, dir), { recursive: true });
  }
  // Seed Muse settings with legacy mcp_servers key to verify it is cleaned up
  writeFileSync(
    path.join(fakeHome, ".config", "muse", "settings.json"),
    JSON.stringify({ mcp_servers: { legacy: true } }),
  );
  // Seed Codex config.toml with an existing section
  writeFileSync(
    path.join(fakeHome, ".codex", "config.toml"),
    `model = "o3"\n\n[mcp_servers.ratio]\nurl = "https://ratio.servsys.com"\n`,
  );

  const cliPath = "/opt/switchboard/dist/cli.js";
  const nodePath = "/usr/local/bin/node";
  const first = configureHarnessConfigs({
    cliPath,
    nodeBin: nodePath,
    userHome: fakeHome,
    selectedPanes: ["orchestrator", "grok", "claude", "codex", "kimi", "muse", "antigravity"],
  });
  const second = configureHarnessConfigs({
    cliPath,
    nodeBin: nodePath,
    userHome: fakeHome,
    selectedPanes: ["orchestrator", "grok", "claude", "codex", "kimi", "muse", "antigravity"],
  });
  assert.deepEqual(second, first);

  const claudeJson = JSON.parse(readFileSync(path.join(fakeHome, ".claude.json"), "utf8"));
  assert.equal(claudeJson.mcpServers.switchboard.command, nodePath);
  assert.equal(claudeJson.mcpServers.switchboard.env.SWITCHBOARD_HARNESS, "claude");

  const claudeHooks = JSON.parse(readFileSync(path.join(fakeHome, ".claude", "settings.json"), "utf8"));
  assert.equal(claudeHooks.hooks.UserPromptSubmit.length, 1);
  assert.equal(claudeHooks.hooks.PostToolUse.length, 1);
  assert.equal(claudeHooks.hooks.Stop.length, 1);

  const claudeDesktop = JSON.parse(
    readFileSync(path.join(fakeHome, "Library", "Application Support", "Claude", "claude_desktop_config.json"), "utf8"),
  );
  assert.equal(claudeDesktop.mcpServers.switchboard.env.SWITCHBOARD_HARNESS, "claude");

  const codexToml = readFileSync(path.join(fakeHome, ".codex", "config.toml"), "utf8");
  assert.equal(codexToml.match(/\[mcp_servers\.switchboard\]/g)?.length, 1);
  assert.match(codexToml, /SWITCHBOARD_HARNESS = "codex"/);
  assert.match(codexToml, /\[mcp_servers\.ratio\]/);

  const cursorMcp = JSON.parse(readFileSync(path.join(fakeHome, ".cursor", "mcp.json"), "utf8"));
  assert.equal(cursorMcp.mcpServers.switchboard.env.SWITCHBOARD_HARNESS, "cursor");
  const cursorHooks = JSON.parse(readFileSync(path.join(fakeHome, ".cursor", "hooks.json"), "utf8"));
  assert.equal(cursorHooks.hooks.postToolUse.length, 1);

  const grokMcp = JSON.parse(readFileSync(path.join(fakeHome, ".grok", "mcp.json"), "utf8"));
  assert.equal(grokMcp.mcpServers.switchboard.env.SWITCHBOARD_HARNESS, "grok");
  const grokSettings = JSON.parse(readFileSync(path.join(fakeHome, ".grok", "settings.json"), "utf8"));
  assert.equal(grokSettings.hooks.Stop.length, 1);

  const museSettings = JSON.parse(readFileSync(path.join(fakeHome, ".config", "muse", "settings.json"), "utf8"));
  assert.equal(museSettings.schema_version, 1);
  assert.equal(museSettings.mcp_servers, undefined);
  assert.equal(museSettings.mcpServers.switchboard.env.SWITCHBOARD_HARNESS, "muse");

  const kimiMcp = JSON.parse(readFileSync(path.join(fakeHome, ".kimi", "mcp.json"), "utf8"));
  assert.equal(kimiMcp.mcpServers.switchboard.env.SWITCHBOARD_HARNESS, "kimi");

  const agyMcp = JSON.parse(readFileSync(path.join(fakeHome, ".gemini", "antigravity", "mcp_config.json"), "utf8"));
  assert.equal(agyMcp.mcpServers.switchboard.env.SWITCHBOARD_HARNESS, "antigravity");
  assert.equal(agyMcp.mcpServers.switchboard.env.SWITCHBOARD_NAME, "agy");
});
