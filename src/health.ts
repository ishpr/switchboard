import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentRecord, SessionDiagnostics } from "./types.ts";
import { decideWake } from "./wake.ts";

export const SESSION_STALE_MS = 10 * 60_000;
export type PaneTarget = { kind: "tmux" | "zellij"; pane: string; session?: string };
export type PaneProbe = (target: PaneTarget) => Promise<boolean | null>;
export type CommandRunner = (command: string, args: string[]) => Promise<string>;
const exec = promisify(execFile);
const runCommand: CommandRunner = async (command, args) =>
  (await exec(command, args, { timeout: 1500, maxBuffer: 1024 * 1024 })).stdout;

/** Pane bindings share the existing persisted session_id, without a second registry. */
export function paneTarget(sessionId: string | null): PaneTarget | null {
  const tmux = /^(?:tmux:)?(%\d+)$/.exec(sessionId ?? "");
  if (tmux) return { kind: "tmux", pane: tmux[1]! };
  const zellij = /^zellij:([^:]+):(\d+)$/.exec(sessionId ?? "");
  return zellij ? { kind: "zellij", session: zellij[1]!, pane: zellij[2]! } : null;
}

/** One snapshot per multiplexer/session per report. Errors mean unknown, never dead. */
export function createPaneProbe(run: CommandRunner = runCommand): PaneProbe {
  const snapshots = new Map<string, Promise<Set<string> | null>>();
  return async (target) => {
    const key = `${target.kind}:${target.session ?? ""}`;
    if (!snapshots.has(key)) snapshots.set(key, snapshot(target));
    const panes = await snapshots.get(key)!;
    return panes === null ? null : panes.has(target.pane);
  };

  async function snapshot(target: PaneTarget): Promise<Set<string> | null> {
    try {
      if (target.kind === "tmux") {
        const output = await run("tmux", ["list-panes", "-a", "-F", "#{pane_id} #{pane_dead}"]);
        const lines = output.trim() ? output.trim().split("\n") : [];
        if (lines.some((line) => !/^%\d+ [01]$/.test(line))) return null;
        return new Set(lines.filter((line) => line.endsWith(" 0")).map((line) => line.split(" ")[0]!));
      }
      const sessions = await run("zellij", ["list-sessions", "--no-formatting"]);
      if (!sessions.split("\n").some((line) =>
        line.split(/\s/)[0] === target.session && !line.includes("EXITED"))) return new Set();
      const output = await run("zellij", ["-s", target.session!, "action", "list-panes", "--json"]);
      const panes: unknown = JSON.parse(output);
      if (!Array.isArray(panes) || panes.some((p) =>
        !p || !Number.isInteger(p.id) || typeof p.is_plugin !== "boolean" || typeof p.exited !== "boolean")) return null;
      return new Set(panes.filter((p) => !p.is_plugin && !p.exited).map((p) => String(p.id)));
    } catch (error) {
      // tmux exits 1 with no server; distinguish that from missing binaries/permissions/timeouts.
      const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr) : "";
      if (target.kind === "tmux" && /no server running|No such file or directory/.test(stderr)) return new Set();
      return null;
    }
  }
}

export async function sessionDiagnostics(
  agent: AgentRecord,
  probe: PaneProbe,
  now = Date.now(),
): Promise<SessionDiagnostics> {
  const sessionId = agent.wakeSessionId || agent.sessionId || null;
  const target = paneTarget(sessionId);
  let pane: boolean | null | undefined;
  if (target) {
    try {
      pane = await probe(target);
    } catch {
      pane = null;
    }
  }
  const stale = now - agent.lastSeen > SESSION_STALE_MS;
  const health = pane === false ? "dead_pane" : stale ? "stale" : agent.online ? "online" : "offline";
  const wakeMode = decideWake({ directed: true, online: agent.online, harness: agent.harness,
    sessionId, wakeEnabled: agent.wake }).mode;
  const warnings: string[] = [];
  if (pane === false) warnings.push(`${wakeMode === "inject" ? "wake=inject targets" : "session targets"} missing or exited ${target!.kind} pane ${sessionId}; rebind the session`);
  if (pane === null) warnings.push(`could not verify ${target!.kind} pane ${sessionId}; check multiplexer availability and permissions`);
  if (stale) warnings.push("last seen more than 10 minutes ago; check the agent connection");
  if (agent.online && !agent.wake) warnings.push("headless_wake=off on an active agent; offline headless wake is disabled (bound-session injection still applies)");
  return { health, wakeMode, warnings };
}

export function formatDiagnostics(diagnostics?: SessionDiagnostics): string {
  if (!diagnostics) return "";
  return `health=${diagnostics.health} wake=${diagnostics.wakeMode}${diagnostics.warnings.map((warning) => ` WARNING: ${warning}`).join("")}`;
}
