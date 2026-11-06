// The memory audit's count `unlinkedLineMedia` (src/memory/db/audit.ts, run by scripts/memory-audit.ts): a live media row
// with no link whose reference `<message id>#<item>` names the message of a stored, live line that links no item of that
// reference. Such a row is a picture of a message that the describer saw and the line does not hold. A row of a message
// that is no stored line, and a row that is not message media, are not counted. Written by the observation path and the
// describer's cache write on a temp database; synthetic content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditMemory } from '../src/memory/db/audit.ts';
import { writeMediaCache } from '../src/memory/db/media-store.ts';
import { observationOf } from '../src/memory/db/observe-event.ts';
import { observe } from '../src/memory/db/observe.ts';
import { fillEnvAudiences } from './fixtures/memory-db/audiences.ts';
import { ALICE, AT, HER, fixture } from './fixtures/media-memory.ts';
import type { Env } from './fixtures/media-memory.ts';
import type { Row } from '../src/memory/db/types.ts';

const CONVERSATION = { id: 'c1', kind: 'channel', rootId: 'g1', name: 'general' };
const POSTED = 'https://tenor.example.invalid/view/spinning-cat';
const TOLD = 'a grey cat spinning on a kitchen table';

const gifEmbed = (native: string, index = 0): Row => ({
  id: `${native}#e${index}`,
  kind: 'gif',
  site: 'Tenor',
  title: '',
  text: '',
  url: POSTED,
  thumbnailUrl: `https://media.example.invalid/${native}-${index}.png`,
});

/** Observes Alice's message `native` with these links; an edit observation when `edit`. */
function observed(env: Env, native: string, links: Array<Row>, edit = false): void {
  const event = {
    iface: 'discord',
    at: AT,
    conversation: CONVERSATION,
    ...(edit ? { edit: true } : {}),
    message: {
      id: native,
      at: AT,
      content: POSTED,
      author: { id: ALICE, name: 'Alice' },
      attachments: [],
      links,
      stickers: [],
    },
  };
  const envelope = observationOf(event, { selfId: HER });
  assert.ok(envelope, 'the synthetic event was refused');
  assert.equal(observe(env.handle, envelope, { now: () => AT }).ok, true);
}

/** The describer's cache of these keys, each told: rows the observation of their message would find by reference. */
function described(env: Env, keys: Array<string>): void {
  const value = Object.fromEntries(keys.map((key) => [key, { text: TOLD, ts: AT }]));
  writeMediaCache(env.db, { owner: 'media-cache:test', iface: 'discord', value, at: AT });
}

/** The audit's count, read by its name: a report without the count gives undefined, which no expectation equals. */
function unlinkedLineMedia(env: Env): number | undefined {
  fillEnvAudiences(env);
  const checks: Record<string, number | undefined> = auditMemory(env.db).checks;
  return checks.unlinkedLineMedia;
}

function withEnv(body: (env: Env) => void) {
  const env = fixture();
  try {
    body(env);
  } finally {
    env.done();
  }
}

// Bug: a picture the describer saw stays apart from its line and nothing reports it.
test('a described embed row of a stored line that does not hold it is counted, and not once the line links it', () =>
  withEnv((env) => {
    observed(env, '8101', []);
    described(env, ['8101#e0']);
    assert.equal(unlinkedLineMedia(env), 1);
    observed(env, '8101', [gifEmbed('8101')], true);
    assert.equal(unlinkedLineMedia(env), 0);
  }));

// Bug: the count looks only at lines that link nothing, so a second embed of a line that links its first is missed.
test('a row of a second embed is counted while the line links only the first', () =>
  withEnv((env) => {
    observed(env, '8201', [gifEmbed('8201')]);
    described(env, ['8201#e1']);
    assert.equal(unlinkedLineMedia(env), 1);
  }));

// Bug: a picture of a message she found by a search is counted though no line of it is stored, so the audit never clears.
test('a row naming a message that is no stored line is not counted', () =>
  withEnv((env) => {
    observed(env, '8301', []);
    described(env, ['8399#e0']);
    assert.equal(unlinkedLineMedia(env), 0);
  }));

// Bug: a page preview she opened or a server emoji is taken for a picture of a message.
test('a row that is not message media is not counted', () =>
  withEnv((env) => {
    observed(env, '8401', []);
    described(env, ['link:9c3b1e5a7d2f4068', 'emoji:8401']);
    assert.equal(unlinkedLineMedia(env), 0);
  }));

// Bug: a retired row, which is history, keeps the audit failing after the row was replaced.
test('a retired row is not counted', () =>
  withEnv((env) => {
    observed(env, '8501', []);
    described(env, ['8501#e0']);
    env.db.prepare("UPDATE media SET retired_at = '2026-11-02T00:00:00.000Z' WHERE native_ref = '8501#e0'").run();
    assert.equal(unlinkedLineMedia(env), 0);
  }));

// Bug: a retired line, which is history, is counted as a line that should hold the picture.
test('a row naming the message of a retired line is not counted', () =>
  withEnv((env) => {
    observed(env, '8601', []);
    described(env, ['8601#e0']);
    env.db.prepare("UPDATE sources SET retired_at = '2026-11-02T00:00:00.000Z' WHERE kind = 'seen'").run();
    assert.equal(unlinkedLineMedia(env), 0);
  }));
