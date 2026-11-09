// S1 of plan 2026-11-04-cli-and-memory: the main channel is gone, with no replacement. A read-only source with no explicit
// alternative has no target and nothing is sent: not the old configured channel, not the first writable place, not the
// busiest one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as routing from '../src/turn/routing.ts';
import * as memoryIndex from '../src/memory/index.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('the routing module holds no destination and no route any more', () => {
  // Bug: a helper that names a channel for words about another comes back, and a call is answered where nobody chose.
  // The two tests of `routeFor` and `usableDestination` this replaces went with those functions (owner, 2026-11-05).
  assert.equal('routeFor' in routing, false);
  assert.equal('usableDestination' in routing, false);
});

test('the shipped settings and the schema have no such key', () => {
  // Bug: the default and the registry row outlive the behaviour, and `/config` still offers to set it.
  const shipped = JSON.parse(readFileSync(join(ROOT, 'config', 'config.json'), 'utf8')) as { memory: object };
  assert.equal('mainChannelIds' in shipped.memory, false);
  assert.equal(
    readFileSync(join(ROOT, 'src', 'config', 'schema', 'memory.ts'), 'utf8').includes('mainChannelIds'),
    false
  );
});

test('the memory module no longer exports the channel set', () => {
  // Bug: a portrait filter keeps a private notion of a main channel through this helper.
  assert.equal('mainChannelSet' in memoryIndex, false);
});

function walk(dir: string, found: Array<string> = []): Array<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, found);
    else if (/\.(ts|tsx|json|md)$/.test(name)) found.push(relative(ROOT, full).split('\\').join('/'));
  }
  return found;
}

test('nothing in the active tree or the docs names a main channel', () => {
  // Bug: the portrait assembly, the memory inspector or a prompt keeps reading a setting that no longer exists.
  // The one list of retired keys may name it, because that is how it is refused.
  const hits: Array<string> = [];
  for (const root of ['src', 'bin', 'cli', 'config', 'prompts', 'agents', 'docs', 'interfaces']) {
    for (const file of walk(join(ROOT, root))) {
      if (/mainChannel|main channel|isMain\b/i.test(readFileSync(join(ROOT, file), 'utf8'))) hits.push(file);
    }
  }
  assert.deepEqual(hits, []);
});
