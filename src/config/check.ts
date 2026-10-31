// The checks over the settings schema (src/config/schema.ts). `checkConfig` lists what a private settings file sets
// that the schema does not know, or sets to a value of a type the key does not take; `/config check`
// (src/interface/commands/console.ts) and `neptunia doctor` (bin/neptunia.ts) report it, and no start runs it.
// `checkReaders` lists the keys whose reader module is missing or never names the key; tests/config-check.test.ts
// runs it over the tree.

import fs from 'node:fs';
import path from 'node:path';
import type { ConfigType, SchemaEntry } from './schema.ts';

export type ConfigProblem = { key: string; kind: 'unknown' | 'type' };
export type ReaderProblem = { key: string; reader: string; kind: 'no-module' | 'not-read' };

type Tree = Record<string, unknown>;

const isTree = (value: unknown): value is Tree => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The JSON type of `value` as the schema names it; an object is `map`. */
function typeOf(value: unknown): ConfigType | null {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (isTree(value)) return 'map';
  const type = typeof value;
  return type === 'boolean' || type === 'number' || type === 'string' ? type : null;
}

/** The schema as a tree of sections: a leaf node holds its entry, a `*` child stands for any one name. */
type Node = { entry: SchemaEntry | null; children: Map<string, Node> };

function schemaTree(schema: ReadonlyArray<SchemaEntry>): Node {
  const root: Node = { entry: null, children: new Map() };
  for (const entry of schema) {
    let node = root;
    for (const key of entry.key.split('.')) {
      let child = node.children.get(key);
      if (child === undefined) {
        child = { entry: null, children: new Map() };
        node.children.set(key, child);
      }
      node = child;
    }
    node.entry = entry;
  }
  return root;
}

/** The problems of `value` at the schema node `node`, whose dotted path is `at`. */
function checkNode(value: unknown, node: Node, at: string, out: Array<ConfigProblem>): void {
  if (node.entry !== null) {
    const type = typeOf(value);
    if (type === null || !node.entry.types.includes(type)) out.push({ key: at, kind: 'type' });
    return;
  }
  if (!isTree(value)) {
    out.push({ key: at, kind: 'type' });
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const next = node.children.get(key) ?? node.children.get('*');
    const dotted = at === '' ? key : `${at}.${key}`;
    if (next === undefined) out.push({ key: dotted, kind: 'unknown' });
    else checkNode(child, next, dotted, out);
  }
}

/** What `value`, a private settings file with its keys moved to their new names, sets that `schema` refuses. */
export function checkConfig(value: unknown, schema: ReadonlyArray<SchemaEntry>): Array<ConfigProblem> {
  const out: Array<ConfigProblem> = [];
  checkNode(value, schemaTree(schema), '', out);
  return out;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether `source` reads `key`: it holds the dotted key as whole words, or both the first and the last segment as
 * whole words. A `*` segment never matches literally.
 */
function reads(source: string, key: string): boolean {
  const segments = key.split('.');
  if (!segments.includes('*') && new RegExp(`(?<![\\w.])${escape(key)}\\b`).test(source)) return true;
  const word = (segment: string): RegExp => new RegExp(`\\b${escape(segment)}\\b`);
  return word(segments[0] ?? '').test(source) && word(segments[segments.length - 1] ?? '').test(source);
}

/** The keys of `schema` whose reader under `rootDir` does not exist or does not read them. */
export function checkReaders(schema: ReadonlyArray<SchemaEntry>, rootDir: string): Array<ReaderProblem> {
  const sources = new Map<string, string | null>();
  const sourceOf = (reader: string): string | null => {
    if (!sources.has(reader)) {
      const file = path.join(rootDir, reader);
      sources.set(reader, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
    }
    return sources.get(reader) ?? null;
  };
  const out: Array<ReaderProblem> = [];
  for (const { key, reader } of schema) {
    const source = sourceOf(reader);
    if (source === null) out.push({ key, reader, kind: 'no-module' });
    else if (!reads(source, key)) out.push({ key, reader, kind: 'not-read' });
  }
  return out;
}
