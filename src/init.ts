import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

export const GRID_SESSION = "switchboard";

export type GridPlan =
  | { action: "attach"; session: string }
  | { action: "start"; session: string; layout: string; deleteFirst: boolean };

/** What `switchboard` or `switchboard --resume` should do with the Zellij session. */
export function gridPlan(resume: boolean, sessionLine: string | null, layoutDir: string): GridPlan {
  const layout = path.join(layoutDir, resume ? "switchboard-resume.kdl" : "switchboard.kdl");
  if (sessionLine && !sessionLine.includes("EXITED")) {
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

export function panesFor(ids: string[], resume: boolean, choices = gridChoices()): PaneSpec[] {
  const wanted = new Set(ids);
  const panes = HARNESSES.filter((def) => wanted.has(def.id))
    .filter((def) => def.shell || choices.find((choice) => choice.id === def.id)?.command)
    .map((def) => paneFrom(def, resume, choices.find((choice) => choice.id === def.id)?.command ?? def.candidates[0] ?? null));
  return panes.length > 0 ? panes : [{ name: "Bus" }];
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
  opts: { zshrc?: string; layoutDir?: string; repo?: string; fresh?: PaneSpec[]; resume?: PaneSpec[] } = {},
): string[] {
  const repo = opts.repo ?? repoRoot();
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
  writeFileSync(layoutPath, switchboardLayout(repo, fresh));
  writeFileSync(resumePath, switchboardLayout(repo, resume));
  notes.push(`layout ${layoutPath}`);
  notes.push(`layout ${resumePath}`);

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

export async function init(): Promise<void> {
  const choices = gridChoices();
  const answer = await promptPaneSelection(choices);
  let ids = chosenIds(answer, choices);
  if (ids.length === 0) {
    stdout.write("Nothing matched. Using the panes found on this machine.\n");
    ids = chosenIds("", choices);
  }
  for (const choice of choices) {
    if (ids.includes(choice.id) && !choice.found) stdout.write(`skipped ${choice.pane}: not found\n`);
  }
  const notes = installSwitchboard({
    fresh: panesFor(ids, false, choices),
    resume: panesFor(ids, true, choices),
  });
  for (const note of notes) stdout.write(`${note}\n`);
  const names = panesFor(ids, false, choices).map((pane) => pane.name);
  stdout.write(`panes ${names.join(", ")}\n`);
  stdout.write("Open a new terminal and run: switchboard\n");
}
