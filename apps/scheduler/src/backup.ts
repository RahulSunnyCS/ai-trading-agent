import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type AlertSink, telegramSink } from './alerts.js';
import type { Builtin } from './runner.js';

/** The external disk the owner keeps the backup on (BL-012 decision 4). */
export const DEFAULT_BACKUP_VOLUME = "/Volumes/RAHUL'S SSD";

/**
 * Where this month's backup goes: the external disk when it is mounted, otherwise
 * ~/Downloads — which is on the same disk as the data, so it guards against a broken
 * database but not a lost laptop. The caller warns when it falls back.
 */
export function backupDestination(
  env: Record<string, string>,
  mounted: (path: string) => boolean = existsSync,
): { dest: string; fallback: boolean } {
  const volume = env.BACKUP_VOLUME?.trim() || DEFAULT_BACKUP_VOLUME;
  return mounted(volume)
    ? { dest: join(volume, 'TradingData'), fallback: false }
    : { dest: join(homedir(), 'Downloads', 'TradingData-backup'), fallback: true };
}

/** `tdata backup --to <dest>`: lake/raw files copied only if new, the catalog every time. */
export function backupJob(sink?: AlertSink): Builtin {
  return async (ctx) => {
    const { dest, fallback } = backupDestination(ctx.env);
    ctx.log(`backup to ${dest}${fallback ? ' (external disk not mounted — fallback)' : ''}`);
    const code = await new Promise<number>((resolve) => {
      const child = spawn('uv', ['run', 'tdata', 'backup', '--to', dest], {
        cwd: join(ctx.repoRoot, 'packages/trading-data'),
        env: ctx.env,
      });
      child.stdout.on('data', (chunk: Buffer) => ctx.log(chunk.toString().trimEnd()));
      child.stderr.on('data', (chunk: Buffer) => ctx.log(chunk.toString().trimEnd()));
      child.on('error', (error) => {
        ctx.log(error.message);
        resolve(127);
      });
      child.on('close', (exit) => resolve(exit ?? 1));
    });
    if (code !== 0) return { code, error: `tdata backup exited ${code}` };
    if (fallback) {
      const volume = ctx.env.BACKUP_VOLUME?.trim() || DEFAULT_BACKUP_VOLUME;
      await (sink ?? telegramSink(ctx.env))(
        [
          '⚠️ Monthly backup went to ~/Downloads',
          '',
          `${volume} was not plugged in, so the research database was copied to ${dest}.`,
          'That copy is on the same disk as the data, so it does not survive losing the laptop.',
          '',
          'Plug the SSD in and run: bun run --filter @ata/scheduler jobs run backup',
        ].join('\n'),
      );
    }
    return { code: 0, error: null };
  };
}
