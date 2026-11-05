// One owner's backup on its own thread (backup.ts#backupInWorker starts it): the thread opens the database read-only,
// writes the backup, posts the manifest or the failure's message, and ends. The arguments are its `workerData`.

import { parentPort, workerData } from 'node:worker_threads';
import { backupDatabase } from './backup.ts';

if (parentPort === null) throw new Error('the backup worker runs only as a worker thread');

// `workerData` is the object backupInWorker gives the thread.
const { db, to, data, at } = workerData as { db: string; to: string; data: string; at: number };
try {
  parentPort.postMessage({ manifest: backupDatabase({ db, to, data, now: () => at }) });
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
