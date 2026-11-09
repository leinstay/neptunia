// `<meanwhile>` of a reply in a direct chat over the stored lines (src/turn/request/meanwhile.ts over the reads of
// src/memory/db/frame-reads.ts, plan 2026-11-06-turn-frame, slice 5, and decision 9): a direct chat's rows are read in
// that chat and in the chats of the same person's linked accounts, so the background of a direct chat holds the groups
// and that person's other chat with her, never another person's. The reads apply the turn's context; meanwhileOf
// keeps out only what the frame may not show. The command line's case, every place, is in
// tests/request-meanwhile.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linesAroundOf, ownLinesOf } from '../src/memory/db/frame-reads.ts';
import { linkedDmScopes } from '../src/memory/db/person-links.ts';
import { issueContext } from '../src/memory/db/scope.ts';
import { frameOf } from '../src/turn/request/frame.ts';
import { meanwhileOf } from '../src/turn/request/meanwhile.ts';
import { frameInput } from './fixtures/frame-input.ts';
import {
  addDm,
  addLine,
  addPerson,
  addRoom,
  noteInterface,
  openWorld,
  rootId,
} from './fixtures/memory-db/mind-world.ts';
import { shippedLabels } from './fixtures/shipped-labels.ts';

const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const MIN = 60_000;
const iso = (at: number): string => new Date(at).toISOString();
const ZOE = 'person:zoe';
const NIKOS = 'person:nikos';

test('a direct chat reply shows the groups and the same person linked chat, and no other person chat', () => {
  // Bug: the frame drops every one-to-one line in a direct chat, so what she told this person elsewhere is lost, or
  // the scope lets another person's chat into the background.
  const w = openWorld();
  try {
    noteInterface(w, 'fake', [{ id: 'g1', name: 'Αγορά' }]);
    noteInterface(w, 'tele', [{ id: 't1', name: 'Νησί' }]);
    const garden = addRoom(w.db, { iface: 'fake', native: 'c2', root: rootId('fake', 'g1'), name: 'κήπος' });
    addPerson(w.db, {
      id: ZOE,
      accounts: [
        { id: 'fake:5678', iface: 'fake', native: '5678', names: ['Ζωή'] },
        { id: 'tele:9999', iface: 'tele', native: '9999', names: ['Zoé'] },
      ],
    });
    addPerson(w.db, { id: NIKOS, accounts: [{ id: 'fake:4444', iface: 'fake', native: '4444', names: ['Νίκος'] }] });
    const here = addDm(w.db, { iface: 'fake', native: '5678', person: ZOE, account: 'fake:5678' });
    const linked = addDm(w.db, { iface: 'tele', native: '9999', person: ZOE, account: 'tele:9999' });
    const other = addDm(w.db, { iface: 'fake', native: '4444', person: NIKOS, account: 'fake:4444' });
    addLine(w.db, {
      id: 'g1',
      iface: 'fake',
      place: garden,
      author: 'self',
      text: 'ΣΤΟΝ-ΚΗΠΟ',
      at: iso(NOW - 50 * MIN),
    });
    addLine(w.db, {
      id: 'l1',
      iface: 'tele',
      place: linked,
      author: 'self',
      text: 'ΣΤΗ-ΖΩΗ-ΑΛΛΟΥ',
      at: iso(NOW - 40 * MIN),
      audience: { dm: linked, iface: 'tele', person: ZOE },
    });
    addLine(w.db, {
      id: 'o1',
      iface: 'fake',
      place: other,
      author: 'self',
      text: 'ΣΤΟΝ-ΝΙΚΟ',
      at: iso(NOW - 30 * MIN),
      audience: { dm: other, iface: 'fake', person: NIKOS },
    });
    // The context as the memory service issues it (src/memory/db/service.ts#linkedContext): the person's other chats.
    const issued = issueContext({
      kind: 'dm',
      iface: 'fake',
      person: ZOE,
      place: here,
      now: () => NOW,
      newId: () => 'ctx:dm',
    });
    const ctx = { ...issued, linked: linkedDmScopes(w.db, ZOE, here) };
    const frame = frameOf(
      frameInput({
        now: NOW,
        chain: [{ id: here, kind: 'dm', name: null }],
        dm: {
          word: 'private',
          nativeId: '5678',
          partner: { personId: ZOE, accountId: 'fake:5678', nativeId: '5678', name: 'Ζωή' },
        },
      })
    );
    const reads = {
      ownMessages: (limit: number) => ownLinesOf(w.db, ctx, here, limit),
      around: (placeId: string, at: number, count: number) => linesAroundOf(w.db, ctx, placeId, at, count),
    };
    const text = meanwhileOf(reads, frame, { messages: 8, around: 2 }, shippedLabels, () => null);
    assert.ok(text.includes('ΣΤΟΝ-ΚΗΠΟ'), 'a group');
    assert.ok(text.includes('ΣΤΗ-ΖΩΗ-ΑΛΛΟΥ'), "the same person's linked chat");
    assert.ok(!text.includes('ΣΤΟΝ-ΝΙΚΟ'), "another person's chat");
  } finally {
    w.close();
  }
});
