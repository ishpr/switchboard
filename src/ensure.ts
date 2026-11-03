import type { BuildInfo } from "./types.ts";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { buildWarning, loadBuild } from "./build.ts";
import { daemonInfoPath, switchboardHome } from "./paths.ts";
import { ensureToken } from "./token.ts";

export type DaemonInfo = {
  build?: BuildInfo;
  port: number;
  pid: number;
  url: string;
  startedAt: number;
};

export function readDaemonInfo(home = switchboardHome()): DaemonInfo | null {
  const file = daemonInfoPath(home);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as DaemonInfo;
  } catch {
    return null;
  }
}

export async function ensureDaemon(home = switchboardHome()): Promise<{ url: string; token: string }> {
  const token = ensureToken(home);
  const current = readDaemonInfo(home);
  if (current && (await portOpen(current.port))) {
    const localBuild = loadBuild();
    const staleBuild =
      process.env.SWITCHBOARD_NO_AUTOSTART !== "1" &&
      current.pid > 1 &&
      Boolean(
        buildWarning(localBuild, current.build) ||
          (localBuild.built_at && current.build?.built_at && localBuild.built_at !== current.build.built_at),
      );
    if (!staleBuild) return { url: current.url, token };
    try {
      process.kill(current.pid, "SIGTERM");
      for (let i = 0; i < 30; i++) {
        if (!(await portOpen(current.port))) break;
        await delay(50);
      }
    } catch {
      return { url: current.url, token };
    }
  }
  if (process.env.SWITCHBOARD_NO_AUTOSTART === "1") {
    throw new Error("switchboard daemon is not running");
  }
  const started = Date.now();
  const child = spawn(process.execPath, [process.argv[1] ?? "", "serve", "--home", home], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  for (let attempt = 0; attempt < 40; attempt++) {
    const info = readDaemonInfo(home);
    if (info && info.startedAt >= started - 1_000 && (await portOpen(info.port))) {
      return { url: info.url, token };
    }
    await delay(50);
  }
  throw new Error("switchboard daemon did not start");
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = (open: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
