import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export function switchboardHome(): string {
  const home = process.env.SWITCHBOARD_HOME || path.join(homedir(), ".switchboard");
  mkdirSync(home, { recursive: true });
  return home;
}

export function tokenPath(home = switchboardHome()): string {
  return path.join(home, "token");
}

export function dbPath(home = switchboardHome()): string {
  return path.join(home, "switchboard.db");
}

export function daemonInfoPath(home = switchboardHome()): string {
  return path.join(home, "daemon.json");
}

export function wakeLogPath(home = switchboardHome()): string {
  return path.join(home, "wake.log");
}
