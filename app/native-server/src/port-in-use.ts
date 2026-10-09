import { execFileSync } from 'node:child_process';

/** Name the process listening on `port`, or null when none can be identified. */
export function describePortListener(port: number): string | null {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  try {
    return process.platform === 'win32' ? describeWindows(port) : describePosix(port);
  } catch {
    return null;
  }
}

export function isAddrInUse(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const record = current as { code?: unknown; cause?: unknown; message?: unknown };
    if (record.code === 'EADDRINUSE') return true;
    const message = typeof record.message === 'string' ? record.message : '';
    if (message.includes('EADDRINUSE') || message.includes('address already in use')) return true;
    current = record.cause;
  }
  return false;
}

/** Busy-port failure. The bridge stops; it does not bind a different port. */
export function portBusyError(port: number): Error {
  const owner = describePortListener(port);
  const who = owner ? ` by ${owner}` : '';
  return new Error(
    `Port ${port} is already in use${who}. Stop that process or set CHROME_MCP_PORT. This bridge will not choose another port.`,
  );
}

function run(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function lineListensOn(line: string, port: number): boolean {
  return new RegExp(`:${port}(?:\\s|$)`).test(line);
}

function describePosix(port: number): string | null {
  const args = ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'];
  const output =
    run('lsof', args) ?? (process.platform === 'darwin' ? run('/usr/sbin/lsof', args) : null);
  if (!output) return null;
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('COMMAND')) continue;
    const [command, pid] = trimmed.split(/\s+/);
    if (command && pid && /^\d+$/.test(pid)) return `${command} (pid ${pid})`;
  }
  return null;
}

function describeWindows(port: number): string | null {
  const output = run('netstat', ['-ano', '-p', 'tcp']);
  if (!output) return null;
  for (const line of output.split('\n')) {
    if (!/LISTENING/i.test(line) || !lineListensOn(line, port)) continue;
    const pid = line.trim().split(/\s+/).pop();
    if (!pid || !/^\d+$/.test(pid)) continue;
    const listed = run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    const name = listed?.match(/^"([^"]+)"/)?.[1];
    return name ? `${name} (pid ${pid})` : `pid ${pid}`;
  }
  return null;
}
