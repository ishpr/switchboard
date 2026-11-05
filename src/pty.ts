import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { BusClient } from "./busClient.ts";
import { readDaemonInfo } from "./ensure.ts";
import { switchboardHome } from "./paths.ts";
import { repoKey } from "./repo.ts";
import { readToken } from "./token.ts";
import { UUID_RE } from "./wake.ts";

export const PTY_RE = /^pty:(\/.+\.sock)$/;

/**
 * Computes a Unix domain socket path for a PTY relay session.
 * macOS sun_path max length is 104 bytes; falls back to /tmp if switchboardHome() is too deep.
 */
export function ptySocketPath(pid = process.pid, home = switchboardHome()): string {
  const dir = path.join(home, "pty");
  const candidate = path.join(dir, `sb-${pid}.sock`);
  if (Buffer.byteLength(candidate, "utf8") <= 96) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return candidate;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return path.join("/tmp", `sb-pty-${uid}-${pid}.sock`);
}

/**
 * Sends raw prompt text into a live `pty:<socket>` session:
 * writes Ctrl-U + message, waits 250ms for TUI paste detection to settle, then sends CR (\r).
 */
export async function injectIntoPtySocket(sockPath: string, text: string, enterDelayMs = 250): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const client = net.createConnection(sockPath, () => {
      client.write(`\x15${text}`);
      setTimeout(() => {
        client.end("\r", () => resolve());
      }, enterDelayMs);
    });
    client.on("error", (err) => reject(err));
  });
}

const PYTHON_PTY_RELAY = `
import errno, fcntl, os, pty, select, signal, socket, struct, sys, termios, tty

sock_path = sys.argv[1]
cmd = sys.argv[2]
args = sys.argv[2:]

try:
    if os.path.exists(sock_path):
        os.unlink(sock_path)
except OSError:
    pass

srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
srv.bind(sock_path)
try:
    os.chmod(sock_path, 0o600)
except OSError:
    pass
srv.listen(8)
srv.setblocking(False)

stdin_fd = sys.stdin.fileno()
stdout_fd = sys.stdout.fileno()
is_tty = os.isatty(stdin_fd)
orig_tc = None
if is_tty:
    try:
        orig_tc = termios.tcgetattr(stdin_fd)
    except Exception:
        is_tty = False

pid, master_fd = pty.fork()
if pid == 0:
    try:
        srv.close()
    except Exception:
        pass
    os.execvp(cmd, args)
    os._exit(127)

def sync_winsize():
    if not is_tty:
        return
    try:
        packed = fcntl.ioctl(stdin_fd, termios.TIOCGWINSZ, b"\\x00" * 8)
        fcntl.ioctl(master_fd, termios.TIOCSWINSZ, packed)
    except Exception:
        pass

sync_winsize()

def handle_sigwinch(signum, frame):
    sync_winsize()
    try:
        os.kill(pid, signal.SIGWINCH)
    except OSError:
        pass

def forward_signal(signum, frame):
    try:
        os.kill(pid, signum)
    except OSError:
        pass

signal.signal(signal.SIGWINCH, handle_sigwinch)
signal.signal(signal.SIGTERM, forward_signal)
signal.signal(signal.SIGHUP, forward_signal)

if is_tty and orig_tc is not None:
    try:
        tty.setraw(stdin_fd)
    except Exception:
        pass

clients = []
stdin_open = True
reaped_status = None
try:
    os.set_blocking(master_fd, False)
except Exception:
    pass

def write_all(fd, data):
    view = memoryview(data)
    while len(view) > 0:
        try:
            n = os.write(fd, view)
            view = view[n:]
        except OSError as e:
            if e.errno in (errno.EAGAIN, errno.EINTR):
                continue
            break

def drain_master():
    while True:
        try:
            data = os.read(master_fd, 16384)
            if not data:
                break
            write_all(stdout_fd, data)
        except OSError:
            break

try:
    while True:
        if reaped_status is None:
            try:
                wpid, wstatus = os.waitpid(pid, os.WNOHANG)
                if wpid == pid:
                    reaped_status = wstatus
                    drain_master()
                    break
            except OSError:
                break

        rlist = [master_fd, srv]
        if stdin_open:
            rlist.append(stdin_fd)
        rlist.extend(clients)
        try:
            rfds, _, _ = select.select(rlist, [], [], 0.1)
        except InterruptedError:
            continue
        except select.error as e:
            if getattr(e, "errno", None) == errno.EINTR:
                continue
            break

        if master_fd in rfds:
            try:
                data = os.read(master_fd, 16384)
                if not data:
                    break
                write_all(stdout_fd, data)
            except OSError as e:
                if e.errno in (errno.EAGAIN, errno.EINTR):
                    pass
                else:
                    break

        if stdin_open and stdin_fd in rfds:
            try:
                data = os.read(stdin_fd, 16384)
                if not data:
                    stdin_open = False
                else:
                    write_all(master_fd, data)
            except OSError:
                stdin_open = False

        if srv in rfds:
            try:
                conn, _ = srv.accept()
                conn.setblocking(False)
                clients.append(conn)
            except OSError:
                pass

        for c in list(clients):
            if c in rfds:
                try:
                    data = c.recv(16384)
                    if not data:
                        clients.remove(c)
                        c.close()
                    else:
                        write_all(master_fd, data)
                except OSError:
                    if c in clients:
                        clients.remove(c)
                    try:
                        c.close()
                    except OSError:
                        pass
finally:
    if is_tty and orig_tc is not None:
        try:
            termios.tcsetattr(stdin_fd, termios.TCSAFLUSH, orig_tc)
        except Exception:
            pass
    for c in clients:
        try:
            c.close()
        except Exception:
            pass
    try:
        srv.close()
    except Exception:
        pass
    try:
        if os.path.exists(sock_path):
            os.unlink(sock_path)
    except Exception:
        pass
    try:
        os.close(master_fd)
    except Exception:
        pass

exit_code = 0
try:
    status = reaped_status
    if status is None:
        _, status = os.waitpid(pid, 0)
    if os.WIFEXITED(status):
        exit_code = os.WEXITSTATUS(status)
    elif os.WIFSIGNALED(status):
        exit_code = 128 + os.WTERMSIG(status)
except OSError:
    pass
sys.exit(exit_code)
`;

export function normalizeHarnessArgs(harness: string, args: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  if (harness !== "claude") return args;
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--channels" && i + 1 < args.length) {
      const next = args[i + 1]!;
      if (next === "switchboard" || next === "server:switchboard") {
        out.push("--dangerously-load-development-channels", "server:switchboard");
        i++;
        continue;
      }
    }
    if (arg === "--channels=switchboard" || arg === "--channels=server:switchboard") {
      out.push("--dangerously-load-development-channels", "server:switchboard");
      continue;
    }
    if (arg === "--dangerously-load-development-channels" && args[i + 1] === "switchboard") {
      out.push("--dangerously-load-development-channels", "server:switchboard");
      i++;
      continue;
    }
    out.push(arg);
  }
  if (
    env.SWITCHBOARD_CLAUDE_CHANNELS === "1" &&
    !out.includes("--dangerously-load-development-channels")
  ) {
    out.unshift("--dangerously-load-development-channels", "server:switchboard");
  }
  return out;
}

export function extractSessionTargetFromWrap(
  args: string[],
  psOutput?: string,
  relayPid?: number,
): { fullSessionId?: string; prefix?: string } {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = args[i + 1];
    if (
      (arg === "--resume" || arg === "-r" || arg === "--session" || arg === "--session-id" || arg === "resume") &&
      next &&
      UUID_RE.test(next)
    ) {
      return { fullSessionId: next };
    }
    if (arg === "attach" && next && /^[0-9a-f]{6,36}$/i.test(next)) {
      return { prefix: next };
    }
  }
  if (psOutput && relayPid && relayPid > 1) {
    const rows: Array<{ pid: number; ppid: number; cmd: string }> = [];
    for (const rawLine of psOutput.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(rawLine);
      if (!m) continue;
      rows.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3]! });
    }
    const childCmds: string[] = [];
    for (const r of rows) {
      if (r.ppid === relayPid) {
        childCmds.push(r.cmd);
        for (const grand of rows) {
          if (grand.ppid === r.pid) childCmds.push(grand.cmd);
        }
      }
    }
    for (const cmd of childCmds) {
      const attachMatch = /\bclaude\s+attach\s+([0-9a-f]{6,36})\b/i.exec(cmd);
      if (attachMatch) return { prefix: attachMatch[1]! };
      const uuidMatch = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i.exec(cmd);
      if (uuidMatch) return { fullSessionId: uuidMatch[1]! };
    }
  }
  return {};
}

async function bindPtyWakeToDaemon(opts: {
  home: string;
  cwd: string;
  harness: string;
  wakeSessionId: string;
  args: string[];
  relayPid?: number;
}): Promise<boolean> {
  if (!opts.cwd || opts.cwd === "/") return false;
  const info = readDaemonInfo(opts.home);
  if (!info) return false;
  let psOut: string | undefined;
  if (opts.relayPid && opts.relayPid > 1) {
    try {
      psOut = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      // ignore ps failure
    }
  }
  const { fullSessionId, prefix } = extractSessionTargetFromWrap(opts.args, psOut, opts.relayPid);
  if (!fullSessionId && !prefix) return false;
  const client = new BusClient();
  try {
    await client.connect(info.url, {
      type: "hello",
      token: readToken(opts.home),
      name: "cli",
      harness: "cli",
      repoKey: repoKey(opts.cwd),
      cwd: opts.cwd,
    });
    const who = await client.request({ type: "who" });
    if (who.type !== "who") return false;
    const matched = who.agents.find((a) => {
      if (fullSessionId && a.sessionId === fullSessionId) return true;
      if (prefix && a.sessionId && a.sessionId.toLowerCase().startsWith(prefix.toLowerCase())) return true;
      return false;
    });
    const resolvedSessionId = matched?.sessionId || fullSessionId;
    if (!resolvedSessionId) return false;
    await client.request({
      type: "register",
      name: matched?.name || process.env.SWITCHBOARD_NAME || opts.harness,
      harness: matched?.harness || opts.harness,
      cwd: matched?.cwd || opts.cwd,
      sessionId: resolvedSessionId,
      wakeSessionId: opts.wakeSessionId,
    });
    return true;
  } catch {
    return false;
  } finally {
    client.close();
  }
}

export async function runPtyWrap(
  command: string,
  args: string[],
  opts: {
    home?: string;
    env?: NodeJS.ProcessEnv;
    onSocketReady?: (wakeSessionId: string, sockPath: string) => void;
  } = {},
): Promise<number> {
  const home = opts.home ?? switchboardHome();
  const sockPath = ptySocketPath(process.pid, home);
  const wakeSessionId = `pty:${sockPath}`;
  const inferredHarness = path.basename(command).toLowerCase().replace(/-cli$|-agent$/, "");
  const env: NodeJS.ProcessEnv = {
    ...(opts.env ?? process.env),
    SWITCHBOARD_WAKE_SESSION: wakeSessionId,
    SWITCHBOARD_HARNESS: (opts.env ?? process.env).SWITCHBOARD_HARNESS || inferredHarness,
  };
  args = normalizeHarnessArgs(inferredHarness, args, env);
  const pythonBin = existsSync("/usr/bin/python3") ? "/usr/bin/python3" : "python3";
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(pythonBin, ["-c", PYTHON_PTY_RELAY, sockPath, command, ...args], {
      stdio: "inherit",
      env,
    });
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const clearAllTimers = () => {
      for (const t of timers) clearTimeout(t);
      timers.length = 0;
    };
    const poll = setInterval(() => {
      if (existsSync(sockPath)) {
        clearInterval(poll);
        opts.onSocketReady?.(wakeSessionId, sockPath);
        if (!opts.home) {
          for (const delay of [50, 600, 2000]) {
            const t = setTimeout(() => {
              if (!existsSync(sockPath)) return;
              void bindPtyWakeToDaemon({
                home,
                cwd: process.cwd(),
                harness: inferredHarness,
                wakeSessionId,
                args,
                relayPid: child.pid,
              });
            }, delay);
            t.unref?.();
            timers.push(t);
          }
        }
      }
    }, 25);
    poll.unref?.();
    child.on("close", () => {
      clearInterval(poll);
      clearAllTimers();
    });
    child.on("error", (err) => {
      clearInterval(poll);
      clearAllTimers();
      try {
        if (existsSync(sockPath)) unlinkSync(sockPath);
      } catch {
        // ignore cleanup error
      }
      reject(err);
    });
    child.on("close", (code) => {
      try {
        if (existsSync(sockPath)) unlinkSync(sockPath);
      } catch {
        // ignore cleanup error
      }
      resolve(code ?? 0);
    });
  });
}
