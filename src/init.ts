import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  buildAccountProfile,
  claudeProfilePaneSpec,
  discoverClaudeAccounts,
  provisionClaudeAccount,
  writeSavedAccounts,
  type ClaudeAccountProfile,
} from "./accounts.ts";
import { switchboardHome } from "./paths.ts";
import { gitRepoRoot, repoKey } from "./repo.ts";
import type { RatioBinding } from "./types.ts";

export type RepoConfig = {
  repoKey: string;
  repoRoot: string;
  orchestrator: string;
  ratioProject?: string;
  panes?: string[];
  claude4?: boolean;
  accounts?: string[];
  updatedAt: number;
};

export function repoConfigPath(key: string, home = switchboardHome()): string {
  return path.join(home, "repos", `${key}.json`);
}

export function readRepoConfigByKey(key: string, home = switchboardHome()): RepoConfig | null {
  if (!key) return null;
  const file = repoConfigPath(key, home);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as RepoConfig;
  } catch {
    return null;
  }
}

export function readRepoConfig(cwd: string, home = switchboardHome()): RepoConfig | null {
  return readRepoConfigByKey(repoKey(cwd), home);
}

export function writeRepoConfig(
  cwd: string,
  update: { orchestrator?: string; ratioProject?: string; panes?: string[]; claude4?: boolean; accounts?: string[] },
  home = switchboardHome(),
): RepoConfig {
  const key = repoKey(cwd);
  const root = gitRepoRoot(cwd);
  const existing = readRepoConfig(cwd, home);
  const next: RepoConfig = {
    repoKey: key,
    repoRoot: root,
    orchestrator: update.orchestrator ?? existing?.orchestrator ?? "cursor",
    ratioProject: update.ratioProject ?? existing?.ratioProject,
    panes: update.panes ?? existing?.panes,
    claude4: update.claude4 ?? existing?.claude4,
    accounts: update.accounts ?? existing?.accounts,
    updatedAt: Date.now(),
  };
  const dir = path.join(home, "repos");
  mkdirSync(dir, { recursive: true });
  writeFileSync(repoConfigPath(key, home), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function extractRatioHeaders(
  headers: Record<string, unknown> | undefined | null,
  source: string,
  defaultProfile?: string | null,
): RatioBinding | null {
  if (!headers || typeof headers !== "object") return null;
  let project: string | null = null;
  let profile: string | null = defaultProfile ?? null;
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v !== "string" || !v.trim()) continue;
    const lower = k.toLowerCase();
    if (lower === "x-ratio-project") project = v.trim();
    else if (lower === "x-ratio-profile" || lower === "x-ratio-subject") profile = v.trim();
  }
  if (!project) return null;
  return { project, profile, source };
}

function extractRatioFromMcpJson(
  filePath: string,
  source: string,
  defaultProfile?: string | null,
  projectCwd?: string,
): RatioBinding | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, any>;
    if (projectCwd && raw?.projects && typeof raw.projects === "object") {
      const projEntry = raw.projects[projectCwd]?.mcpServers?.ratio;
      const fromProj = extractRatioHeaders(projEntry?.headers, `${source}[${path.basename(projectCwd)}]`, defaultProfile);
      if (fromProj) return fromProj;
    }
    const topRatio = raw?.mcpServers?.ratio;
    return extractRatioHeaders(topRatio?.headers, source, defaultProfile);
  } catch {
    return null;
  }
}

function extractRatioFromToml(
  filePath: string,
  source: string,
  defaultProfile?: string | null,
): RatioBinding | null {
  if (!existsSync(filePath)) return null;
  try {
    const txt = readFileSync(filePath, "utf8");
    const ratioSections = [...txt.matchAll(/\[mcp_servers\.ratio(?:\.[^\]]+)?\]([\s\S]*?)(?=\n\[|$)/g)];
    if (ratioSections.length === 0) return null;
    const combined = ratioSections.map((m) => m[1] ?? "").join("\n");
    const projMatch = /["']?[Xx]-[Rr]atio-[Pp]roject["']?\s*=\s*["']([^"']+)["']/.exec(combined);
    const profMatch = /["']?[Xx]-[Rr]atio-(?:[Pp]rofile|[Ss]ubject)["']?\s*=\s*["']([^"']+)["']/.exec(combined);
    if (!projMatch?.[1]?.trim()) {
      return {
        project: "unpinned",
        profile: profMatch?.[1]?.trim() || defaultProfile || null,
        source: `${source}(no-header)`,
      };
    }
    return {
      project: projMatch[1].trim(),
      profile: profMatch?.[1]?.trim() || defaultProfile || null,
      source,
    };
  } catch {
    return null;
  }
}

export function discoverRatioBinding(opts: {
  cwd: string;
  harness: string;
  name: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}): RatioBinding | null {
  if (!opts.cwd || opts.cwd === "/" || !existsSync(opts.cwd)) return null;
  const env = opts.env ?? process.env;
  const envProj = env.SWITCHBOARD_RATIO_PROJECT?.trim() || env.RATIO_PROJECT?.trim();
  if (envProj) {
    return {
      project: envProj,
      profile: env.SWITCHBOARD_RATIO_PROFILE?.trim() || env.RATIO_PROFILE?.trim() || null,
      source: "env",
    };
  }

  const isMainCheckoutRoot = (() => {
    try {
      return statSync(path.join(opts.cwd, ".git")).isDirectory();
    } catch {
      return false;
    }
  })();
  const splitRoot = isMainCheckoutRoot ? opts.cwd : gitRepoRoot(opts.cwd, "split");
  const sharedRoot = isMainCheckoutRoot ? opts.cwd : gitRepoRoot(opts.cwd, "share");
  const candidateRoots = [...new Set([splitRoot, sharedRoot].filter(Boolean))];
  const claudeProfile = opts.harness === "claude" ? (opts.name !== "claude" ? opts.name : "default") : null;

  // 1. Check repository-local MCP config files in harness precedence order (worktree root first, then shared root)
  for (const root of candidateRoots) {
    if (opts.harness === "cursor") {
      const cur = extractRatioFromMcpJson(path.join(root, ".cursor", "mcp.json"), "repo:.cursor/mcp.json");
      if (cur) return cur;
    } else if (opts.harness === "codex") {
      const cdx = extractRatioFromToml(path.join(root, ".codex", "config.toml"), "repo:.codex/config.toml");
      if (cdx) return cdx;
    } else if (opts.harness === "grok") {
      const grk = extractRatioFromMcpJson(path.join(root, ".grok", "mcp.json"), "repo:.grok/mcp.json");
      if (grk) return grk;
    } else if (opts.harness === "muse") {
      const mse = extractRatioFromMcpJson(path.join(root, ".muse", "mcp.json"), "repo:.muse/mcp.json");
      if (mse) return mse;
    }
    const repoMcp = extractRatioFromMcpJson(path.join(root, ".mcp.json"), "repo:.mcp.json", claudeProfile);
    if (repoMcp) return repoMcp;
  }

  // 2. Check user-level harness MCP config files (isolated in tests when SWITCHBOARD_HOME is set unless home is passed)
  if (opts.home === undefined && env.SWITCHBOARD_HOME) return null;
  const userHome = opts.home ?? homedir();

  if (opts.harness === "antigravity") {
    return extractRatioFromMcpJson(
      path.join(userHome, ".gemini", "antigravity", "mcp_config.json"),
      "home:antigravity/mcp_config.json",
    );
  }
  if (opts.harness === "cursor") {
    return extractRatioFromMcpJson(path.join(userHome, ".cursor", "mcp.json"), "home:.cursor/mcp.json");
  }
  if (opts.harness === "codex") {
    const codexHome = env.CODEX_HOME || path.join(userHome, ".codex");
    return extractRatioFromToml(path.join(codexHome, "config.toml"), "home:.codex/config.toml");
  }
  if (opts.harness === "claude") {
    for (const root of candidateRoots) {
      if (opts.name && opts.name !== "claude") {
        const isolatedFile = path.join(userHome, `.claude-${opts.name}`, ".claude.json");
        const fromIsolated = extractRatioFromMcpJson(isolatedFile, `home:.claude-${opts.name}`, opts.name, root);
        if (fromIsolated) return fromIsolated;
      }
      const fromMain = extractRatioFromMcpJson(path.join(userHome, ".claude.json"), "home:.claude.json", claudeProfile, root);
      if (fromMain) return fromMain;
    }
    return null;
  }
  if (opts.harness === "grok") {
    for (const f of ["mcp.json", "settings.json", "user-settings.json"]) {
      const found = extractRatioFromMcpJson(path.join(userHome, ".grok", f), `home:.grok/${f}`);
      if (found) return found;
    }
    return null;
  }
  if (opts.harness === "kimi") {
    return extractRatioFromMcpJson(path.join(userHome, ".kimi", "mcp.json"), "home:.kimi/mcp.json");
  }
  if (opts.harness === "muse") {
    const fromJson = extractRatioFromMcpJson(path.join(userHome, ".muse", "mcp.json"), "home:.muse/mcp.json");
    if (fromJson) return fromJson;
    return extractRatioFromToml(path.join(userHome, ".muse", "config.toml"), "home:.muse/config.toml");
  }
  return null;
}

export function formatRatioBinding(ratio?: RatioBinding | null): string {
  if (!ratio?.project) return "";
  const prof = ratio.profile ? `(${ratio.profile})` : "";
  return `ratio=${ratio.project}${prof}[${ratio.source}]`;
}

export function resolveOrchestratorName(input: string, fallback = "cursor"): string {
  const trimmed = input.trim();
  if (!trimmed) return fallback;
  const raw = trimmed.toLowerCase();
  if (raw === "antigravity" || raw === "argon" || raw === "argon4" || raw === "argon-4") return "agy";
  if (raw === "orchestrator" || raw === "cursor-agent") return "cursor";
  if (raw === "kimi-cli") return "kimi";
  return trimmed;
}

/**
 * Resolves the effective repo working directory for an MCP shim process.
 * macOS GUI apps (Antigravity Desktop, Codex Desktop) launch child processes with cwd="/".
 * When cwd is not inside a git repository, falls back to SWITCHBOARD_CWD or the most recently
 * configured repository in ~/.switchboard/repos/*.json.
 */
export function resolveShimCwd(cwd = process.cwd(), home = switchboardHome()): string {
  const envCwd = process.env.SWITCHBOARD_CWD?.trim() || process.env.CLAUDE_PROJECT_DIR?.trim();
  if (envCwd && existsSync(envCwd)) return envCwd;
  const root = gitRepoRoot(cwd);
  if (cwd !== "/" && existsSync(path.join(root, ".git"))) {
    return cwd;
  }
  const reposDir = path.join(home, "repos");
  if (existsSync(reposDir)) {
    try {
      const valid: RepoConfig[] = [];
      for (const name of readdirSync(reposDir)) {
        if (!name.endsWith(".json")) continue;
        const cfg = JSON.parse(readFileSync(path.join(reposDir, name), "utf8")) as RepoConfig;
        if (cfg?.repoRoot && existsSync(cfg.repoRoot)) {
          valid.push(cfg);
        }
      }
      if (valid.length === 1) return valid[0]!.repoRoot;
    } catch {
      // Fall back to cwd
    }
  }
  return cwd;
}

export const GRID_SESSION = "switchboard";

/**
 * Computes a deterministic, human-readable Zellij session name per repository checkout
 * so working across 3-4 projects concurrently never collides on a single global grid.
 */
export function gridSessionName(cwd?: string): string {
  if (!cwd || cwd === "/") return GRID_SESSION;
  const root = gitRepoRoot(cwd);
  const slug =
    path
      .basename(root)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "repo";
  const shortHash = repoKey(cwd).slice(0, 6);
  return `switchboard-${slug}-${shortHash}`;
}

export type GridPlan =
  | { action: "attach"; session: string }
  | { action: "start"; session: string; layout: string; deleteFirst: boolean };

/** What `switchboard` or `switchboard --resume` should do with the Zellij session. */
export function gridPlan(
  resume: boolean,
  sessionLine: string | null,
  layoutDir: string,
  opts: { cwd?: string; restart?: boolean } = {},
): GridPlan {
  const session = opts.cwd ? gridSessionName(opts.cwd) : GRID_SESSION;
  let layoutName = resume || opts.restart ? "switchboard-resume.kdl" : "switchboard.kdl";
  if (opts.cwd) {
    const key = repoKey(opts.cwd);
    const repoCandidate = path.join(
      layoutDir,
      resume || opts.restart ? `switchboard-${key}-resume.kdl` : `switchboard-${key}.kdl`,
    );
    if (existsSync(repoCandidate)) {
      layoutName = path.basename(repoCandidate);
    }
  }
  const layout = path.join(layoutDir, layoutName);
  if (!opts.restart && sessionLine && !sessionLine.includes("EXITED")) {
    return { action: "attach", session };
  }
  return {
    action: "start",
    session,
    layout,
    deleteFirst: Boolean(sessionLine),
  };
}

const BEGIN = "# >>> switchboard >>>";
const END = "# <<< switchboard <<<";

export type PaneSpec = {
  name: string;
  command?: string;
  args?: string[];
};

type HarnessDef = {
  id: string;
  pane: string;
  aliases: string[];
  /** Tried in order. The first entry is the command written when no lookup is done. */
  candidates: string[];
  pathNames: string[];
  args: string[];
  resume: string[];
  shell?: boolean;
};

function homeBin(name: string): string {
  return path.join(homedir(), ".local/bin", name);
}

/** Pane order in the grid. Bus is a shell and needs no CLI. */
export const HARNESSES: HarnessDef[] = [
  {
    id: "orchestrator",
    pane: "Orchestrator",
    aliases: ["cursor", "cursor-agent"],
    candidates: [homeBin("cursor-agent")],
    pathNames: ["cursor-agent"],
    args: ["--yolo", "--approve-mcps", "--trust"],
    resume: ["--continue"],
  },
  {
    id: "grok",
    pane: "Grok",
    aliases: [],
    candidates: [path.join(homedir(), ".grok/bin/grok")],
    pathNames: ["grok"],
    args: ["--always-approve", "--model", "grok-4.7", "--reasoning-effort", "xhigh"],
    resume: ["--continue"],
  },
  {
    id: "claude",
    pane: "Claude",
    aliases: [],
    candidates: [homeBin("claude")],
    pathNames: ["claude"],
    args: ["--dangerously-skip-permissions", "--model", "fable"],
    resume: ["--continue"],
  },
  {
    id: "codex",
    pane: "Codex",
    aliases: [],
    candidates: ["/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"],
    pathNames: ["codex"],
    args: ["--dangerously-bypass-approvals-and-sandbox", "--model", "gpt-6.1-sol"],
    resume: ["resume", "--last"],
  },
  {
    id: "kimi",
    pane: "Kimi",
    aliases: ["kimi-cli"],
    candidates: [homeBin("kimi-cli")],
    pathNames: ["kimi-cli"],
    args: ["--yolo"],
    resume: ["--continue"],
  },
  {
    id: "muse",
    pane: "Muse",
    aliases: [],
    candidates: [homeBin("muse")],
    pathNames: ["muse"],
    args: ["--yolo", "--model", "muse-wonder-1.0", "--reasoning-effort", "xhigh"],
    resume: ["resume", "--last"],
  },
  {
    id: "antigravity",
    pane: "Antigravity",
    aliases: ["agy"],
    candidates: [homeBin("agy")],
    pathNames: ["agy"],
    args: ["--dangerously-skip-permissions", "--mode", "auto"],
    resume: ["--continue"],
  },
  { id: "bus", pane: "Bus", aliases: ["shell"], candidates: [], pathNames: [], args: [], resume: [], shell: true },
];

export type PaneChoice = {
  index: number;
  id: string;
  pane: string;
  found: boolean;
  command: string | null;
};

function commandOnPath(name: string): string | null {
  try {
    const found = execFileSync("which", [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return found || null;
  } catch {
    return null;
  }
}

function locate(def: HarnessDef): string | null {
  if (def.shell) return null;
  const extra = def.id === "codex" ? process.env.SWITCHBOARD_CODEX_BIN : undefined;
  for (const candidate of [extra, ...def.candidates]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  for (const name of def.pathNames) {
    const found = commandOnPath(name);
    if (found) return found;
  }
  return null;
}

/** Commands are absolute so a Zellij pane does not depend on a login PATH. */
export function harnessPanes(resume = false): PaneSpec[] {
  return HARNESSES.map((def) => paneFrom(def, resume, def.candidates[0] ?? null));
}

export function gridChoices(): PaneChoice[] {
  return HARNESSES.map((def, index) => {
    const command = def.shell ? null : locate(def);
    return { index: index + 1, id: def.id, pane: def.pane, found: Boolean(def.shell || command), command };
  });
}

export type InvitedAgentSpec = {
  name: string;
  harness: string;
  command: string | null;
  args: string[];
};

export function resolveInvitedAgentSpec(rawName: string, home = homedir()): InvitedAgentSpec | null {
  const token = rawName.trim().toLowerCase();
  if (!token || token === "bus" || token === "shell") return null;
  const canonicalName =
    token === "antigravity" || token === "argon" || token === "argon4"
      ? "agy"
      : token === "cursor-agent" || token === "orchestrator"
        ? "cursor"
        : token === "kimi-cli"
          ? "kimi"
          : token;
  const defId =
    canonicalName === "agy"
      ? "antigravity"
      : canonicalName === "cursor"
        ? "orchestrator"
        : canonicalName;
  let def = HARNESSES.find((item) => item.id === defId || item.aliases.includes(token));
  let harness =
    canonicalName === "agy"
      ? "antigravity"
      : canonicalName === "cursor"
        ? "cursor"
        : def?.id ?? canonicalName;
  if (!def && existsSync(path.join(home, `.claude-${canonicalName}`))) {
    def = HARNESSES.find((item) => item.id === "claude");
    harness = "claude";
  }
  if (!def || def.shell) return null;
  const command = locate(def) ?? def.candidates[0] ?? null;
  return {
    name: canonicalName,
    harness,
    command,
    args: def.args,
  };
}

export type SpawnTerminalTab = (spec: {
  cwd: string;
  name: string;
  harness: string;
  cmd: string;
  args: string[];
}) => Promise<string>;

export function isHarnessProcessInPsOutput(psOut: string, cmd: string, harness: string): boolean {
  const targetBin = path.basename(cmd).toLowerCase();
  const targetHarness = harness.toLowerCase();
  const shells = new Set(["login", "-zsh", "zsh", "-bash", "bash", "-sh", "sh", "ps"]);
  for (const rawLine of psOut.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/).filter((tok) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok));
    if (tokens.length === 0) continue;
    const firstBin = path.basename(tokens[0]!).toLowerCase();
    if (!firstBin || shells.has(firstBin)) continue;
    for (const tok of tokens) {
      const base = path.basename(tok).toLowerCase();
      if (!base) continue;
      if (base.includes(targetBin) || base.includes(targetHarness)) {
        return true;
      }
    }
  }
  return false;
}

export function isActiveZellijGridSession(listSessionsOutput: string, sessionName: string): boolean {
  for (const rawLine of listSessionsOutput.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line === sessionName || line.startsWith(`${sessionName} `)) {
      return !line.includes("EXITED");
    }
  }
  return false;
}

function stripEnvQuotes(val: string): string {
  return val.replace(/^['"]|['"]$/g, "");
}

function hasZellijAgentEnv(line: string, zSession: string, agentName: string): boolean {
  const sMatch = /(?:^|\s)ZELLIJ_SESSION_NAME=([^\s]+)/.exec(line);
  if (!sMatch || stripEnvQuotes(sMatch[1]!) !== zSession) return false;
  const nMatch = /(?:^|\s)SWITCHBOARD_NAME=([^\s]+)/.exec(line);
  if (!nMatch || stripEnvQuotes(nMatch[1]!) !== agentName) return false;
  return true;
}

export function parseZellijPaneForInvitedAgent(
  psEwwOut: string,
  zSession: string,
  agentName: string,
  cmd: string,
  harness: string,
  ignorePids?: ReadonlySet<number>,
): string | null {
  for (const rawLine of psEwwOut.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const pidMatch = /^(\d+)\s+(.*)$/.exec(trimmed);
    const pid = pidMatch ? Number(pidMatch[1]) : null;
    if (pid !== null && ignorePids?.has(pid)) continue;
    const line = pidMatch ? pidMatch[2]! : trimmed;
    if (!hasZellijAgentEnv(line, zSession, agentName)) continue;
    const pMatch = /(?:^|\s)ZELLIJ_PANE_ID=([^\s]+)/.exec(line);
    if (!pMatch) continue;
    const paneId = stripEnvQuotes(pMatch[1]!);
    if (!/^\d+$/.test(paneId)) continue;
    if (isHarnessProcessInPsOutput(line, cmd, harness)) {
      return `zellij:${zSession}:${paneId}`;
    }
  }
  return null;
}

export const defaultSpawnTerminalTab: SpawnTerminalTab = async (spec) => {
  const envExports = [
    `SWITCHBOARD_CWD=${shellQuote(spec.cwd)}`,
    `SWITCHBOARD_NAME=${shellQuote(spec.name)}`,
    `SWITCHBOARD_HARNESS=${shellQuote(spec.harness)}`,
    "SWITCHBOARD_SCOPE=share",
  ];
  const claudeDir = path.join(homedir(), `.claude-${spec.name}`);
  if (spec.harness === "claude" && existsSync(claudeDir)) {
    envExports.push(`CLAUDE_CONFIG_DIR=${shellQuote(claudeDir)}`);
  }
  const cmdString = [spec.cmd, ...spec.args].map(shellQuote).join(" ");
  const shellLine = `cd ${shellQuote(spec.cwd)} && export ${envExports.join(" ")} && exec ${cmdString}`;

  const zSession = gridSessionName(spec.cwd);
  if (zSession && zSession !== GRID_SESSION) {
    let listOut = "";
    try {
      listOut = execFileSync("zellij", ["list-sessions", "--no-formatting"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      // Zellij not running or not installed; fall back to Terminal.app
    }
    if (isActiveZellijGridSession(listOut, zSession)) {
      try {
        const prePids = new Set<number>();
        try {
          const preOut = execFileSync("ps", ["eww", "-o", "pid=,command="], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          });
          for (const rawLine of preOut.split("\n")) {
            const m = /^(\d+)\s+(.*)$/.exec(rawLine.trim());
            if (!m) continue;
            const pid = Number(m[1]);
            const line = m[2]!;
            if (pid > 1 && hasZellijAgentEnv(line, zSession, spec.name)) {
              prePids.add(pid);
            }
          }
        } catch {
          // Best-effort snapshot of existing Zellij pane PIDs
        }
        execFileSync(
          "zellij",
          [
            "-s",
            zSession,
            "action",
            "new-pane",
            "--cwd",
            spec.cwd,
            "--name",
            spec.name,
            "--",
            "zsh",
            "-lc",
            shellLine,
          ],
          { stdio: ["ignore", "ignore", "ignore"] },
        );
        const zDeadline = Date.now() + 3000;
        while (Date.now() < zDeadline) {
          try {
            const psEww = execFileSync("ps", ["eww", "-o", "pid=,command="], {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "ignore"],
            });
            const paneSession = parseZellijPaneForInvitedAgent(
              psEww,
              zSession,
              spec.name,
              spec.cmd,
              spec.harness,
              prePids,
            );
            if (paneSession) return paneSession;
          } catch {
            // Keep polling until deadline
          }
          await new Promise((r) => setTimeout(r, 120));
        }
        try {
          const psPidOut = execFileSync("ps", ["eww", "-o", "pid=,command="], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          });
          for (const rawLine of psPidOut.split("\n")) {
            const m = /^(\d+)\s+(.*)$/.exec(rawLine.trim());
            if (!m) continue;
            const pid = Number(m[1]);
            const line = m[2]!;
            if (pid > 1 && !prePids.has(pid) && hasZellijAgentEnv(line, zSession, spec.name)) {
              try {
                process.kill(pid, "SIGTERM");
              } catch {
                // Ignore if already exited
              }
            }
          }
        } catch {
          // Best-effort cleanup of timed-out pane process
        }
        throw new Error(`Timed out waiting for ${spec.name} (${spec.harness}) to start in Zellij session ${zSession}`);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Timed out waiting for")) {
          throw err;
        }
        // If zellij action new-pane failed, fall through to Terminal.app
      }
    }
  }

  const script = [
    "on run argv",
    "  set launchCmd to item 1 of argv",
    '  tell application "Terminal"',
    "    set newTab to do script launchCmd",
    "    repeat 25 times",
    "      try",
    "        set tabTty to tty of newTab",
    '        if tabTty is not "" then',
    '          return "tty:" & tabTty',
    "        end if",
    "      end try",
    "      delay 0.1",
    "    end repeat",
    '    return "tty:" & (tty of newTab)',
    "  end tell",
    "end run",
  ].join("\n");
  const out = execFileSync("osascript", ["-e", script, shellLine], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!out.startsWith("tty:/dev/ttys")) {
    throw new Error(`Terminal.app did not return a valid tty (got: ${out || "empty"})`);
  }
  const shortTty = out.replace(/^tty:\/dev\//, "");
  const deadline = Date.now() + 3000;
  let matched = false;
  while (Date.now() < deadline) {
    try {
      const psOut = execFileSync("ps", ["-t", shortTty, "-o", "args="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (isHarnessProcessInPsOutput(psOut, spec.cmd, spec.harness)) {
        matched = true;
        break;
      }
    } catch {
      // Wait for TTY process table entry
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  if (!matched) {
    throw new Error(`Timed out waiting for ${spec.name} (${spec.harness}) to start on ${out}`);
  }
  return out;
};

/** Blank keeps the panes found here. "all" selects every pane, including ones that are not installed. */
export function chosenIds(answer: string, choices: PaneChoice[]): string[] {
  const text = answer.trim().toLowerCase();
  if (text === "" || text === "found") return choices.filter((choice) => choice.found).map((choice) => choice.id);
  if (text === "all") return choices.map((choice) => choice.id);
  const ids: string[] = [];
  for (const token of text.split(/[\s,]+/)) {
    if (!token) continue;
    const hit = choices.find((choice) => {
      const def = HARNESSES.find((item) => item.id === choice.id);
      const names = [String(choice.index), choice.id, choice.pane.toLowerCase(), ...(def?.aliases ?? [])];
      return names.includes(token);
    });
    if (hit && !ids.includes(hit.id)) ids.push(hit.id);
  }
  return ids;
}

export function resolveAccountProfiles(
  spec: string | undefined,
  useClaudeMulti: boolean,
  discovered = discoverClaudeAccounts(),
  home = homedir(),
): ClaudeAccountProfile[] {
  const raw = (spec ?? "").trim();
  if (!raw) {
    return useClaudeMulti ? discovered : [];
  }
  if (raw.toLowerCase() === "discovered" || raw.toLowerCase() === "all" || raw.toLowerCase() === "claude4") {
    return discovered;
  }
  if (/^\d+$/.test(raw)) {
    const count = Math.max(1, Math.min(12, Number(raw)));
    if (discovered.length >= count) return discovered.slice(0, count);
    const profiles = [...discovered];
    for (let i = profiles.length + 1; i <= count; i++) {
      profiles.push(buildAccountProfile(`acct${i}`, discovered, home));
    }
    return profiles;
  }
  const tokens = raw.split(/[\s,]+/).filter(Boolean);
  const picked = tokens.map((token) => discovered[Number(token) - 1]).filter((profile) => profile !== undefined);
  if (tokens.length > 0 && tokens.every((token) => /^\d+$/.test(token)) && picked.length === tokens.length) {
    return picked;
  }
  return tokens.map((token) => buildAccountProfile(token, discovered, home));
}

export function claudeAccountPanes(
  targetRepo: string,
  resume: boolean,
  profiles = discoverClaudeAccounts(),
  cliPath = path.join(repoRoot(), "dist/cli.js"),
): PaneSpec[] {
  return profiles.map((profile) =>
    claudeProfilePaneSpec(profile, {
      targetRepo,
      resume,
      cliPath,
    }),
  );
}

export function panesFor(
  ids: string[],
  resume: boolean,
  choices = gridChoices(),
  opts: {
    claude4?: boolean;
    accounts?: ClaudeAccountProfile[];
    targetRepo?: string;
    cliPath?: string;
  } = {},
): PaneSpec[] {
  const wanted = new Set(ids);
  const out: PaneSpec[] = [];
  const profiles =
    opts.accounts && opts.accounts.length > 0
      ? opts.accounts
      : opts.claude4
        ? discoverClaudeAccounts()
        : [];
  const cliPath = opts.cliPath ?? path.join(repoRoot(), "dist/cli.js");
  for (const def of HARNESSES) {
    if (!wanted.has(def.id)) continue;
    if (def.id === "claude" && profiles.length > 0 && opts.targetRepo) {
      out.push(...claudeAccountPanes(opts.targetRepo, resume, profiles, cliPath));
      continue;
    }
    const foundCmd = choices.find((choice) => choice.id === def.id)?.command;
    if (!def.shell && !foundCmd) continue;
    const cmd = foundCmd ?? def.candidates[0] ?? null;
    if (resume && opts.targetRepo && cmd && !def.shell && def.resume.length > 0) {
      out.push({
        name: def.pane,
        command: process.execPath,
        args: [
          cliPath,
          "harness-pane",
          "--command",
          cmd,
          "--args",
          JSON.stringify(def.args),
          "--resume-args",
          JSON.stringify(def.resume),
          "--cwd",
          gitRepoRoot(opts.targetRepo),
        ],
      });
      continue;
    }
    out.push(paneFrom(def, resume, cmd));
  }
  return out.length > 0 ? out : [{ name: "Bus" }];
}

function paneFrom(def: HarnessDef, resume: boolean, command: string | null): PaneSpec {
  if (def.shell || !command) return { name: def.pane };
  const args = resume ? [...def.args, ...def.resume] : def.args;
  return { name: def.pane, command, args };
}

export function switchboardLayout(repo: string, panes = harnessPanes()): string {
  const row = (items: PaneSpec[]) => {
    const body = items.map(paneBlock).join("\n");
    return `            pane split_direction="vertical" {\n${body}\n            }`;
  };
  const usable = panes.length > 0 ? panes : [{ name: "Bus" }];
  const mid = Math.ceil(usable.length / 2);
  const rows = [usable.slice(0, mid), usable.slice(mid)].filter((items) => items.length > 0);
  return `layout {
    default_tab_template {
        pane size=1 borderless=true {
            plugin location="zellij:tab-bar"
        }
        children
        pane size=2 borderless=true {
            plugin location="zellij:status-bar"
        }
    }
    tab name="switchboard" cwd=${JSON.stringify(repo)} {
        pane split_direction="horizontal" {
${rows.map(row).join("\n")}
        }
    }
}
`;
}

export function zshLauncher(cli: string): string {
  return `# switchboard              attach the per-repo grid, or start fresh sessions (switchboard.kdl)
# switchboard --resume    attach, or continue each harness's latest session in this repo (switchboard-resume.kdl)
# switchboard -c          same as --resume
# switchboard who         the bus CLI
switchboard() {
  if [[ \$1 == --resume || \$1 == -c || \$1 == --continue ]]; then
    shift
    command node ${shellQuote(cli)} --resume "\$@"
    return
  fi
  if (( \$# )); then
    command node ${shellQuote(cli)} "\$@"
    return
  fi
  command node ${shellQuote(cli)} start
}`;
}

function paneBlock(pane: PaneSpec): string {
  const indent = "                ";
  const nameStr = JSON.stringify(pane.name);
  if (!pane.command) return `${indent}pane name=${nameStr}`;
  const cmdStr = JSON.stringify(pane.command);
  if (!pane.args?.length) return `${indent}pane name=${nameStr} command=${cmdStr}`;
  const args = pane.args.map((arg) => JSON.stringify(arg)).join(" ");
  return `${indent}pane name=${nameStr} command=${cmdStr} {\n                    args ${args}\n${indent}}`;
}

export function upsertZshBlock(existing: string, body: string): string {
  const block = `${BEGIN}\n${body}\n${END}\n`;
  const start = existing.indexOf(BEGIN);
  const end = existing.indexOf(END);
  if (start !== -1 && end > start) {
    const head = existing.slice(0, start).replace(/\s*$/, "");
    const tail = existing.slice(end + END.length).replace(/^\n*/, "");
    return `${head}${head ? "\n\n" : ""}${block}${tail}`;
  }
  const base = existing.length === 0 || existing.endsWith("\n") ? existing : `${existing}\n`;
  return `${base}\n${block}`;
}

export function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function upsertCodexHooks(
  cliPath: string,
  hooksFile = path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "hooks.json"),
  nodeBin = process.execPath,
): string {
  let root: Record<string, unknown> = {};
  if (existsSync(hooksFile)) {
    try {
      const parsed = JSON.parse(readFileSync(hooksFile, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        root = parsed as Record<string, unknown>;
      }
    } catch {
      root = {};
    }
  }
  const hooksObj =
    root.hooks && typeof root.hooks === "object" && !Array.isArray(root.hooks)
      ? (root.hooks as Record<string, unknown>)
      : {};
  root.hooks = hooksObj;

  const events: Array<{ event: string; matcher?: string }> = [
    { event: "SessionStart" },
    { event: "UserPromptSubmit" },
    { event: "PostToolUse", matcher: ".*" },
    { event: "Stop" },
  ];

  for (const { event, matcher } of events) {
    const cmd = `${shellQuote(nodeBin)} ${shellQuote(cliPath)} hook --harness codex --event ${event}`;
    const existingGroups = Array.isArray(hooksObj[event]) ? (hooksObj[event] as Array<Record<string, unknown>>) : [];
    const cleanedGroups = existingGroups
      .map((group) => {
        if (!group || typeof group !== "object") return null;
        const list = Array.isArray(group.hooks) ? (group.hooks as Array<Record<string, unknown>>) : [];
        const kept = list.filter((item) => {
          const itemCmd = typeof item?.command === "string" ? item.command : "";
          return !(itemCmd.includes("hook --harness codex") && itemCmd.includes(`--event ${event}`));
        });
        if (kept.length === 0) return null;
        return { ...group, hooks: kept } as Record<string, unknown>;
      })
      .filter((group): group is Record<string, unknown> => group !== null);

    cleanedGroups.push({
      ...(matcher ? { matcher } : {}),
      hooks: [
        {
          type: "command",
          command: cmd,
          timeout: 5,
        },
      ],
    });
    hooksObj[event] = cleanedGroups;
  }

  mkdirSync(path.dirname(hooksFile), { recursive: true });
  writeFileSync(hooksFile, `${JSON.stringify(root, null, 2)}\n`);
  return hooksFile;
}

export function installSwitchboard(
  opts: {
    zshrc?: string;
    layoutDir?: string;
    repo?: string;
    targetRepo?: string;
    orchestrator?: string;
    panes?: string[];
    claude4?: boolean;
    accounts?: string[];
    home?: string;
    codexHooksFile?: string;
    fresh?: PaneSpec[];
    resume?: PaneSpec[];
  } = {},
): string[] {
  const repo = opts.repo ?? repoRoot();
  const targetRepo = opts.targetRepo ? gitRepoRoot(opts.targetRepo) : repo;
  const key = repoKey(targetRepo);
  const home = homedir();
  const layoutDir = opts.layoutDir ?? path.join(home, ".config/zellij/layouts");
  const zshrc = opts.zshrc ?? path.join(home, ".zshrc");
  const cli = path.join(repo, "dist/cli.js");
  const notes: string[] = [];
  const fresh = opts.fresh ?? harnessPanes(false);
  const resume = opts.resume ?? harnessPanes(true);

  mkdirSync(layoutDir, { recursive: true });
  const layoutPath = path.join(layoutDir, "switchboard.kdl");
  const resumePath = path.join(layoutDir, "switchboard-resume.kdl");
  writeFileSync(layoutPath, switchboardLayout(targetRepo, fresh));
  writeFileSync(resumePath, switchboardLayout(targetRepo, resume));
  notes.push(`layout ${layoutPath}`);
  notes.push(`layout ${resumePath}`);

  if (opts.targetRepo) {
    const repoLayoutPath = path.join(layoutDir, `switchboard-${key}.kdl`);
    const repoResumePath = path.join(layoutDir, `switchboard-${key}-resume.kdl`);
    writeFileSync(repoLayoutPath, switchboardLayout(targetRepo, fresh));
    writeFileSync(repoResumePath, switchboardLayout(targetRepo, resume));
    notes.push(`repo layout ${repoLayoutPath}`);
    const cfg = writeRepoConfig(
      targetRepo,
      {
        orchestrator: opts.orchestrator,
        panes: opts.panes,
        claude4: opts.claude4,
        accounts: opts.accounts,
      },
      opts.home ?? switchboardHome(),
    );
    notes.push(`repo config ${repoConfigPath(cfg.repoKey, opts.home ?? switchboardHome())} (orchestrator=${cfg.orchestrator})`);
  }

  const current = existsSync(zshrc) ? readFileSync(zshrc, "utf8") : "";
  writeFileSync(zshrc, upsertZshBlock(current, zshLauncher(cli)));
  notes.push(`zshrc ${zshrc}`);

  const codexDir = process.env.CODEX_HOME || path.join(home, ".codex");
  const includeCodex =
    Boolean(opts.codexHooksFile) ||
    opts.orchestrator === "codex" ||
    fresh.some((pane) => pane.name === "Codex") ||
    existsSync(codexDir);
  if (includeCodex && (opts.codexHooksFile || (!opts.zshrc && !opts.layoutDir))) {
    const hooksPath = upsertCodexHooks(cli, opts.codexHooksFile);
    notes.push(`codex hooks ${hooksPath}`);
  }

  const agy = path.join(home, ".local/bin/agy");
  const includeAgy = opts.orchestrator === "agy" || fresh.some((pane) => pane.name === "Antigravity");
  if (includeAgy && existsSync(agy)) {
    execFileSync(
      agy,
      [
        "mcp",
        "add",
        "--env",
        "SWITCHBOARD_HARNESS=antigravity",
        "--env",
        "SWITCHBOARD_NAME=agy",
        "--env",
        "SWITCHBOARD_SCOPE=share",
        "switchboard",
        "--",
        process.execPath,
        cli,
        "mcp",
      ],
      { stdio: "pipe" },
    );
    notes.push("agy mcp server switchboard");
  }
  return notes;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function promptPaneSelection(choices: PaneChoice[]): Promise<string> {
  const found = choices
    .filter((choice) => choice.found)
    .map((choice) => String(choice.index))
    .join(" ");
  stdout.write("Which panes should the grid open?\n");
  stdout.write('Blank uses the ones found on this machine. Enter numbers or names, or "all".\n\n');
  for (const choice of choices) {
    const where = choice.id === "bus" ? "shell" : (choice.command ?? "not found");
    stdout.write(`  ${String(choice.index).padStart(2)}  ${choice.pane.padEnd(14)} ${where}\n`);
  }
  stdout.write("\n");
  if (!stdin.isTTY) {
    stdout.write("No terminal attached. Using the panes found on this machine.\n");
    return "";
  }
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(`Panes [${found}]: `)).trim();
  } finally {
    rl.close();
  }
}

export async function init(
  onConfigured?: (
    cwd: string,
    orchestrator: string,
    provisionedAccounts: Array<{ profile: ClaudeAccountProfile; worktreeDir: string }>,
  ) => Promise<void>,
): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    allowNegative: true,
    options: {
      orchestrator: { type: "string" },
      panes: { type: "string" },
      accounts: { type: "string" },
      cwd: { type: "string" },
      claude4: { type: "boolean" },
    },
  });
  const targetCwd = values.cwd ? path.resolve(values.cwd) : process.cwd();
  const existingCfg = readRepoConfig(targetCwd);
  const discovered = discoverClaudeAccounts();
  const choices = gridChoices();
  const answer = values.panes !== undefined ? values.panes : await promptPaneSelection(choices);
  let ids = chosenIds(answer, choices);
  if (ids.length === 0) {
    stdout.write("Nothing matched. Using the panes found on this machine.\n");
    ids = chosenIds("", choices);
  }

  let accountsRaw = values.accounts;
  if (accountsRaw === undefined && !values.claude4 && stdin.isTTY && ids.includes("claude")) {
    const defaultAccts =
      existingCfg?.accounts?.join(",") ||
      (existingCfg?.claude4 && discovered.length > 0 ? discovered.map((a) => a.id).join(",") : "");
    stdout.write("\nClaude can be one pane, or one isolated pane per account.\n");
    stdout.write("Each account gets its own ~/.claude-<id> directory, Switchboard name, and Zellij pane.\n");
    if (discovered.length > 0) {
      for (const [index, account] of discovered.entries()) {
        stdout.write(`  ${String(index + 1).padStart(2)}  ${account.id.padEnd(12)} ${account.pane}\n`);
      }
    }
    const hint = discovered.length > 0 ? "names, numbers, or a count" : "a count, or names such as acct1,acct2";
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      accountsRaw = (
        await rl.question(`Claude accounts [${defaultAccts || hint}] (blank = one shared Claude pane): `)
      ).trim();
      if (!accountsRaw && defaultAccts) accountsRaw = defaultAccts;
    } finally {
      rl.close();
    }
  }

  const useClaudeMulti = Boolean(
    values.claude4 ||
      (accountsRaw && accountsRaw.trim().length > 0) ||
      answer.toLowerCase().includes("claude4") ||
      answer.toLowerCase().includes("claude-multi") ||
      existingCfg?.claude4,
  );
  const accountSpec =
    accountsRaw ??
    (existingCfg?.accounts?.length ? existingCfg.accounts.join(",") : undefined);
  const profiles = resolveAccountProfiles(accountSpec, useClaudeMulti, discovered);
  if (profiles.length > 0 && !ids.includes("claude")) {
    ids.push("claude");
  }

  const cliPath = path.join(repoRoot(), "dist/cli.js");
  const provisioned: Array<{ profile: ClaudeAccountProfile; worktreeDir: string }> = [];
  const accountNotes: string[] = [];
  if (profiles.length > 0) {
    writeSavedAccounts(profiles);
    for (const profile of profiles) {
      const res = provisionClaudeAccount(profile, {
        targetRepo: targetCwd,
        cliPath,
      });
      provisioned.push({ profile, worktreeDir: res.worktreeDir });
      accountNotes.push(...res.notes);
    }
  }

  for (const choice of choices) {
    if (ids.includes(choice.id) && !choice.found) stdout.write(`skipped ${choice.pane}: not found\n`);
  }
  const defaultOrch = existingCfg?.orchestrator ?? "cursor";
  let orchRaw = values.orchestrator;
  if (orchRaw === undefined && stdin.isTTY) {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      orchRaw = (await rl.question(`Orchestrator for ${gitRepoRoot(targetCwd)} [${defaultOrch}]: `)).trim();
    } finally {
      rl.close();
    }
  }
  const orchestrator = resolveOrchestratorName(orchRaw ?? "", defaultOrch);
  const freshPanes = panesFor(ids, false, choices, {
    claude4: profiles.length > 0,
    accounts: profiles,
    targetRepo: targetCwd,
    cliPath,
  });
  const resumePanes = panesFor(ids, true, choices, {
    claude4: profiles.length > 0,
    accounts: profiles,
    targetRepo: targetCwd,
    cliPath,
  });
  const notes = installSwitchboard({
    targetRepo: targetCwd,
    orchestrator,
    panes: ids,
    claude4: profiles.length > 0,
    accounts: profiles.map((p) => p.id),
    fresh: freshPanes,
    resume: resumePanes,
  });
  if (onConfigured) {
    await onConfigured(targetCwd, orchestrator, provisioned);
  }
  for (const note of [...accountNotes, ...notes]) stdout.write(`${note}\n`);
  const names = freshPanes.map((pane) => pane.name);
  stdout.write(`panes ${names.join(", ")}\n`);
  stdout.write(`orchestrator ${orchestrator}\n`);
  stdout.write("Open a new terminal and run: switchboard (or switchboard --resume / switchboard --restart)\n");
}
