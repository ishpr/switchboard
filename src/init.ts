import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

export type RepoConfig = {
  repoKey: string;
  repoRoot: string;
  orchestrator: string;
  panes?: string[];
  claude4?: boolean;
  accounts?: string[];
  updatedAt: number;
};

export function repoConfigPath(key: string, home = switchboardHome()): string {
  return path.join(home, "repos", `${key}.json`);
}

export function readRepoConfig(cwd: string, home = switchboardHome()): RepoConfig | null {
  const key = repoKey(cwd);
  const file = repoConfigPath(key, home);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as RepoConfig;
  } catch {
    return null;
  }
}

export function writeRepoConfig(
  cwd: string,
  update: { orchestrator?: string; panes?: string[]; claude4?: boolean; accounts?: string[] },
  home = switchboardHome(),
): RepoConfig {
  const key = repoKey(cwd);
  const root = gitRepoRoot(cwd);
  const existing = readRepoConfig(cwd, home);
  const next: RepoConfig = {
    repoKey: key,
    repoRoot: root,
    orchestrator: update.orchestrator ?? existing?.orchestrator ?? "cursor",
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

export function resolveOrchestratorName(input: string, fallback = "cursor"): string {
  const raw = input.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "antigravity" || raw === "argon" || raw === "argon4" || raw === "argon-4") return "agy";
  if (raw === "orchestrator" || raw === "cursor-agent") return "cursor";
  if (raw === "kimi-cli") return "kimi";
  return raw;
}

export const GRID_SESSION = "switchboard";

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
    return { action: "attach", session: GRID_SESSION };
  }
  return {
    action: "start",
    session: GRID_SESSION,
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
  return raw
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((token) => buildAccountProfile(token, discovered, home));
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
    out.push(paneFrom(def, resume, foundCmd ?? def.candidates[0] ?? null));
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
    tab name="switchboard" cwd="${repo}" {
        pane split_direction="horizontal" {
${rows.map(row).join("\n")}
        }
    }
}
`;
}

export function zshLauncher(cli: string): string {
  return `# switchboard              attach the grid, or start fresh sessions
# switchboard --resume    attach, or continue each harness's latest session in this repo
# switchboard -c          same as --resume
# switchboard who         the bus CLI
switchboard() {
  local resume=0
  if [[ \$1 == --resume || \$1 == -c || \$1 == --continue ]]; then
    resume=1
    shift
  fi
  if (( \$# )); then
    command node ${shellQuote(cli)} "\$@"
    return
  fi
  local session=switchboard
  local layout="\$HOME/.config/zellij/layouts/switchboard.kdl"
  if (( resume )); then
    layout="\$HOME/.config/zellij/layouts/switchboard-resume.kdl"
  fi
  local state
  state=\$(zellij list-sessions --no-formatting 2>/dev/null | grep "^\$session " || true)
  if [[ -n \$state && \$state != *EXITED* ]]; then
    zellij attach "\$session"
    return
  fi
  [[ -n \$state ]] && zellij delete-session "\$session" >/dev/null 2>&1
  zellij --session "\$session" --new-session-with-layout "\$layout"
}`;
}

function paneBlock(pane: PaneSpec): string {
  const indent = "                ";
  if (!pane.command) return `${indent}pane name="${pane.name}"`;
  if (!pane.args?.length) return `${indent}pane name="${pane.name}" command="${pane.command}"`;
  const args = pane.args.map((arg) => `"${arg}"`).join(" ");
  return `${indent}pane name="${pane.name}" command="${pane.command}" {\n                    args ${args}\n${indent}}`;
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

  const agy = path.join(home, ".local/bin/agy");
  const includeAgy = fresh.some((pane) => pane.name === "Antigravity");
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
  if (discovered.length > 0 && values.panes === undefined) {
    stdout.write(
      `Discovered ${discovered.length} isolated Claude account(s): ${discovered.map((a) => `${a.id} (${a.pane})`).join(", ")}\n\n`,
    );
  }
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
    const hint = discovered.length > 0 ? `discovered: ${discovered.map((a) => a.id).join(",")}` : "e.g. acct1,acct2 or 4";
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      accountsRaw = (
        await rl.question(`Isolated Claude accounts (blank=single Claude, or enter names/count [${defaultAccts || hint}]): `)
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
