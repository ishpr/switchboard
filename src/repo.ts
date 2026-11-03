import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

export type RepoScope = "split" | "share";

export function repoScope(): RepoScope {
  return process.env.SWITCHBOARD_SCOPE === "split" ? "split" : "share";
}

export function gitRepoRoot(cwd: string, scope: RepoScope = repoScope()): string {
  let root = cwd;
  try {
    if (scope === "share") {
      const common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const resolved = path.isAbsolute(common) ? common : path.resolve(cwd, common);
      root = path.basename(resolved) === ".git" ? path.dirname(resolved) : resolved;
    } else {
      root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    }
  } catch {
    root = cwd;
  }
  try {
    root = realpathSync(root);
  } catch {
    // Keep the path we have when the directory is gone.
  }
  return root;
}

/** Namespace key for a checkout. Linked git worktrees share a key unless scope="split". */
export function repoKey(cwd: string, scope: RepoScope = repoScope()): string {
  const override = process.env.SWITCHBOARD_REPO_KEY;
  if (override && override.trim()) return override.trim();

  const root = gitRepoRoot(cwd, scope);
  return createHash("sha256").update(root).digest("hex").slice(0, 16);
}

export function gitCheckoutInfo(cwd: string): { branch: string | null; head: string | null } {
  if (!cwd || cwd === "/") return { branch: null, head: null };
  let branch: string | null = null;
  let head: string | null = null;
  try {
    branch =
      execFileSync("git", ["-C", cwd, "symbolic-ref", "--quiet", "--short", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null;
  } catch {
    try {
      branch =
        execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim() || null;
    } catch {
      branch = null;
    }
  }
  try {
    head =
      execFileSync("git", ["-C", cwd, "rev-parse", "--short", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null;
  } catch {
    head = null;
  }
  return { branch, head };
}
