// She keeps knowing her diary once `diary.channelId` is only a seed (stage 3 design, section 5): with an enabled `diary`
// mirror on a place and no `diary.channelId` in the config, an ordinary turn treats that place as her diary the way it
// treats the configured channel today. `<server>` marks it with `labels.server.diary`, byte for byte as the recorded
// block (tests/fixtures/diary-mirror-awareness.json, built on the code before the change with `diary.channelId: 'd1'`),
// a turn in it keeps no participation, a line she writes there in an ordinary turn is no diary entry, and every mirrored
// place carries the mark. Real turn runner, real store over a memory database, fake interface, scripted model.
// Synthetic text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GUILD, replyTurn, serverBlock } from './fixtures/diary-awareness.ts';
import { dbOf, diaryPublications, diaryRows } from './fixtures/diary-mirror.ts';
import { labels } from './fixtures/labels.js';

const RECORDED_FILE = new URL('./fixtures/diary-mirror-awareness.json', import.meta.url);

/** The section of `name` in a `<server>` block: from its `# name` line to the next blank line. */
function sectionOf(block: string, name: string): string {
  const section = new RegExp(`# ${name}\\b[^\\n]*\\n(?:[^\\n]+\\n?)*`).exec(block)?.[0];
  assert.ok(section, `<server> lists #${name}`);
  return section;
}

test('a turn marks the mirrored place as her diary in <server>, byte for byte as diary.channelId did', async () => {
  const { request } = await replyTurn({ here: 'c1', mirrors: ['d1'] });
  const parsed: unknown = JSON.parse(fs.readFileSync(RECORDED_FILE, 'utf8'));
  // This test's own fixture, recorded from the same scene with `diary.channelId: 'd1'` and no mirror.
  assert.equal(serverBlock(request), (parsed as { server: string }).server);
});

test('a turn in the mirrored place keeps no participation there', async () => {
  const { store } = await replyTurn({ here: 'd1', mirrors: ['d1'] });
  // The store is JS; its participation unit holds the episodes of every channel.
  const episodes = (store.getParticipation(GUILD) as { episodes: Array<{ channelId: string }> }).episodes;
  assert.deepEqual(
    episodes.filter((episode) => episode.channelId === 'd1'),
    []
  );
});

test('a line she writes in the mirrored place in an ordinary turn is no diary entry and no publication', async () => {
  const { memory } = await replyTurn({ here: 'd1', mirrors: ['d1'] });
  const tables = dbOf(memory.memoryDb).prepare("SELECT name FROM sqlite_master WHERE name = 'mirrors'").all();
  assert.equal(tables.length, 1, 'the database holds the mirrors');
  assert.deepEqual(diaryRows(memory.memoryDb), []);
  assert.deepEqual(diaryPublications(memory.memoryDb), []);
});

test('with two mirrors both places carry the diary mark in <server>', async () => {
  const { request } = await replyTurn({ here: 'c1', mirrors: ['d1', 'd2'] });
  const block = serverBlock(request);
  for (const name of ['journal', 'notes'])
    assert.ok(sectionOf(block, name).includes(`\n${labels.server.diary}\n`), `#${name} is marked as her diary`);
  assert.ok(!sectionOf(block, 'general').includes(labels.server.diary), '#general is not');
});
