import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tokenPath } from "./paths.ts";

export function ensureToken(home?: string): string {
  const file = tokenPath(home);
  if (existsSync(file)) {
    const token = readFileSync(file, "utf8").trim();
    if (token) return token;
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}

export function readToken(home?: string): string {
  const file = tokenPath(home);
  if (!existsSync(file)) {
    throw new Error(`No token at ${file}. Start the daemon once so it can create one.`);
  }
  const token = readFileSync(file, "utf8").trim();
  if (!token) throw new Error(`Token file ${file} is empty.`);
  return token;
}
