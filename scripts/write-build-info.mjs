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

if (process.env.SWITCHBOARD_NO_AUTOSTART !== '1') {
  try {
    const { readDaemonInfo } = await import('../dist/ensure.js');
    const { switchboardHome } = await import('../dist/paths.js');
    const { spawn } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const home = switchboardHome();
    const info = readDaemonInfo(home);
    if (info && info.pid > 1) {
      try {
        process.kill(info.pid, 0);
        const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
        const child = spawn(process.execPath, [cliPath, 'who'], { stdio: 'ignore' });
        child.unref();
      } catch {
        // Daemon PID is not running; nothing to hot-reload.
      }
    }
  } catch {
    // Ignore hot-reload errors during bootstrap builds.
  }
}
