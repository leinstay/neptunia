// The claims about herself under `aud:none` (master plan V.5). Their writer is the place's notes
// (src/memory/db/place-notes.ts), which gave a place's `self` list `SCOPE_NONE`: a self fact noted in a DM could be shown
// anywhere. The correction: a self fact takes the scope of the notes it stands in, the groups on a server or channel and
// the partner's DM on a DM. Synthetic data on a real temporary database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OBSERVATION_VERSION } from '../src/memory/db/observe.ts';
import { placeCollection } from '../src/memory/db/storage-keys.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';

const GROUP = 'discord:channel:room';
const DM = 'discord:dm:owner';
const FACT_WORDS = 'likes-rain-synthetic';

const observed = (key: string, kind: 'dm' | 'channel', native: string) => ({
  v: OBSERVATION_VERSION,
  iface: 'discord',
  authority: 'discord/global',
  native: { kind: 'message', key: native, revision: 1 },
  place: {
    authority: 'discord/global',
    key,
    kind,
    chat: kind === 'dm' ? 'dm' : 'group',
    // Slice 3 (9 d): the audit counts an unnamed room, so the room carries its title as a live one does.
    ...(kind === 'dm' ? {} : { title: 'αίθουσα' }),
  },
  author: { kind: 'account', key: 'owner' },
  occurredAt: '2026-11-03T09:00:00.000Z',
  observedAt: '2026-11-03T09:00:01.000Z',
  text: 'a synthetic opening line',
  mentions: [],
  direct: kind === 'dm',
  relations: [],
});

/** A stopped core's database whose #room and whose DM each hold one self fact, written by the place's own writer. */
async function withSelfFacts(): Promise<string> {
  const env = await openTestMemory();
  await env.memoryDb.observe(observed('channel:room', 'channel', 'room-first'), null);
  await env.memoryDb.observe(observed('dm:owner', 'dm', 'dm-first'), null);
  for (const place of [GROUP, DM])
    await env.memoryDb.writeUnit({
      op: 'value',
      key: placeCollection('place', place),
      value: { self: [`${FACT_WORDS} ${place}`] },
    });
  const file = path.join(env.dataDir, 'memory.db');
  await env.close();
  // Slice 3 (9 d): the audit counts an unnamed interface; the name arrives with the interface's hello, absent here.
  const db = new DatabaseSync(file);
  db.exec("UPDATE interfaces SET name = 'Discord' WHERE id = 'discord'");
  db.close();
  return file;
}

type SelfRow = { place: string; scope_kind: string; audience_id: string };

/** The live self facts, each with the place whose notes hold it. */
function selfRows(file: string): Array<SelfRow> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT u.subject_id AS place, c.scope_kind, c.audience_id FROM claims c JOIN storage_units u ON u.id = c.owner_key
         WHERE c.kind = 'self_fact' AND c.retired_at IS NULL ORDER BY place`
      )
      .all()
      .map((row) => ({ ...row }) as SelfRow);
  } finally {
    db.close();
  }
}

// ---------- the writer ----------

// Bug: a new self fact is written under aud:none, a row the audit finds.
test('a self fact in the notes of a channel is written for the groups', async () => {
  const rows = selfRows(await withSelfFacts());
  const row = rows.find((one) => one.place === GROUP);
  assert.equal(row?.scope_kind, 'group');
  assert.equal(row?.audience_id, 'aud:group:discord');
});

// Bug: what she noted about herself in a private chat can be shown in any channel.
test('a self fact in the notes of a DM stays in that DM', async () => {
  const rows = selfRows(await withSelfFacts());
  const row = rows.find((one) => one.place === DM);
  assert.equal(row?.scope_kind, 'dm');
  assert.equal(row?.audience_id, `aud:dm:${DM}`);
});
