import { PROTOCOL_VERSION } from '../dist/types.js';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const cwd = new URL('..', import.meta.url);
let commit_sha = null;
let dirty = false;
try {
  commit_sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  dirty = Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd, encoding: 'utf8' }).trim());
} catch { /* Source archives may not contain git metadata. */ }
writeFileSync(new URL('../dist/build-info.json', import.meta.url), JSON.stringify({ version: pkg.version, protocol_version: PROTOCOL_VERSION, commit_sha, dirty, built_at: new Date().toISOString(), source: 'built' }) + '\n');
