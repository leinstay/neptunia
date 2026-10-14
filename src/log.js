// Minimal structured logger: one JSON object per line, written to stdout.
// No dependency, no levels config — callers filter downstream (journald, etc).
// `onLog` lets a listener read each entry after it is written (src/ops/metrics.js takes the
// durations the log lines already carry); a listener never changes or stops the logging.

// JSON.stringify(new Error()) is "{}" — serialise errors explicitly, also when nested in meta
// (callers usually pass `{ error: err, ... }`).
function serializeError(err) {
  const out = { name: err.name, message: err.message };
  if (err.code !== undefined) out.code = err.code;
  if (err.statusCode !== undefined) out.statusCode = err.statusCode;
  if (err.stack) out.stack = err.stack.split('\n').slice(0, 8).join('\n');
  if (err.cause instanceof Error) out.cause = serializeError(err.cause);
  return out;
}

function normalizeMeta(meta) {
  if (meta === undefined) return {};
  if (meta instanceof Error) return { error: serializeError(meta) };
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const out = {};
    for (const [key, value] of Object.entries(meta)) {
      out[key] = value instanceof Error ? serializeError(value) : value;
    }
    return out;
  }
  return { value: meta };
}

function write(level, msg, meta) {
  const entry = {
    level,
    time: new Date().toISOString(),
    msg: String(msg),
    ...normalizeMeta(meta),
  };
  process.stdout.write(`${JSON.stringify(entry)}\n`);
  for (const listener of listeners) {
    try {
      const result = listener(entry);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      // A listener's failure is its own: the line is written, the caller never sees it.
    }
  }
}

/** The listeners `onLog` subscribed, called in subscription order. */
const listeners = new Set();

/**
 * Subscribe `listener` to every log entry: it gets the entry object (`{ level, time, msg,
 * ...meta }`) right after the line is written; one that throws (or rejects) is ignored.
 * @param {(entry: object) => unknown} listener
 * @returns {() => void}  Unsubscribes it.
 */
export function onLog(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The logger: `log.info|warn|error(msg, meta)` writes one JSON line
 * (`{ level, time, msg, ...meta }`) to stdout; an Error in `meta` (or `meta`
 * itself) is serialised with its name, message, code, status and stack.
 * Messages are `module: event`; meta carries ids, counts and codes, never
 * message contents.
 */
export const log = {
  info: (msg, meta) => write('info', msg, meta),
  warn: (msg, meta) => write('warn', msg, meta),
  error: (msg, meta) => write('error', msg, meta),
};
