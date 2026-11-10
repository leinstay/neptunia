// The caption vectors of the GIF library, in the `vectors` table under `gif:<itemId>`: the library's JSON holds none, so a
// flush of it writes no vector bytes. The item id survives an entry's move to its content hash. A row has no owning unit
// and no source, so recall and the index policy's eviction pass it by, and its scope is the library's group scope. The
// writer takes one through the write kind `gif-vector` (session-write.ts).

import { dequantize, quantize } from '../vectors.ts';
import { namedIface } from './live-iface.ts';
import { deriveRow } from './rows.ts';
import { groupScope } from './scope.ts';
import { dbOf, isFiniteNumber } from './types.ts';
import type { Db, MemoryHandle, Row } from './types.ts';

const PREFIX = 'gif:';
/** The `kind` of a GIF's vector. */
const KIND = 'gif';

/** One vector written over the one this item held: `{ itemId, model, vector }`, on the writer's connection. */
export function writeGifVector(db: Db, update: Row, at: string): Row {
  const vector = update.vector as ReadonlyArray<number>;
  const { bytes, scale, norm } = quantize(vector);
  const row = deriveRow(db, 'vectors', {
    item_id: update.itemId,
    chunk_key: `${PREFIX}${String(update.itemId)}`,
    kind: KIND,
    model: update.model ?? null,
    dims: vector.length,
    scale,
    norm,
    bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    occurred_at: at,
    ...groupScope(namedIface(update)),
  });
  const columns = Object.keys(row);
  db.prepare(
    `INSERT OR REPLACE INTO vectors (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
  ).run(...columns.map((column) => row[column] as never));
  return { written: 1 };
}

/** One GIF vector as the store sends it: the entry's item id, the model and the numbers. */
export type GifVectorWrite = { itemId: string; model: string | null; vector: ReadonlyArray<number> };

/** The write kind `gif-vector` on the writer connection (session-write.ts). */
export function applyGifVectorWrite(handle: MemoryHandle, update: Row): Row {
  const coded = (code: string): Error => Object.assign(new Error(code), { code });
  if (typeof update.itemId !== 'string' || update.itemId === '') throw coded('GIF_VECTOR_ITEM');
  if (!Array.isArray(update.vector) || !update.vector.every(isFiniteNumber)) throw coded('GIF_VECTOR_NUMBERS');
  const at = new Date(isFiniteNumber(update.now) ? update.now : Date.now()).toISOString();
  return handle.transaction(() => writeGifVector(dbOf(handle), update, at));
}

/** Every GIF vector the table holds, by item id. */
export function readGifVectors(db: Db): Map<string, { model: string | null; vector: Float32Array }> {
  const found = new Map<string, { model: string | null; vector: Float32Array }>();
  const rows = db
    .prepare(
      `SELECT item_id, model, scale, bytes FROM vectors WHERE kind = '${KIND}' AND retired_at IS NULL AND bytes IS NOT NULL`
    )
    .all();
  for (const row of rows) {
    const raw = row.bytes as Uint8Array;
    const vector = dequantize(new Int8Array(raw.buffer, raw.byteOffset, raw.byteLength), Number(row.scale));
    found.set(String(row.item_id), { model: typeof row.model === 'string' ? row.model : null, vector });
  }
  return found;
}
