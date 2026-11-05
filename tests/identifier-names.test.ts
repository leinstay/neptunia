// The gate of plan 2026-11-04-cli-and-memory B0: one name per identity. An account is `accountId` and a place is `placeId`
// everywhere outside the Discord adapter, which keeps the SDK's words and converts at the protocol. Stored data under the
// old words is rewritten by the offline converter and the shipped migrations, so those stay out of the count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ACTIVE_ROOTS = ['src', 'bin', 'cli', 'interfaces', 'agents'];

const isExempt = (file: string): boolean =>
  file.startsWith('interfaces/discord/') ||
  file.startsWith('src/memory/migration/') ||
  file === 'src/memory/db/schema.ts';

function walk(dir: string, found: Array<string> = []): Array<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, found);
    else if (name.endsWith('.ts') || name.endsWith('.tsx')) found.push(relative(ROOT, full).split('\\').join('/'));
  }
  return found;
}

/** The files of the active tree outside the exemptions that hold `word`, with how often. */
function filesHolding(word: RegExp): Array<string> {
  const out: Array<string> = [];
  for (const root of ACTIVE_ROOTS) {
    for (const file of walk(join(ROOT, root))) {
      if (isExempt(file)) continue;
      const hits = readFileSync(join(ROOT, file), 'utf8').match(word)?.length ?? 0;
      if (hits > 0) out.push(`${hits} ${file}`);
    }
  }
  return out;
}

test('communityId is gone: a protocol field or a function names a place', () => {
  // Bug: a function takes the server beside the channel again, and the two can disagree.
  assert.deepEqual(filesHolding(/\b\w*[cC]ommunityIds?\b/g), []);
});

test('memberId and userId are gone: an account has one name', () => {
  // Bug: one account travels under three names, and a key written under one is read back under another as nothing.
  assert.deepEqual(filesHolding(/\b\w*(?:[mM]ember|[uU]ser)Ids?\b/g), []);
});

test('no read falls back to the first community an interface serves', () => {
  // Bug: an emoji, an avatar or a reaction of one server is answered from whichever server was named first.
  assert.deepEqual(filesHolding(/\bservedCommunity\b|\b[cC]ommunityRoutes\.inScope\b/g), []);
});
