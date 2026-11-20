import { spawn } from 'node:child_process';
import { isAbsolute, join } from 'node:path';

/** Exit code used when a step's executable can't be found, as a shell would. */
export const NOT_FOUND = 127;
/** Exit code recorded for a step killed at its timeout. */
export const TIMED_OUT = 124;

function resolveExecutable(cmd: string, cwd: string, path: string): string | null {
  if (cmd.includes('/')) return isAbsolute(cmd) ? cmd : join(cwd, cmd);
  return Bun.which(cmd, { PATH: path });
}

export function runStep(
  step: string[],
  cwd: string,
  env: Record<string, string>,
  logFd: number,
  timeoutMs: number,
  onSpawn: (pgid: number) => void = () => undefined,
): Promise<{ code: number; error: string | null }> {
  const [cmd = '', ...args] = step;
  const exe = resolveExecutable(cmd, cwd, env.PATH ?? '');
  if (!exe) return Promise.resolve({ code: NOT_FOUND, error: `${cmd}: not found on PATH` });
  return new Promise((resolve) => {
    // Its own process group, so a timeout ends everything the step started (a `sh -c` step's
    // commands, a browser), not just the first process: a retry must never overlap a survivor.
    const child = spawn(exe, args, { cwd, env, stdio: ['ignore', logFd, logFd], detached: true });
    // detached: the child leads its own group, whose id is its pid. Recorded on the run row, so a
    // scheduler that stops mid-step does not make the step look ended while it still runs.
    if (child.pid) {
      try {
        onSpawn(child.pid);
      } catch {
        // a bookkeeping failure must not fail the step
      }
    }
    const killAll = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        child.kill(signal);
      }
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killAll('SIGTERM');
      setTimeout(() => killAll('SIGKILL'), 10_000).unref();
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: NOT_FOUND, error: error.message });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut)
        resolve({ code: TIMED_OUT, error: `timed out after ${timeoutMs / 60_000} min` });
      else resolve({ code: code ?? 1, error: signal ? `killed by ${signal}` : null });
    });
  });
}
