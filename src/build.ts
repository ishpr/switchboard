import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { PROTOCOL_VERSION, type BuildInfo, type RuntimeInfo } from "./types.ts";

let cachedSourceBuild: BuildInfo | null = null;

export function loadBuild(): BuildInfo {
  if (import.meta.url.endsWith(".js")) {
    try { return JSON.parse(readFileSync(new URL("./build-info.json", import.meta.url), "utf8")) as BuildInfo; } catch { /* Unknown pre-metadata build. */ }
    return { version: "unknown", protocol_version: PROTOCOL_VERSION, commit_sha: null, built_at: null, source: "built", dirty: false };
  }
  if (cachedSourceBuild) return cachedSourceBuild;
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  let commit_sha: string | null = null;
  let dirty = false;
  try {
    const cwd = new URL("..", import.meta.url);
    commit_sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    dirty = Boolean(execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd, encoding: "utf8" }).trim());
  } catch { /* Source archive. */ }
  cachedSourceBuild = { version: pkg.version, protocol_version: PROTOCOL_VERSION, commit_sha, built_at: null, source: "source", dirty };
  return cachedSourceBuild;
}

export const BUILD = loadBuild();
export const runtimeInfo = (): RuntimeInfo => ({ ...loadBuild(), pid: process.pid, started_at: Date.now() });
export function buildWarning(local: BuildInfo, remote?: BuildInfo): string | null {
  if (!remote) return "daemon build metadata unavailable; restart the daemon and reconnect MCP after upgrading";
  if (local.protocol_version !== remote.protocol_version || local.version !== remote.version
    || (local.commit_sha && remote.commit_sha && local.commit_sha !== remote.commit_sha)) {
    return `build mismatch: local=${local.version}@${local.commit_sha ?? "unknown"} protocol=${local.protocol_version}; remote=${remote.version}@${remote.commit_sha ?? "unknown"} protocol=${remote.protocol_version}; restart the daemon/reconnect MCP`;
  }
  return null;
}
export function formatBuild(label: string, build?: BuildInfo & Partial<RuntimeInfo>): string {
  return build ? `${label}: version=${build.version} protocol=${build.protocol_version} commit=${build.commit_sha ?? "unknown"} source=${build.source} dirty=${build.dirty}${build.pid ? ` pid=${build.pid} started_at=${build.started_at}` : ""}` : `${label}: build metadata unavailable`;
}
