import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

export type RepoScope = "split" | "share";

export function repoScope(): RepoScope {
  return process.env.SWITCHBOARD_SCOPE === "share" ? "share" : "split";
}

/** Namespace key for a checkout. Different checkouts never share a key. */
export function repoKey(cwd: string, scope: RepoScope = repoScope()): string {
  const override = process.env.SWITCHBOARD_REPO_KEY;
  if (override && override.trim()) return override.trim();

  let root = cwd;
  try {
    if (scope === "share") {
      const common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      root = path.isAbsolute(common) ? common : path.resolve(cwd, common);
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
  return createHash("sha256").update(root).digest("hex").slice(0, 16);
}
