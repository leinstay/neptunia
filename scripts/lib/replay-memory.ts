// The memory a replay mode reads: the memory database of a data folder, read only, one per folder for the whole run.

import type { Untyped } from '../../src/tools/types.ts';
import { CliError } from './cli.ts';
import { readOnlyMemory } from './memory-read.ts';

/** The memory of a data directory, read only (scripts/lib/memory-read.ts), one per directory for the whole run. */
const memories = new Map<Untyped, Untyped>();

export function memoryFor(dataDir: string): Untyped {
  // The replayed turns are Discord's, the interface the core would name live.
  if (!memories.has(dataDir)) memories.set(dataDir, readOnlyMemory(dataDir, { iface: 'discord' }).memoryDb);
  return memories.get(dataDir);
}

/** The memory a store of `dataDir` reads: a store needs its database, so a directory without `memory.db` is refused. */
export function storeMemoryFor(dataDir: string): Untyped {
  const memoryDb: Untyped = memoryFor(dataDir);
  if (!memoryDb) throw new CliError(`replay-cli: no memory database in ${dataDir}`);
  return memoryDb;
}
