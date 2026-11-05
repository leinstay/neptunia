// src/memory/db/private-read.ts: the private view of one person across their accounts and actual DM places, and of one
// DM place. Authorization comes before records and counts: a view never tells a context what it may not read.
// Contract, plan 2026-11-04-cli-and-memory task 4:
//   privateByPerson(db: Db, personId: string, context: Context): PrivatePersonView
//   privateByPlace(db: Db, placeId: string, context: Context): PrivatePlaceView
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { linkedDmScopes } from '../src/memory/db/person-links.ts';
import { privateByPerson, privateByPlace } from '../src/memory/db/private-read.ts';
import type { PrivatePersonView, PrivatePlaceView } from '../src/memory/db/private-read.ts';
import { dmContext, groupContext, internalContext } from '../src/memory/db/scope.ts';
import type { Context } from '../src/memory/db/scope.ts';
import { applyMemoryWrite, mergePeople } from '../src/memory/db/session-write.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, MemoryHandle } from '../src/memory/db/types.ts';
import { wrongly } from './fixtures/loose-types.ts';
import {
  ANNA,
  ANNA_ACCOUNTS,
  ANNA_PLACES,
  ANNA_RECORDS,
  BORIS,
  BORIS_PLACE,
  GROUP_PLACE,
  addAccount,
  addClaim,
  addDmPlace,
  addPerson,
  seedOpaqueWorld,
} from './fixtures/memory-db/opaque-people.ts';

function withWorld(body: (db: Db, handle: MemoryHandle) => void): void {
  const handle = openMemoryDb(':memory:');
  try {
    seedOpaqueWorld(dbOf(handle));
    body(dbOf(handle), handle);
  } finally {
    handle.close();
  }
}

type FoundPerson = Extract<PrivatePersonView, { found: true }>;
type FoundPlace = Extract<PrivatePlaceView, { found: true }>;

function person(view: PrivatePersonView): FoundPerson {
  assert.equal(view.found, true);
  return view;
}
function place(view: PrivatePlaceView): FoundPlace {
  assert.equal(view.found, true);
  return view;
}

const placeIds = (view: FoundPerson): Array<string> => view.places.map((one) => one.id).sort();
const recordIds = (view: { records: ReadonlyArray<{ id: string }> }): Array<string> =>
  view.records.map((one) => one.id).sort();

/** Her DM context on one account, carrying the DMs the writer's links give that person. */
const dmOf = (db: Db, who: string, iface: string, dmPlace: string): Context => ({
  ...dmContext(who, iface, dmPlace),
  linked: linkedDmScopes(db, iface, who),
});

test('the owner reads exactly the actual DM places and private records of an opaque person with no public profile', () => {
  // Bug: the reader derives `<iface>:dm:<native>` from the person id, so an opaque person has no places at all.
  withWorld((db) => {
    const view = person(privateByPerson(db, ANNA, internalContext()));
    assert.equal(view.person.id, ANNA);
    assert.deepEqual(view.accounts.map((one) => one.id).sort(), ANNA_ACCOUNTS);
    assert.deepEqual(placeIds(view), ANNA_PLACES);
    assert.deepEqual(recordIds(view), ANNA_RECORDS);
    assert.deepEqual(view.counts, { places: 3, records: 4 });
  });
});

test('a concrete account keeps its interface, authority, native id, generation and the time its link began', () => {
  // Bug: the view flattens accounts to a native id, and equal native ids on two interfaces cannot be told apart.
  withWorld((db) => {
    const view = person(privateByPerson(db, ANNA, internalContext()));
    const telegram = view.accounts.find((one) => one.id === 'account:a21');
    assert.deepEqual(telegram, {
      id: 'account:a21',
      interfaceId: 'telegram',
      authorityId: 'telegram/global',
      nativeId: 'n1',
      generation: 1,
      linkState: 'verified',
      linkValidFromAt: '2026-11-01T00:00:00.000Z',
    });
    const dm = view.places.find((one) => one.id === 'place:dm-a21');
    assert.equal(dm?.interfaceId, 'telegram');
    assert.equal(dm?.authorityId, 'telegram/global');
    assert.equal(dm?.partnerAccountId, 'account:a21');
  });
});

test('every record keeps its original audience, place and stored text', () => {
  // Bug: a person-wide view rewrites an audience to the asking conversation, or merges text into one claim.
  withWorld((db) => {
    const view = person(privateByPerson(db, ANNA, internalContext()));
    const claim = view.records.find((one) => one.id === 'claim:a11');
    assert.equal(claim?.table, 'claims');
    assert.equal(claim?.audienceId, 'aud:dm:place:dm-a11');
    assert.equal(claim?.placeId, 'place:dm-a11');
    assert.equal(claim?.row.text, 'the words of claim:a11');
    const episode = view.records.find((one) => one.id === 'episode:a21');
    assert.equal(episode?.table, 'episodes');
    assert.equal(episode?.audienceId, 'aud:dm:place:dm-a21');
  });
});

test('a public claim and a claim made in someone else conversation stay out of the private view', () => {
  // Bug: the reader selects by subject, so what Boris said about Anna in his own DM is shown as hers.
  withWorld((db) => {
    const ids = recordIds(person(privateByPerson(db, ANNA, internalContext())));
    assert.equal(ids.includes('claim:public'), false);
    assert.equal(ids.includes('claim:about-anna-in-his-dm'), false);
  });
});

test('a record about a third person made in her DM belongs to her conversation', () => {
  // Bug: selecting by subject loses what she told the persona about someone else in her own DM.
  withWorld((db) => {
    addClaim(db, 'claim:third-party', BORIS, 'aud:dm:place:dm-a11');
    assert.ok(recordIds(person(privateByPerson(db, ANNA, internalContext()))).includes('claim:third-party'));
    assert.ok(recordIds(person(privateByPerson(db, BORIS, internalContext()))).includes('claim:third-party') === false);
  });
});

test('a retired record is left out of the view and out of its count', () => {
  // Bug: a record the writer retired comes back through the owner view as current memory.
  withWorld((db) => {
    db.prepare("UPDATE claims SET retired_at = '2026-11-02T00:00:00.000Z' WHERE id = 'claim:a11'").run();
    const view = person(privateByPerson(db, ANNA, internalContext()));
    assert.equal(recordIds(view).includes('claim:a11'), false);
    assert.equal(view.counts.records, 3);
  });
});

test('her own DM context reads all her DMs and never the DM of another person', () => {
  // Bug: a DM context that holds only the legacy spelling of a linked place loses her other DMs, or gains his.
  withWorld((db) => {
    const view = person(privateByPerson(db, ANNA, dmOf(db, ANNA, 'discord', 'place:dm-a11')));
    assert.deepEqual(placeIds(view), ANNA_PLACES);
    assert.deepEqual(recordIds(view), ANNA_RECORDS);
    assert.equal(placeIds(view).includes(BORIS_PLACE), false);
  });
});

test('a DM context asking for another person gets no accounts, places, records or counts', () => {
  // Bug: a person id supplied in a DM reads a stranger private memory, or at least learns how much there is.
  withWorld((db) => {
    const view = person(privateByPerson(db, BORIS, dmOf(db, ANNA, 'discord', 'place:dm-a11')));
    assert.deepEqual(view.accounts, []);
    assert.deepEqual(view.places, []);
    assert.deepEqual(view.records, []);
    assert.deepEqual(view.counts, { places: 0, records: 0 });
  });
});

test('a group context obtains nothing private by supplying a person id', () => {
  // Bug: a public turn reads the private view because the caller named the person.
  withWorld((db) => {
    const view = person(privateByPerson(db, ANNA, groupContext('discord')));
    assert.deepEqual(view.records, []);
    assert.deepEqual(view.places, []);
    assert.deepEqual(view.counts, { places: 0, records: 0 });
  });
});

test('a context with only her own DM does not widen to her other DMs', () => {
  // Bug: the reader widens by the person in the context instead of by the audiences the core issued to it.
  withWorld((db) => {
    const view = person(privateByPerson(db, ANNA, dmContext(ANNA, 'discord', 'place:dm-a11')));
    assert.deepEqual(placeIds(view), ['place:dm-a11']);
    assert.deepEqual(recordIds(view), ['claim:a11']);
  });
});

test('a read without a context throws', () => {
  // Bug: a caller that forgot its context reads everything.
  withWorld((db) => {
    assert.throws(() => privateByPerson(db, ANNA, wrongly<Context>(null)));
    assert.throws(() => privateByPlace(db, 'place:dm-a11', wrongly<Context>(null)));
  });
});

test('a person with no accounts is found with an empty view', () => {
  // Bug: an empty person reads as missing, or the empty join throws.
  withWorld((db) => {
    addPerson(db, 'person:no-accounts');
    const view = person(privateByPerson(db, 'person:no-accounts', internalContext()));
    assert.deepEqual(view.accounts, []);
    assert.deepEqual(view.counts, { places: 0, records: 0 });
  });
});

test('a missing person and a missing place answer a named result', () => {
  // Bug: the caller cannot tell an unknown id from an empty view.
  withWorld((db) => {
    assert.deepEqual(privateByPerson(db, 'person:nobody', internalContext()), {
      found: false,
      code: 'PERSON_NOT_FOUND',
    });
    assert.deepEqual(privateByPlace(db, 'place:nowhere', internalContext()), {
      found: false,
      code: 'PLACE_NOT_FOUND',
    });
  });
});

test('a group place has no private view', () => {
  // Bug: the place reader returns group rows as private ones when handed a channel.
  withWorld((db) => {
    assert.deepEqual(privateByPlace(db, GROUP_PLACE, internalContext()), { found: false, code: 'PLACE_NOT_FOUND' });
  });
});

test('one DM place holds its partner and only its own records', () => {
  // Bug: the place reader falls back to the person and shows the records of the other DMs.
  withWorld((db) => {
    const view = place(privateByPlace(db, 'place:dm-a21', internalContext()));
    assert.equal(view.place.id, 'place:dm-a21');
    assert.equal(view.person?.id, ANNA);
    assert.deepEqual(recordIds(view), ['affinity:a21', 'episode:a21']);
    assert.deepEqual(view.counts, { records: 2 });
  });
});

test('another person context reading a DM place gets no records and no count', () => {
  // Bug: a place id supplied in his DM reads her conversation.
  withWorld((db) => {
    const view = place(privateByPlace(db, 'place:dm-a21', dmOf(db, BORIS, 'telegram', BORIS_PLACE)));
    assert.deepEqual(view.records, []);
    assert.deepEqual(view.counts, { records: 0 });
    assert.equal(view.person, null);
  });
});

test('merged people read as the survivor of the whole chain, with original audiences kept', () => {
  // Bug: the reader stops at the first merge, or the merge rewrites audiences to the survivor's conversation.
  withWorld((db, handle) => {
    addAccount(db, {
      id: 'account:c1',
      iface: 'telegram',
      authority: 'telegram/global',
      native: 'n9',
      person: 'person:c0',
    });
    addDmPlace(db, {
      id: 'place:dm-c1',
      iface: 'telegram',
      authority: 'telegram/global',
      account: 'account:c1',
      person: 'person:c0',
    });
    addClaim(db, 'claim:c1', 'person:c0', 'aud:dm:place:dm-c1');
    addPerson(db, 'person:middle');
    mergePeople(handle, 'person:c0', 'person:middle', { by: 'owner', now: 1000 });
    mergePeople(handle, 'person:middle', ANNA, { by: 'owner', now: 2000 });

    for (const asked of ['person:c0', 'person:middle', ANNA]) {
      const view = person(privateByPerson(db, asked, internalContext()));
      assert.equal(view.person.id, ANNA);
      assert.equal(view.person.requestedId, asked);
      assert.deepEqual(placeIds(view), [...ANNA_PLACES, 'place:dm-c1'].sort());
      assert.equal(view.records.find((one) => one.id === 'claim:c1')?.audienceId, 'aud:dm:place:dm-c1');
    }
    assert.deepEqual(
      person(privateByPerson(db, ANNA, internalContext()))
        .person.mergedFrom.slice()
        .sort(),
      ['person:c0', 'person:middle']
    );
  });
});

test('an unbound account leaves the view while its DM keeps its audience and the past link stays readable', () => {
  // Bug: revoking a wrong link either keeps exposing the DM, or destroys the history of who it belonged to.
  withWorld((db, handle) => {
    applyMemoryWrite(handle, {
      kind: 'person-link',
      op: 'unbind',
      accountId: 'account:a12',
      now: Date.parse('2026-11-03T00:00:00.000Z'),
    });
    const view = person(privateByPerson(db, ANNA, internalContext()));
    assert.deepEqual(view.accounts.map((one) => one.id).sort(), ['account:a11', 'account:a21']);
    assert.equal(placeIds(view).includes('place:dm-a12'), false);
    assert.equal(recordIds(view).includes('description:a12'), false);
    const past = view.pastLinks.find((one) => one.accountId === 'account:a12');
    assert.equal(past?.validToAt, '2026-11-03T00:00:00.000Z');
    const row = db.prepare("SELECT audience_id FROM descriptions WHERE id = 'description:a12'").get();
    assert.equal(row?.audience_id, 'aud:dm:place:dm-a12');
  });
});

test('past links are the owner view: a DM context gets none', () => {
  // Bug: a DM partner reads which accounts used to be linked to the person.
  withWorld((db, handle) => {
    applyMemoryWrite(handle, { kind: 'person-link', op: 'unbind', accountId: 'account:a12', now: 5000 });
    const view = person(privateByPerson(db, ANNA, dmOf(db, ANNA, 'discord', 'place:dm-a11')));
    assert.deepEqual(view.pastLinks, []);
  });
});

test('a proposed link gives no access until it is verified', () => {
  // Bug: a model proposal widens a DM audience.
  withWorld((db) => {
    addAccount(db, {
      id: 'account:proposed',
      iface: 'telegram',
      authority: 'telegram/global',
      native: 'n7',
      person: ANNA,
      link: 'proposed',
    });
    addDmPlace(db, {
      id: 'place:dm-proposed',
      iface: 'telegram',
      authority: 'telegram/global',
      account: 'account:proposed',
      person: null,
    });
    const view = person(privateByPerson(db, ANNA, internalContext()));
    assert.equal(
      view.accounts.some((one) => one.id === 'account:proposed'),
      false
    );
    assert.equal(placeIds(view).includes('place:dm-proposed'), false);
  });
});

test('a reused native id is a new generation: the later owner of the id reads none of the earlier DM', () => {
  // Bug: the join goes through the native id, so whoever gets a recycled id inherits a stranger's private memory.
  withWorld((db) => {
    addAccount(db, {
      id: 'account:a11-next',
      iface: 'discord',
      authority: 'discord/global',
      native: 'n1',
      generation: 2,
      person: BORIS,
    });
    addDmPlace(db, {
      id: 'place:dm-a11-next',
      iface: 'discord',
      authority: 'discord/global',
      account: 'account:a11-next',
      person: BORIS,
    });
    const hers = person(privateByPerson(db, ANNA, internalContext()));
    const his = person(privateByPerson(db, BORIS, internalContext()));
    assert.equal(
      hers.accounts.some((one) => one.id === 'account:a11-next'),
      false
    );
    assert.equal(placeIds(hers).includes('place:dm-a11-next'), false);
    assert.ok(placeIds(his).includes('place:dm-a11-next'));
    assert.equal(placeIds(his).includes('place:dm-a11'), false);
    assert.equal(his.accounts.find((one) => one.id === 'account:a11-next')?.generation, 2);
  });
});

test('equal native ids in two authorities of one interface stay two accounts', () => {
  // Bug: the join selects by interface and native id, so a second authority reads the first one's DM.
  withWorld((db) => {
    addAccount(db, {
      id: 'account:other-authority',
      iface: 'discord',
      authority: 'discord/other',
      native: 'n1',
      person: BORIS,
    });
    assert.equal(
      person(privateByPerson(db, ANNA, internalContext())).accounts.some((one) => one.id === 'account:other-authority'),
      false
    );
    assert.equal(
      person(privateByPerson(db, BORIS, internalContext())).accounts.some((one) => one.id === 'account:a11'),
      false
    );
  });
});

test('a DM observed before its account was bound is found through its partner account', () => {
  // Bug: the place row was written when the account had no person, so a join on `partner_person` misses it.
  withWorld((db) => {
    addAccount(db, {
      id: 'account:late',
      iface: 'telegram',
      authority: 'telegram/global',
      native: 'n8',
      person: ANNA,
    });
    addDmPlace(db, {
      id: 'place:dm-late',
      iface: 'telegram',
      authority: 'telegram/global',
      account: 'account:late',
      person: null,
    });
    assert.ok(placeIds(person(privateByPerson(db, ANNA, internalContext()))).includes('place:dm-late'));
  });
});
