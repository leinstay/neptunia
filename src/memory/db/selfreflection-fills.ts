// The owner's fills of old selfreflection entries (a reconstructed plan, selfreflection-plan-fill.ts, and an audience,
// selfreflection-audience-fill.ts), told to whoever caches the entries. The store's cached diary would otherwise write
// the entries back without what a fill added at its next new entry (src/memory/store.ts#noteSelfreflectionFill). The
// memory service wraps its writes with `after`, and a fill that wrote at least one entry, with no `dryRun`, calls every
// listener once. A listener that throws is a warning, never the write's failure. Logs: codes only.

import type { Row } from './types.ts';

/** The writer kinds that fill old selfreflection entries. */
const FILL_KINDS = new Set(['selfreflection-plan-fill', 'selfreflection-audience-fill']);

/** The listeners of the fills and the wrapper that tells them. */
export function selfreflectionFills(log: { warn(message: string, fields?: Row): void }): {
  on: (fn: () => void) => () => void;
  after<T extends (update: Row) => Promise<unknown>>(write: T, kind?: string): T;
} {
  const listeners = new Set<() => void>();
  const tell = (kind: unknown, result: unknown): void => {
    const { written, dryRun } = (result ?? {}) as { written?: unknown; dryRun?: unknown };
    if (typeof kind !== 'string' || !FILL_KINDS.has(kind)) return;
    if (dryRun === true || typeof written !== 'number' || written < 1) return;
    for (const fn of listeners) {
      try {
        fn();
      } catch (error) {
        log.warn('memory db: selfreflection fill not told', {
          code: (error as { code?: string } | null)?.code ?? null,
        });
      }
    }
  };
  return {
    on(fn) {
      if (typeof fn !== 'function') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    after(write, kind) {
      const wrapped = async (update: Row): Promise<unknown> => {
        const result = await write(update);
        tell(kind ?? update?.kind, result);
        return result;
      };
      return wrapped as typeof write;
    },
  };
}

/** The two methods of the memory service the fills add. */
export type FillMethods = {
  /** Subscribes `fn()` to the owner's fills of old selfreflection entries that wrote. */
  onSelfreflectionFill(fn: () => void): () => void;
  /** The owner's fill of the audience on old group selfreflection entries (selfreflection-audience-fill.ts): `{ by, dryRun?, now? }`. */
  selfreflectionAudienceFill(update: Row): Promise<Row>;
};

/**
 * The service's three methods the fills touch: `memoryWrite` and `selfreflectionAudienceFill` (a write of the kind
 * `selfreflection-audience-fill` through `write`) wrapped to tell the listeners, and `onSelfreflectionFill` to subscribe.
 */
export function fillMethods<T extends (update: Row) => Promise<unknown>>(
  log: { warn(message: string, fields?: Row): void },
  memoryWrite: T,
  write: (update: Row) => Promise<Row>
): FillMethods & { memoryWrite: T } {
  const fills = selfreflectionFills(log);
  const audience = (update: Row): Promise<Row> => write({ ...update, kind: 'selfreflection-audience-fill' });
  return {
    memoryWrite: fills.after(memoryWrite),
    onSelfreflectionFill: fills.on,
    selfreflectionAudienceFill: fills.after(audience, 'selfreflection-audience-fill'),
  };
}
