// The completion gate of plan 2026-11-04-cli-and-memory task 5: every `guild` left in the active tree has a class, and an
// occurrence with none fails. `guild\w*` matches case-insensitively, the broad search of the guild coupling audit. The
// word stays in five places only: the Discord adapter's SDK vocabulary, shipped migrations, explicit legacy codecs,
// fixtures and prose. Any new home needs a reviewer to add it here, because the implementer of a slice cannot edit this file.
//
// Count on 2026-11-05 at `71bde69b`, before any slice of task 5: 3789 unclassified occurrences in 200 files of the active
// tree (it was measured by this test). The test stays red until that number is zero, so it lands with the slice that
// brings it to zero, as the plan's completion gate. `scripts/` stays out of the gate, as B0 keeps it out of the old names:
// 497 occurrences on the audit's count, and their fate is the lead's call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ACTIVE_ROOTS = ['src', 'bin', 'interfaces', 'config', 'prompts', 'deploy', 'agents'];
const WORD = /guild\w*/gi;
const TEXT = /\.(ts|tsx|js|mjs|json|md|service|sh|txt)$/;

type Class = 'adapter SDK' | 'shipped migration' | 'explicit legacy codec' | 'fixture' | 'prose';

/** The one classifier: a path gets a class, or none. Prose is a whole Markdown file; a comment in code has no such class. */
function classOf(file: string): Class | null {
  if (file.startsWith('interfaces/discord/')) return file.endsWith('.md') ? 'prose' : 'adapter SDK';
  if (file === 'src/memory/db/schema.ts' || file.startsWith('src/memory/db/migrations/')) return 'shipped migration';
  // The only decoders of old identifiers. Nothing else may parse them.
  if (file.startsWith('src/memory/migration/')) return 'explicit legacy codec';
  if (file === 'src/interface/fake-interface.ts') return 'fixture';
  if (file.endsWith('.md')) return 'prose';
  return null;
}

function walk(dir: string, found: Array<string> = []): Array<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, found);
    else if (TEXT.test(name)) found.push(relative(ROOT, full).split('\\').join('/'));
  }
  return found;
}

/** The occurrences of the word in the active tree nobody classified, per file. */
function unclassified(): Map<string, number> {
  const out = new Map<string, number>();
  for (const root of ACTIVE_ROOTS) {
    for (const file of walk(join(ROOT, root))) {
      if (classOf(file) !== null) continue;
      const hits = readFileSync(join(ROOT, file), 'utf8').match(WORD)?.length ?? 0;
      if (hits > 0) out.set(file, hits);
    }
  }
  return out;
}

test('every occurrence of guild in the active tree has a class', () => {
  // Bug: a slice leaves active core coupling behind, or a new caller brings it back after the cutover.
  const left = unclassified();
  const total = [...left.values()].reduce((sum, hits) => sum + hits, 0);
  const worst = [...left.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, 15)
    .map(([file, hits]) => `${hits} ${file}`)
    .join('\n');
  assert.equal(total, 0, `${total} unclassified occurrences in ${left.size} files; the most:\n${worst}`);
});

/** Occurrences of the whole word outside the Discord adapter and outside prose, per file. */
function wordCount(word: RegExp): Map<string, number> {
  const out = new Map<string, number>();
  for (const root of ACTIVE_ROOTS) {
    for (const file of walk(join(ROOT, root))) {
      if (file.startsWith('interfaces/discord/') || file.startsWith('src/memory/migration/') || file.endsWith('.md'))
        continue;
      const hits = readFileSync(join(ROOT, file), 'utf8').match(word)?.length ?? 0;
      if (hits > 0) out.set(file, hits);
    }
  }
  return out;
}

test('channelId reduces to placeId outside the adapter', () => {
  // Bug: `guildId` leaves and its sibling stays, so one thing keeps two names. 1484 occurrences at the base of this branch.
  assert.deepEqual([...wordCount(/\bchannelIds?\b/g).keys()], []);
});

test('no argument was renamed instead of removed', () => {
  // Bug: `guildId` survives as `rootPlaceId` or `communityPlaceId`, and every caller still carries two places.
  assert.deepEqual([...wordCount(/\b(rootPlaceId|communityPlaceId|serverPlaceId|homePlaceId)\b/g).keys()], []);
});

test('the old constants are gone from the active tree', () => {
  // Bug: `NO_COMMUNITY` or the owner's home-community fallback survives under a neutral name search would not catch.
  const hits: Array<string> = [];
  for (const root of ACTIVE_ROOTS) {
    for (const file of walk(join(ROOT, root))) {
      if (file.startsWith('src/memory/migration/') || file.endsWith('.md')) continue;
      const text = readFileSync(join(ROOT, file), 'utf8');
      for (const word of ['NO_COMMUNITY', 'no-community', 'dmCommunityOf', 'communityField', 'communityKey']) {
        if (text.includes(word)) hits.push(`${file}: ${word}`);
      }
    }
  }
  assert.deepEqual(hits, []);
});
