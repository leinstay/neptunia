// Shared log capture for tests: src/log.ts writes each entry as one JSON line through
// process.stdout.write. Under `node --test` the runner reports results over the same stdout, so
// a capture that swallowed every write would drop test events and hide tests from the total.
// Only the logger's own lines are captured; everything else is passed through untouched.

import type { Untyped } from '../../src/tools/types.ts';

/** A parsed log line. The tests read its fields by name, whatever the entry holds. */
export type LogEntry = Record<string, Untyped>;

const LOG_PREFIX = '{"level"';

/**
 * Runs `fn` with src/log.ts output intercepted and restores the original writer afterwards,
 * even if `fn` throws. Writes that are not log lines reach the real stdout. Returns `fn`'s resolved value and the
 * parsed log entries.
 */
export async function withCapturedLogs<T>(
  fn: () => T | Promise<T>,
): Promise<{ result: T; logs: Array<LogEntry> }> {
  const original = process.stdout.write;
  const lines: Array<string> = [];
  process.stdout.write = function write(chunk: unknown, ...rest: Array<unknown>): boolean {
    if (typeof chunk === 'string' && chunk.startsWith(LOG_PREFIX)) {
      lines.push(chunk);
      const callback = rest.find((arg) => typeof arg === 'function');
      if (callback) callback();
      return true;
    }
    return (original as (...args: Array<unknown>) => boolean).call(process.stdout, chunk, ...rest);
  };
  let result!: T;
  try {
    result = await fn();
  } finally {
    process.stdout.write = original;
  }
  const logs: Array<LogEntry> = [];
  for (const line of lines.join('').split('\n')) {
    if (!line.trim()) continue;
    try {
      logs.push(JSON.parse(line) as LogEntry);
    } catch {
      // a truncated or foreign line -- ignore
    }
  }
  return { result, logs };
}
