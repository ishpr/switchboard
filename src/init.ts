import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
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

/** Commands are absolute so a Zellij pane does not depend on a login PATH. */
export function harnessPanes(resume = false): PaneSpec[] {
  const withResume = (base: string[], extra: string[]) => (resume ? [...base, ...extra] : base);
  return [
    {
      name: "Orchestrator",
      command: "/Users/ishprasad/.local/bin/cursor-agent",
      args: withResume(["--yolo", "--approve-mcps", "--trust"], ["--continue"]),
    },
    {
      name: "Grok",
      command: "/Users/ishprasad/.grok/bin/grok",
      args: withResume(["--always-approve", "--model", "grok-4.7", "--reasoning-effort", "xhigh"], ["--continue"]),
    },
    {
      name: "Claude",
      command: "/Users/ishprasad/.local/bin/claude",
      args: withResume(["--dangerously-skip-permissions", "--model", "fable"], ["--continue"]),
    },
    {
      name: "Codex",
      command: "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
      args: withResume(
        ["--dangerously-bypass-approvals-and-sandbox", "--model", "gpt-6.1-sol"],
        ["resume", "--last"],
      ),
    },
    {
      name: "Kimi",
      command: "/Users/ishprasad/.local/bin/kimi-cli",
      args: withResume(["--yolo"], ["--continue"]),
    },
    {
      name: "Muse",
      command: "/Users/ishprasad/.local/bin/muse",
      args: withResume(["--yolo", "--model", "muse-wonder-1.0", "--reasoning-effort", "xhigh"], ["resume", "--last"]),
    },
    {
      name: "Antigravity",
      command: "/Users/ishprasad/.local/bin/agy",
      args: withResume(["--dangerously-skip-permissions", "--mode", "auto"], ["--continue"]),
    },
    { name: "Bus" },
  ];
}

export function switchboardLayout(repo: string, panes = harnessPanes()): string {
  const row = (items: PaneSpec[]) => {
    const body = items.map(paneBlock).join("\n");
    return `            pane split_direction="vertical" {\n${body}\n            }`;
  };
  const mid = Math.ceil(panes.length / 2);
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
${row(panes.slice(0, mid))}
${row(panes.slice(mid))}
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

export function installSwitchboard(opts: { zshrc?: string; layoutDir?: string; repo?: string } = {}): string[] {
  const repo = opts.repo ?? repoRoot();
  const home = homedir();
  const layoutDir = opts.layoutDir ?? path.join(home, ".config/zellij/layouts");
  const zshrc = opts.zshrc ?? path.join(home, ".zshrc");
  const cli = path.join(repo, "dist/cli.js");
  const notes: string[] = [];

  mkdirSync(layoutDir, { recursive: true });
  const layoutPath = path.join(layoutDir, "switchboard.kdl");
  const resumePath = path.join(layoutDir, "switchboard-resume.kdl");
  writeFileSync(layoutPath, switchboardLayout(repo, harnessPanes(false)));
  writeFileSync(resumePath, switchboardLayout(repo, harnessPanes(true)));
  notes.push(`layout ${layoutPath}`);
  notes.push(`layout ${resumePath}`);

  const current = existsSync(zshrc) ? readFileSync(zshrc, "utf8") : "";
  writeFileSync(zshrc, upsertZshBlock(current, zshLauncher(cli)));
  notes.push(`zshrc ${zshrc}`);

  const agy = path.join(home, ".local/bin/agy");
  if (existsSync(agy)) {
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

export async function init(): Promise<void> {
  for (const note of installSwitchboard()) process.stdout.write(`${note}\n`);
  process.stdout.write("Open a new terminal and run: switchboard\n");
}
