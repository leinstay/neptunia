// The caption vectors of the GIF library, in the `vectors` table under `gif:<itemId>`: the library's JSON holds none, so a
// flush of it writes no vector bytes. The item id survives an entry's move to its content hash. A row has no owning unit
// and no source, so recall and the index policy's eviction pass it by, and its scope is the library's group scope.

import { dequantize, quantize } from '../vectors.ts';
import { ifaceOrLegacy } from './legacy-namespace.ts';
import { deriveRow } from './rows.ts';
import { groupScope } from './scope.ts';
import type { Db, Row } from './types.ts';

const PREFIX = 'gif:';

/** One vector written over the one this item held: `{ itemId, model, vector }`, on the writer's connection. */
export function writeGifVector(db: Db, update: Row, at: string): Row {
  const vector = update.vector as ReadonlyArray<number>;
  const { bytes, scale, norm } = quantize(vector);
  const row = deriveRow(
    db,
    'vectors',
    {
      item_id: update.itemId,
      chunk_key: `${PREFIX}${String(update.itemId)}`,
      model: update.model ?? null,
      dims: vector.length,
      scale,
      norm,
      bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      occurred_at: at,
      ...groupScope(ifaceOrLegacy(update)),
    },
    { at }
  );
  const columns = Object.keys(row);
  db.prepare(
    `INSERT OR REPLACE INTO vectors (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
  ).run(...columns.map((column) => row[column] as never));
  return { written: 1 };
}

/** Every GIF vector the table holds, by item id. */
export function readGifVectors(db: Db): Map<string, { model: string | null; vector: Float32Array }> {
  const found = new Map<string, { model: string | null; vector: Float32Array }>();
  const rows = db
    .prepare(
      `SELECT item_id, model, scale, bytes FROM vectors WHERE chunk_key LIKE '${PREFIX}%' AND retired_at IS NULL AND bytes IS NOT NULL`
    )
    .all();
  for (const row of rows) {
    const raw = row.bytes as Uint8Array;
    const vector = dequantize(new Int8Array(raw.buffer, raw.byteOffset, raw.byteLength), Number(row.scale));
    found.set(String(row.item_id), { model: typeof row.model === 'string' ? row.model : null, vector });
  }
  return found;
}
