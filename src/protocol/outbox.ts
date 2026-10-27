// An interface's outbox: the events it has sent the core and the core has not yet acknowledged, kept in a folder of
// the interface's own data (serve.ts takes it as `outbox`). `push` numbers each event with the next `seq` of the
// interface's principal and writes it, `pending` lists the unacknowledged ones oldest first, and `ack(seq)` drops
// every event up to the core's watermark. A full outbox refuses the event (`push` answers null) and evicts nothing.
// The folder holds one file per waiting event, `<seq>.json`, and `state.json` with the last `seq` given out, so an
// outbox opened again on the same folder, as after the interface restarts, holds what the last one held and never
// hands out a `seq` twice. An ack past the last `seq` moves the numbering on, so an interface that lost its folder
// still numbers after what the core has. Files are written to a temporary name and renamed, so a crash leaves a
// whole file or none.

import fs from 'node:fs';
import path from 'node:path';

/** One event waiting for its ack, with the number it was sent under. */
export type OutboxEntry = { seq: number; event: Record<string, unknown> };

export type Outbox = {
  /** Keeps `event` under the next `seq` and answers it; null, keeping nothing, when the outbox is full. */
  push(event: Record<string, unknown>): number | null;
  /** The waiting events, oldest first. */
  pending(): Array<OutboxEntry>;
  /** Drops every waiting event up to `seq`, the core's contiguous watermark. */
  ack(seq: number): void;
  /** Whether the outbox holds `capacity` events. */
  full(): boolean;
};

const STATE_FILE = 'state.json';
const EVENT_FILE = /^(\d+)\.json$/;

function writeWhole(file: string, value: unknown): void {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function readState(dir: string): { lastSeq: number; ackedSeq: number } {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), 'utf8')) as Record<string, unknown>;
    const lastSeq = Number.isInteger(parsed.lastSeq) ? (parsed.lastSeq as number) : 0;
    const ackedSeq = Number.isInteger(parsed.ackedSeq) ? (parsed.ackedSeq as number) : 0;
    return { lastSeq, ackedSeq };
  } catch {
    return { lastSeq: 0, ackedSeq: 0 };
  }
}

// The events of the folder, oldest first; a file that cannot be read is skipped, as a crash mid-write leaves it.
function readEntries(dir: string): Array<OutboxEntry> {
  const entries: Array<OutboxEntry> = [];
  for (const name of fs.readdirSync(dir)) {
    const match = EVENT_FILE.exec(name);
    if (match === null) continue;
    try {
      const event = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as Record<string, unknown>;
      entries.push({ seq: Number(match[1]), event });
    } catch {
      // A torn file of a crash: the event was never acknowledged, and the platform's history still holds it.
    }
  }
  return entries.sort((a, b) => a.seq - b.seq);
}

export function createOutbox(options: { dir: string; capacity: number }): Outbox {
  const { dir, capacity } = options;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const state = readState(dir);
  const entries = readEntries(dir).filter((entry) => entry.seq > state.ackedSeq);
  state.lastSeq = Math.max(state.lastSeq, entries.at(-1)?.seq ?? 0);
  const fileOf = (seq: number): string => path.join(dir, `${seq}.json`);

  return {
    push(event) {
      if (entries.length >= capacity) return null;
      const seq = state.lastSeq + 1;
      writeWhole(fileOf(seq), event);
      state.lastSeq = seq;
      writeWhole(path.join(dir, STATE_FILE), state);
      entries.push({ seq, event });
      return seq;
    },
    pending: () => entries.map((entry) => ({ ...entry })),
    ack(seq) {
      if (!Number.isInteger(seq) || seq <= state.ackedSeq) return;
      state.ackedSeq = seq;
      state.lastSeq = Math.max(state.lastSeq, seq);
      writeWhole(path.join(dir, STATE_FILE), state);
      while (entries[0] !== undefined && entries[0].seq <= seq) {
        const [done] = entries.splice(0, 1);
        if (done !== undefined) fs.rmSync(fileOf(done.seq), { force: true });
      }
    },
    full: () => entries.length >= capacity,
  };
}
