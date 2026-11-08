// B9 of the master plan, the parts that are structure and not wording: a paragraph says its thing in one prompt file,
// no tracked prompt names a folder the local layer no longer has, and the prompts the turn reads on any interface name
// no platform or server. The audit is .agents/docs/reports/2026-11-04-cli-memory/prompts-and-tools-audit.md. What each
// file says instead is the lead's review, not a test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './fixtures/source-tree.ts';

const PROMPTS = path.join(ROOT, 'prompts');
const SHINGLE = 6;

const read = (name: string): string => fs.readFileSync(path.join(PROMPTS, `${name}.md`), 'utf8');

/** Every run of `SHINGLE` consecutive words of a text, lowercased, punctuation dropped. */
function runsOf(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const runs = new Set<string>();
  for (let at = 0; at + SHINGLE <= words.length; at += 1) runs.add(words.slice(at, at + SHINGLE).join(' '));
  return runs;
}

/** The runs two prompt files have in common. */
function shared(a: string, b: string): Array<string> {
  const other = runsOf(read(b));
  return [...runsOf(read(a))].filter((run) => other.has(run));
}

test('follow-up.md repeats nothing of reply.md', () => {
  // Bug: the paragraph on replying like to anyone is edited in one file and the other keeps the old advice.
  assert.equal(shared('follow-up', 'reply').length, 0, 'shared six-word runs');
});

test('the selfreflection writer repeats nothing of the planner', () => {
  // Bug: the post kinds are described in the planner and again in the writer, and a new kind is added to one.
  assert.equal(shared('selfreflection', 'selfreflection-planner').length, 0, 'shared six-word runs');
});

test('no tracked prompt names a folder of the old local layer', () => {
  // Bug: the executor brief tells the agent not to touch folders that no longer exist and leaves `data/prompts/` out.
  const stale = fs
    .readdirSync(PROMPTS)
    .filter((file) => file.endsWith('.md'))
    .filter((file) => /prompts\.local|config\.local/.test(fs.readFileSync(path.join(PROMPTS, file), 'utf8')));
  assert.deepEqual(stale, []);
});

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
