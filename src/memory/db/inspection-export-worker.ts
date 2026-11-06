// One owner's inspection export on its own thread (inspection-export.ts#exportInspectionInWorker starts it): the thread
// opens its own read-only snapshot, writes the file through `writeInspectionExport`, posts the result or the refusal with
// its code, and ends. The arguments are its `workerData`.

import { parentPort, workerData } from 'node:worker_threads';
import { createInspectionPort, writeInspectionExport } from './inspection-snapshots.ts';
import type { InspectionExportArgs } from './inspection-export.ts';

if (parentPort === null) throw new Error('the inspection export worker runs only as a worker thread');

// `workerData` is the object exportInspectionInWorker gives the thread. The clock stands at the command's time, so
// the snapshot's idle and total bounds, which guard a person's reading, do not end a long write.
const { db, file, ownerId, bounds, engineRevision, at } = workerData as InspectionExportArgs;
try {
  const port = createInspectionPort({ dbPath: db, now: () => at, engineRevision });
  const handle = port.openInspection({ ownerId, bounds });
  try {
    parentPort.postMessage({ result: writeInspectionExport(port, handle, { file }) });
  } finally {
    port.closeAll();
  }
} catch (error) {
  const code = (error as { code?: unknown }).code;
  parentPort.postMessage({
    error: error instanceof Error ? error.message : String(error),
    ...(typeof code === 'string' ? { code } : {}),
  });
}
