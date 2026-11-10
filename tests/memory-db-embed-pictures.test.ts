// A picture an embed carries is an item of its line (src/memory/db/media-store.ts#writeLineMedia through
// src/memory/db/observe.ts): on arrival and when the platform sends the embed in a later update of the message. The
// describer's row of the same reference (media-store.ts#writeMediaEntry) is adopted, never doubled, and a link's preview
// picture stays part of its link. The embeds have the shapes the Discord package hands the core: a GIF posted as an
// address is an embed with the `<message id>#e<N>` reference, a page link carries its own `link:` key. The writer does all
// of this already: these tests pin it for the change that makes a late embed reach it (tests/pipeline-edits.test.ts).
// Synthetic content on a temp database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineMedia, writeMediaEntry } from '../src/memory/db/media-store.ts';
import { observationOf } from '../src/memory/db/observe-event.ts';
import { observe } from '../src/memory/db/observe.ts';
import { internalContext } from '../src/memory/db/scope.ts';
import { ALICE, AT, HER, fixture } from './fixtures/media-memory.ts';
import type { Env } from './fixtures/media-memory.ts';
import type { Row } from '../src/memory/db/types.ts';

const CHAT = { id: 'c1', kind: 'channel', rootId: 'g1', name: 'general' };
const POSTED = 'https://tenor.example.invalid/view/spinning-cat';
const TOLD = 'a grey cat spinning on a kitchen table';
const CACHE_HOLDER = 'place:test';

/** A GIF posted as an address: the embed the platform builds for it, under the message's own embed index. */
const gifEmbed = (native: string, index = 0): Row => ({
  id: `${native}#e${index}`,
  kind: 'gif',
  site: 'Tenor',
  title: '',
  text: '',
  url: POSTED,
  thumbnailUrl: `https://media.example.invalid/${native}-${index}.png`,
  animationUrl: `https://media.example.invalid/${native}-${index}.mp4`,
});

/** The `message.received` event of Alice's message `native`, its media fields laid over an empty message. */
function eventOf(native: string, media: Row, { edit = false, text = POSTED }: { edit?: boolean; text?: string } = {}) {
  return {
    iface: 'discord',
    at: AT,
    chat: CHAT,
    ...(edit ? { edit: true } : {}),
    message: {
      id: native,
      at: AT,
      content: text,
      author: { id: ALICE, name: 'Alice' },
      attachments: [],
      links: [],
      stickers: [],
      ...media,
    },
  };
}

function observed(env: Env, event: Row): void {
  const envelope = observationOf(event, { selfId: HER });
  assert.ok(envelope, 'the synthetic event was refused');
  assert.equal(observe(env.handle, envelope, { now: () => AT }).ok, true);
}

const lineOf = (env: Env, native: string): string => {
  const rows = env.db.prepare("SELECT id FROM sources WHERE native_id = ? AND kind = 'seen'").all(native);
  assert.equal(rows.length, 1, 'one stored revision of the message');
  return String(rows[0].id);
};

const itemsOf = (env: Env, source: string) =>
  lineMedia(env.db, [source], internalContext(), 'source').get(source) ?? [];

const rowsNaming = (env: Env, ref: string) =>
  env.db.prepare('SELECT id, kind, description FROM media WHERE native_ref = ?').all(ref);

/** What the describer's cache writes for a message whose line holds no item of it yet: a row the line may adopt. */
function describedFirst(env: Env, ref: string): void {
  writeMediaEntry(env.db, { placeId: CACHE_HOLDER, iface: 'discord', key: ref, entry: { text: TOLD, ts: AT }, at: AT });
  assert.equal(rowsNaming(env, ref).length, 1, 'the describer wrote its row');
}

async function withEnv(body: (env: Env) => void | Promise<void>) {
  const env = fixture();
  try {
    await body(env);
  } finally {
    env.done();
  }
}

// Bug: the line drops the embed, so a question about what was posted in a channel misses the picture.
test('a message with an embed picture, observed, links one item under its embed reference', () =>
  withEnv((env) => {
    observed(env, eventOf('7001', { links: [gifEmbed('7001')] }));
    const items = itemsOf(env, lineOf(env, '7001'));
    assert.deepEqual(
      items.map((item) => item.nativeRef),
      ['7001#e0']
    );
  }));

// Bug: the line mints a second row beside the describer's and the description stays on the row nothing links.
test("the describer's unlinked row of the embed is the line's item, its description kept and no row beside it", () =>
  withEnv((env) => {
    describedFirst(env, '7002#e0');
    observed(env, eventOf('7002', { links: [gifEmbed('7002')] }));
    const [item] = itemsOf(env, lineOf(env, '7002'));
    assert.equal(item?.nativeRef, '7002#e0');
    assert.equal(item.description, TOLD);
    assert.equal(rowsNaming(env, '7002#e0').length, 1);
  }));

// Bug: a page link's preview picture becomes an image item beside the link, so one embed reads as two things posted.
test("a link's preview picture stays part of its link: one link item and no image item", () =>
  withEnv((env) => {
    const link = {
      id: 'link:5e1d0c9a7b3f2e41',
      kind: 'link',
      site: 'news.example.invalid',
      title: 'Harbour opens again',
      text: 'The old harbour reopens after the storm.',
      url: 'https://news.example.invalid/harbour',
      thumbnailUrl: 'https://news.example.invalid/harbour.png',
    };
    observed(env, eventOf('7003', { links: [link] }, { text: 'https://news.example.invalid/harbour' }));
    const items = itemsOf(env, lineOf(env, '7003'));
    assert.deepEqual(
      items.map((item) => item.kind),
      ['link']
    );
    assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM media WHERE kind = 'image'").get()?.n, 0);
  }));

// Bug: the embed takes the attachment's position, or the attachment is lost when both are written.
test('an attached picture and an embed picture are both linked, the attachment first', () =>
  withEnv((env) => {
    const attachment = {
      id: '7004-a',
      kind: 'image',
      name: 'harbour.png',
      url: 'https://cdn.example.invalid/7004-a.png',
    };
    observed(env, eventOf('7004', { attachments: [attachment], links: [gifEmbed('7004')] }));
    const items = itemsOf(env, lineOf(env, '7004'));
    assert.deepEqual(
      items.map((item) => [item.position, item.nativeRef]),
      [
        [0, '7004-a'],
        [1, '7004#e0'],
      ]
    );
  }));

// Bug: an observed edit that only brings the embed creates a second revision or a second row instead of linking the line.
test("an edit observation that brings the embed links it to the line's current revision, adopting the described row", () =>
  withEnv((env) => {
    observed(env, eventOf('7005', {}));
    describedFirst(env, '7005#e0');
    observed(env, eventOf('7005', { links: [gifEmbed('7005')] }, { edit: true }));
    const [item] = itemsOf(env, lineOf(env, '7005'));
    assert.equal(item?.nativeRef, '7005#e0');
    assert.equal(item.description, TOLD);
    assert.equal(rowsNaming(env, '7005#e0').length, 1);
  }));
