// Shared log capture for tests: src/log.js writes each entry as one JSON line through
// process.stdout.write. Under `node --test` the runner reports results over the same stdout, so
// a capture that swallowed every write would drop test events and hide tests from the total.
// Only the logger's own lines are captured; everything else is passed through untouched.

const LOG_PREFIX = '{"level"';

/**
 * Runs `fn` with src/log.js output intercepted and restores the original writer afterwards,
 * even if `fn` throws. Writes that are not log lines reach the real stdout.
 * @template T
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<{ result: T, logs: Array<Record<string, *>> }>} `fn`'s resolved value and the parsed log entries.
 */
export async function withCapturedLogs(fn) {
  const original = process.stdout.write;
  const lines = [];
  process.stdout.write = function write(chunk, ...rest) {
    if (typeof chunk === 'string' && chunk.startsWith(LOG_PREFIX)) {
      lines.push(chunk);
      const callback = rest.find((arg) => typeof arg === 'function');
      if (callback) callback();
      return true;
    }
    return original.call(process.stdout, chunk, ...rest);
  };
  let result;
  try {
    result = await fn();
  } finally {
    process.stdout.write = original;
  }
  const logs = [];
  for (const line of lines.join('').split('\n')) {
    if (!line.trim()) continue;
    try {
      logs.push(JSON.parse(line));
    } catch {
      // a truncated or foreign line -- ignore
    }
  }
  return { result, logs };
}
