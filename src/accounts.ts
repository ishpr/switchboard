import { execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { switchboardHome } from "./paths.ts";
import { gitRepoRoot } from "./repo.ts";
import type { PaneSpec } from "./init.ts";

export type ClaudeAccountProfile = {
  id: string;
  label: string;
  pane: string;
  configDir: string;
  workspaceRoot: string;
  email?: string;
  plan?: string;
  model?: string;
};

export function accountsFilePath(sbHome = switchboardHome()): string {
  return path.join(sbHome, "accounts.json");
}

export function readSavedAccounts(sbHome = switchboardHome()): ClaudeAccountProfile[] {
  const file = accountsFilePath(sbHome);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? (parsed as ClaudeAccountProfile[]) : [];
  } catch {
    return [];
  }
}

export function writeSavedAccounts(accounts: ClaudeAccountProfile[], sbHome = switchboardHome()): void {
  mkdirSync(sbHome, { recursive: true });
  writeFileSync(accountsFilePath(sbHome), `${JSON.stringify(accounts, null, 2)}\n`);
}

export function inferClaudeAgentName(): string | undefined {
  const cfgDir = process.env.CLAUDE_CONFIG_DIR;
  if (cfgDir) {
    const base = path.basename(cfgDir);
    if (base.startsWith(".claude-")) {
      const id = base.slice(".claude-".length).trim();
      if (id && id !== "orch") return id;
    }
  }
  const label = process.env.CLAUDE_ACCOUNT_LABEL;
  if (!label) return undefined;
  const low = label.trim().toLowerCase();
  for (const acct of discoverClaudeAccounts()) {
    if (acct.id.toLowerCase() === low || acct.label.toLowerCase() === low) {
      return acct.id;
    }
  }
  const token = low.split(/[\s·]+/)[0];
  return token || undefined;
}

function parseKdlAccounts(home: string): ClaudeAccountProfile[] {
  const kdlPath = path.join(home, ".config/zellij/layouts/claude4.kdl");
  if (!existsSync(kdlPath)) return [];
  try {
    const text = readFileSync(kdlPath, "utf8");
    const out: ClaudeAccountProfile[] = [];
    const blockRe = /pane\s+name="([^"]+)"\s+command="claude-acct"\s*\{\s*args\s+([^\n}]+)\s*\}/g;
    for (const match of text.matchAll(blockRe)) {
      const paneTitle = match[1]!.trim();
      const argTokens = [...match[2]!.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
      if (argTokens.length >= 4) {
        const [configDir, email, plan, label, wsRoot] = argTokens;
        const base = path.basename(configDir!);
        const id = base.startsWith(".claude-") ? base.slice(".claude-".length) : base;
        if (!id || id === "orch") continue;
        out.push({
          id,
          label: label || id,
          pane: paneTitle,
          configDir: configDir!,
          workspaceRoot: wsRoot || path.join(home, "claude-ws", id),
          email: email || undefined,
          plan: plan || undefined,
          model: "opus",
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Auto-discovers isolated Claude account profiles from:
 * 1. ~/.switchboard/accounts.json
 * 2. ~/.config/zellij/layouts/claude4.kdl (if present)
 * 3. ~/.claude-<id> directories on disk
 */
export function discoverClaudeAccounts(
  home = homedir(),
  sbHome = switchboardHome(),
): ClaudeAccountProfile[] {
  const byId = new Map<string, ClaudeAccountProfile>();

  for (const saved of readSavedAccounts(sbHome)) {
    byId.set(saved.id, saved);
  }
  for (const kdlAcct of parseKdlAccounts(home)) {
    if (!byId.has(kdlAcct.id)) {
      byId.set(kdlAcct.id, kdlAcct);
    }
  }
  try {
    for (const entry of readdirSync(home, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(".claude-")) continue;
      const id = entry.name.slice(".claude-".length).trim();
      if (!id || id === "orch" || byId.has(id)) continue;
      const configDir = path.join(home, entry.name);
      let email: string | undefined;
      try {
        const cfgJson = JSON.parse(readFileSync(path.join(configDir, ".claude.json"), "utf8"));
        email = cfgJson?.oauthAccount?.emailAddress;
      } catch {
        // Ignore unreadable .claude.json
      }
      const label = id.toUpperCase();
      const pane = email ? `${label} · ${email.split("@")[0]}` : `Claude · ${id}`;
      byId.set(id, {
        id,
        label,
        pane,
        configDir,
        workspaceRoot: path.join(home, "claude-ws", id),
        email,
        model: "opus",
      });
    }
  } catch {
    // Ignore readdir errors
  }

  return [...byId.values()];
}

/**
 * Builds or normalizes a profile from a short slug (e.g. "pi", "acct1") or "id:email:plan".
 */
export function buildAccountProfile(
  spec: string,
  existing: ClaudeAccountProfile[],
  home = homedir(),
): ClaudeAccountProfile {
  const parts = spec.trim().split(":");
  const rawId = parts[0]!.replace(/^claude[-:]/i, "").trim().toLowerCase();
  const found = existing.find((item) => item.id.toLowerCase() === rawId);
  if (found && parts.length === 1) return found;
  const email = parts[1]?.trim() || found?.email;
  const plan = parts[2]?.trim() || found?.plan || "max";
  const label = found?.label || rawId.toUpperCase();
  const pane = found?.pane || (email ? `${label} · ${email.split("@")[0]} (${plan})` : `Claude · ${rawId}`);
  return {
    id: rawId,
    label,
    pane,
    configDir: found?.configDir || path.join(home, `.claude-${rawId}`),
    workspaceRoot: found?.workspaceRoot || path.join(home, "claude-ws", rawId),
    email,
    plan,
    model: found?.model || "opus",
  };
}

const SHARED_CLAUDE_ITEMS = [
  "settings.json",
  "CLAUDE.md",
  "skills",
  "agents",
  "hooks",
  "statusline-command.sh",
];

/**
 * Provisions an isolated Claude account environment:
 * 1. Creates ~/.claude-<id> and links shared settings/skills/agents/hooks from ~/.claude
 * 2. Registers Switchboard MCP server in ~/.claude-<id>/.claude.json with SWITCHBOARD_NAME=<id>
 * 3. Creates ~/claude-ws/<id> and (when targetRepo is a git repo) provisions an isolated git worktree
 *    at ~/claude-ws/<id>/<repoName> on branch ws/<id>.
 */
export function provisionClaudeAccount(
  profile: ClaudeAccountProfile,
  opts: {
    targetRepo?: string;
    cliPath: string;
    nodePath?: string;
    home?: string;
  },
): { worktreeDir: string; notes: string[] } {
  const home = opts.home ?? homedir();
  const baseClaudeDir = path.join(home, ".claude");
  const notes: string[] = [];

  mkdirSync(profile.configDir, { recursive: true });
  mkdirSync(profile.workspaceRoot, { recursive: true });

  // 1. Symlink shared items from ~/.claude into ~/.claude-<id>
  for (const item of SHARED_CLAUDE_ITEMS) {
    const src = path.join(baseClaudeDir, item);
    const dst = path.join(profile.configDir, item);
    if (!existsSync(src)) continue;
    try {
      const st = lstatSync(dst);
      if (!st.isSymbolicLink()) {
        const bak = `${dst}.bak-${Date.now()}`;
        renameSync(dst, bak);
        symlinkSync(src, dst);
        notes.push(`re-linked ${dst} -> ${src}`);
      }
    } catch {
      try {
        symlinkSync(src, dst);
        notes.push(`linked ${dst} -> ${src}`);
      } catch {
        // Ignore if already linked concurrently
      }
    }
  }

  // 2. Ensure mcpServers.switchboard is configured in ~/.claude-<id>/.claude.json
  const claudeJsonPath = path.join(profile.configDir, ".claude.json");
  let claudeJson: Record<string, unknown> = {};
  if (existsSync(claudeJsonPath)) {
    try {
      claudeJson = JSON.parse(readFileSync(claudeJsonPath, "utf8")) as Record<string, unknown>;
    } catch {
      claudeJson = {};
    }
  }
  const mcpServers = (claudeJson.mcpServers ?? {}) as Record<string, unknown>;
  mcpServers.switchboard = {
    type: "stdio",
    command: opts.nodePath ?? process.execPath,
    args: [opts.cliPath, "mcp"],
    env: {
      SWITCHBOARD_NAME: profile.id,
      SWITCHBOARD_HARNESS: "claude",
      SWITCHBOARD_SCOPE: "share",
    },
  };
  claudeJson.mcpServers = mcpServers;
  const tmpJson = `${claudeJsonPath}.tmp-${process.pid}`;
  writeFileSync(tmpJson, `${JSON.stringify(claudeJson, null, 2)}\n`);
  renameSync(tmpJson, claudeJsonPath);
  notes.push(`mcp switchboard -> ${claudeJsonPath} (name=${profile.id})`);

  // 3. Ensure workspace CLAUDE.md exists
  const wsClaudeMd = path.join(profile.workspaceRoot, "CLAUDE.md");
  if (!existsSync(wsClaudeMd)) {
    const emailNote = profile.email ? ` (${profile.email})` : "";
    writeFileSync(
      wsClaudeMd,
      `# ${profile.label} workspace\n\nYou are running as isolated account **${profile.id}**${emailNote} (\`CLAUDE_CONFIG_DIR=${profile.configDir}\`, \`SWITCHBOARD_NAME=${profile.id}\`).\n`,
    );
  }

  // 4. Provision isolated git worktree for targetRepo if inside a git repository
  let worktreeDir = profile.workspaceRoot;
  if (opts.targetRepo) {
    const repoRoot = gitRepoRoot(opts.targetRepo);
    const repoName = path.basename(repoRoot);
    const candidateWt = path.join(profile.workspaceRoot, repoName);
    if (existsSync(path.join(repoRoot, ".git"))) {
      if (!existsSync(candidateWt)) {
        const branch = `ws/${profile.id}`;
        try {
          const hasBranch =
            execFileSync("git", ["-C", repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
              stdio: "ignore",
            }) === undefined;
          if (hasBranch) {
            execFileSync("git", ["-C", repoRoot, "worktree", "add", candidateWt, branch], { stdio: "ignore" });
          }
        } catch {
          try {
            execFileSync("git", ["-C", repoRoot, "worktree", "add", "-b", `ws/${profile.id}`, candidateWt], {
              stdio: "ignore",
            });
          } catch {
            // If branch is already checked out or worktree add fails, fall back to candidateWt if present
          }
        }
        if (existsSync(candidateWt)) {
          notes.push(`worktree ${candidateWt} (branch ws/${profile.id})`);
        }
      }
      if (existsSync(candidateWt)) {
        worktreeDir = candidateWt;
        const localSettingsSrc = path.join(repoRoot, ".claude/settings.local.json");
        const localSettingsDst = path.join(candidateWt, ".claude/settings.local.json");
        if (existsSync(localSettingsSrc) && !existsSync(localSettingsDst)) {
          mkdirSync(path.dirname(localSettingsDst), { recursive: true });
          copyFileSync(localSettingsSrc, localSettingsDst);
        }
      }
    }
  }

  return { worktreeDir, notes };
}

/**
 * Generates a Zellij PaneSpec for an isolated Claude account using Switchboard's native `claude-pane` runner.
 */
export function claudeProfilePaneSpec(
  profile: ClaudeAccountProfile,
  opts: {
    targetRepo: string;
    resume: boolean;
    cliPath: string;
    nodePath?: string;
  },
): PaneSpec {
  const repoRoot = gitRepoRoot(opts.targetRepo);
  const repoName = path.basename(repoRoot);
  const wsRepo = path.join(profile.workspaceRoot, repoName);
  const cwd = existsSync(wsRepo) ? wsRepo : profile.workspaceRoot;
  const args = [
    opts.cliPath,
    "claude-pane",
    "--account",
    profile.id,
    "--config-dir",
    profile.configDir,
    "--label",
    profile.label,
    "--cwd",
    cwd,
  ];
  if (profile.email) args.push("--email", profile.email);
  if (profile.plan) args.push("--plan", profile.plan);
  if (profile.model) args.push("--model", profile.model);
  if (opts.resume) args.push("--resume");
  return {
    name: profile.pane,
    command: opts.nodePath ?? process.execPath,
    args,
  };
}

function resolveClaudeBin(): string {
  const localClaude = path.join(homedir(), ".local/bin/claude");
  if (existsSync(localClaude)) return localClaude;
  try {
    const found = execFileSync("which", ["claude"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (found) return found;
  } catch {
    // Fall back to bare claude
  }
  return "claude";
}

function checkClaudeAuth(
  claudeBin: string,
  wantEmail?: string,
  wantPlan?: string,
): { ok: boolean; email: string; plan: string } {
  try {
    const raw = execFileSync(claudeBin, ["auth", "status"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = JSON.parse(raw) as { email?: string; subscriptionType?: string };
    const email = parsed.email || "";
    const plan = parsed.subscriptionType || "";
    const emailOk = !wantEmail || email === wantEmail;
    const planOk = !wantPlan || plan === wantPlan;
    return { ok: Boolean(email && emailOk && planOk), email, plan };
  } catch {
    return { ok: false, email: "", plan: "" };
  }
}

function resolveRecordedSessionId(configDir: string, cwd: string): { flag: string[] } {
  const slug = cwd.replace(/[^A-Za-z0-9]/g, "-");
  const sessionFile = path.join(configDir, "claude4-sessions", `${slug}.json`);
  const projectsDir = path.join(configDir, "projects", slug);
  try {
    if (existsSync(sessionFile)) {
      const data = JSON.parse(readFileSync(sessionFile, "utf8")) as { session_id?: string };
      const sid = data.session_id;
      if (sid && existsSync(path.join(projectsDir, `${sid}.jsonl`))) {
        return { flag: ["--resume", sid] };
      }
    }
    if (existsSync(projectsDir)) {
      const hasJsonl = readdirSync(projectsDir).some((name) => name.endsWith(".jsonl"));
      if (hasJsonl) return { flag: ["--continue"] };
    }
  } catch {
    // Ignore lookup failure
  }
  return { flag: [] };
}

/**
 * Native runner invoked inside each isolated Claude account Zellij pane (`switchboard claude-pane`).
 */
export async function runClaudePane(opts: {
  account: string;
  configDir: string;
  label: string;
  cwd: string;
  cliPath: string;
  email?: string;
  plan?: string;
  model?: string;
  resume?: boolean;
}): Promise<void> {
  const defaultWsRoot = path.join(homedir(), "claude-ws", opts.account);
  const wsRoot = opts.cwd.startsWith(defaultWsRoot) ? defaultWsRoot : defaultWsRoot;
  const profile: ClaudeAccountProfile = {
    id: opts.account,
    label: opts.label || opts.account,
    pane: opts.label || opts.account,
    configDir: opts.configDir,
    workspaceRoot: wsRoot,
    email: opts.email,
    plan: opts.plan,
    model: opts.model || "opus",
  };

  const { worktreeDir } = provisionClaudeAccount(profile, {
    targetRepo: opts.cwd,
    cliPath: opts.cliPath,
  });

  const targetDir = existsSync(worktreeDir) ? worktreeDir : opts.cwd;
  if (existsSync(targetDir)) {
    process.chdir(targetDir);
  }

  const localBin = path.join(homedir(), ".local/bin");
  if (!(process.env.PATH ?? "").split(path.delimiter).includes(localBin)) {
    process.env.PATH = `${localBin}${path.delimiter}${process.env.PATH ?? ""}`;
  }
  const claudeBin = resolveClaudeBin();

  process.env.CLAUDE_CONFIG_DIR = opts.configDir;
  process.env.CLAUDE_ACCOUNT_LABEL = opts.label;
  process.env.SWITCHBOARD_NAME = opts.account;
  process.env.SWITCHBOARD_HARNESS = "claude";
  process.env.SWITCHBOARD_SCOPE = "share";

  if (opts.email) {
    let status = checkClaudeAuth(claudeBin, opts.email, opts.plan);
    while (!status.ok && stdin.isTTY) {
      stdout.write(
        `[${opts.label}] expected ${opts.email}${opts.plan ? ` (${opts.plan})` : ""}, got ${status.email || "nobody"}${status.plan ? ` (${status.plan})` : ""}\n`,
      );
      const rl = createInterface({ input: stdin, output: stdout });
      let answer = "";
      try {
        answer = (await rl.question("Press Enter to log in (or 'q' to skip): ")).trim().toLowerCase();
      } finally {
        rl.close();
      }
      if (answer === "q") break;
      try {
        execFileSync(claudeBin, ["auth", "logout"], { stdio: "ignore" });
      } catch {
        // Ignore logout errors
      }
      execFileSync(claudeBin, ["auth", "login", "--email", opts.email], { stdio: "inherit" });
      status = checkClaudeAuth(claudeBin, opts.email, opts.plan);
    }
    if (status.ok) {
      stdout.write(`[${opts.label}] logged in as ${status.email} (${status.plan})\n`);
    }
  }

  const wantResume = Boolean(opts.resume || process.env.CLAUDE4_CONTINUE === "1");
  const resumeArgs = wantResume ? resolveRecordedSessionId(opts.configDir, process.cwd()).flag : [];
  const sessionName = `${opts.label} · ${path.basename(process.cwd())}`;
  const claudeArgs = [
    ...resumeArgs,
    "--dangerously-skip-permissions",
    "--model",
    opts.model || process.env.CLAUDE_ACCT_MODEL || "opus",
    "--name",
    sessionName,
    "--remote-control",
    sessionName,
  ];

  await new Promise<void>((resolve) => {
    const child = spawn(claudeBin, claudeArgs, {
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", () => resolve());
    child.on("error", () => resolve());
  });
}
