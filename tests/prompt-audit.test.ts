// B9 of the master plan, the parts that are structure and not wording: a paragraph says its thing in one prompt file,
// no tracked prompt names a folder the local layer no longer has, and the prompts the turn reads on any interface name
// no platform or server. What each
// file says instead is the lead's review, not a test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './fixtures/source-tree.ts';

const PROMPTS = path.join(ROOT, 'prompts');

const read = (name: string): string => fs.readFileSync(path.join(PROMPTS, `${name}.md`), 'utf8');

// The platform and the server are named by the interface's own text. These files are read in a chat on any
// interface, so they speak of the chat, the chat and the places the persona follows. Slice 5: interject.md and
// initiate.md are deleted with the forced turn.
const PLATFORM_FREE = ['avatar', 'private', 'follow-up', 'world'];

for (const name of PLATFORM_FREE) {
  test(`${name}.md names no platform and no server`, () => {
    // Bug: a persona on another interface is told it lives on a Discord server.
    assert.deepEqual(read(name).match(/\b(?:Discord|servers?)\b/gi) ?? [], []);
  });
}
