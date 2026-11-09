// The memory's paths under `data/` in one place: the operational files beside the memory database. The stores (store.ts,
// record.ts, journal.ts, archive.ts, vectors.ts) take a `dataDir` and ask `memoryRootOf(dataDir)`.
//
// Only the memory's own paths live here: the other owners under `data/` (errands' tasks,
// usage.json, metrics.json, the media caches, recall-eval) are not memory and keep theirs.
//
// Pure: no I/O, every value is a path computed from `dataDir`.

import path from 'node:path';

/** The directory under `data/` `/nep memory snapshot` writes to (src/tools/operations/memory.ts). */
export const SNAPSHOTS_DIR = 'snapshots';

/** The paths of one memory root, built by `memoryRootOf`. */
export type MemoryRoot = {
  dataDir: string;
  /** The operational folder of a place; the persona's own with null. */
  placeDir: (placeId: string | null) => string;
  stateFile: string;
  snapshotsRoot: string;
  resolve: (rel: string) => string;
  relative: (abs: string) => string;
};

/**
 * The memory's paths under one `data/` directory (or a snapshot of one).
 */
export function memoryRootOf(dataDir: string): MemoryRoot {
  return {
    dataDir,
    placeDir: (placeId) =>
      placeId === null
        ? path.join(dataDir, 'persona')
        : path.join(dataDir, 'places', encodeURIComponent(String(placeId))),
    /** `<dataDir>/state.json`. */
    stateFile: path.join(dataDir, 'state.json'),
    /** `<dataDir>/snapshots`. */
    snapshotsRoot: path.join(dataDir, SNAPSHOTS_DIR),
    /** `rel` resolved against `dataDir` (a path stored relative to it, such as a forget marker's vault). */
    resolve: (rel: string) => path.resolve(dataDir, rel),
    /** `abs` relative to `dataDir`, forward-slash separated (stable across platforms). */
    relative: (abs: string) => path.relative(dataDir, abs).split(path.sep).join('/'),
  };
}
