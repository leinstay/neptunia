// `/memory inspect export` off the main thread. The export reads the whole database and writes it as one file, which
// holds the core's event loop for as long as it takes (25 s for 1 GB), so it runs on a thread of its own
// (inspection-export-worker.ts) over a read-only snapshot that thread opens itself. The file keeps the contract of
// `writeInspectionExport` (inspection-snapshots.ts): mode 0600, never an existing file, complete or absent.

import { Worker } from 'node:worker_threads';
import type { InspectionBounds, InspectionExportRecord } from './inspection-snapshots.ts';

/** What the thread needs: the database, the new file, whose export it is, and the revision the header names. */
export type InspectionExportArgs = {
  db: string;
  file: string;
  ownerId: string;
  bounds: InspectionBounds;
  engineRevision: string;
  /** The command's time. */
  at: number;
};

export type InspectionExportResult = {
  file: string;
  manifest: Extract<InspectionExportRecord, { kind: 'manifest' }>;
};

const EXPORT_WORKER = new URL('./inspection-export-worker.ts', import.meta.url);

type WorkerAnswer = { result: InspectionExportResult } | { error: string; code?: string };

/**
 * `writeInspectionExport` on its own thread: the same file and manifest, and the caller's thread stays free. Rejects
 * with the export's own message and `.code`, and when the thread dies or ends without an answer.
 */
export function exportInspectionInWorker(
  args: InspectionExportArgs,
  workerFile: string | URL = EXPORT_WORKER
): Promise<InspectionExportResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerFile, { workerData: args });
    let answered = false;
    worker.once('message', (answer: WorkerAnswer) => {
      answered = true;
      if ('result' in answer) resolve(answer.result);
      else reject(Object.assign(new Error(answer.error), answer.code === undefined ? {} : { code: answer.code }));
    });
    worker.once('error', reject);
    worker.once('exit', (exit) => {
      if (!answered) reject(new Error(`the export thread ended without an answer (exit ${exit})`));
    });
  });
}
