// Tests for the owner's rule that links never reach the persona's stored memory:
// src/memory/clamp.ts#stripUrls, and every write point of every memory store that
// runs it (profiles, the private layer, guild notes, lessons and self facts,
// channel notes, the lorebook, recent notes, the archive, and the owner's ops).
import { accountOf, placeOfCommunity, placeOfConversation } from '../src/memory/addresses.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stripUrls } from '../src/memory/clamp.ts';
import { createStore } from '../src/memory/store.ts';
import { archiveEntry, archiveRevision } from '../src/memory/archive.ts';
import { runOp } from '../src/tools/impl/index.ts';
import { createOpsEnv } from '../src/tools/impl/env.ts';
import { createDiscordInterface } from '../interfaces/discord/index.ts';
import { tempDir } from './fixtures/tmp.ts';
import { asRecord } from './fixtures/records.ts';
import type { Untyped } from '../src/tools/types.ts';

// The Discord interface's capabilities object, as src/index.ts injects it.
const DISCORD = createDiscordInterface().capabilities;

const URL = 'https://example.com/a?b=1&c=2#d';

function tmpStore() {
  return createStore({ dataDir: tempDir('nep-links-') });
}

function noUrl(value: unknown) {
  assert.ok(!JSON.stringify(value).includes('http'), `a link was stored: ${JSON.stringify(value)}`);
}

// ---- the sanitizer ----

test('stripUrls: removes a link and keeps the words around it', () => {
  assert.equal(stripUrls(`δες ${URL} τώρα`), 'δες τώρα');
  assert.equal(stripUrls(`${URL} στην αρχή`), 'στην αρχή');
  assert.equal(stripUrls('HTTPS://EXAMPLE.COM/X café'), 'café');
});

test('stripUrls: a text that is only a link becomes empty', () => {
  assert.equal(stripUrls(URL), '');
  assert.equal(stripUrls(`  <${URL}>  `), '');
  assert.equal(stripUrls(`${URL} ${URL}`), '');
});

test('stripUrls: text without a link comes back exactly as given', () => {
  const text = '  όχι σύνδεσμος,  εδώ\n\nδεύτερη γραμμή ';
  assert.equal(stripUrls(text), text);
  assert.equal(stripUrls(undefined), '');
});

test('stripUrls: tidies the brackets, separators and spaces a link leaves', () => {
  assert.equal(stripUrls(`μου αρέσει (${URL}) πολύ`), 'μου αρέσει πολύ');
  assert.equal(stripUrls(`(δες ${URL})`), '(δες)');
  assert.equal(stripUrls(`α, ${URL}, β`), 'α, β');
  assert.equal(stripUrls(`Crème brûlée: ${URL}. Très bon.`), 'Crème brûlée. Très bon.');
  assert.equal(stripUrls(`δες ${URL}`), 'δες');
  assert.equal(stripUrls(`το άρθρο: ${URL}`), 'το άρθρο');
  assert.equal(stripUrls('δες https://el.wikipedia.org/wiki/Foo_(bar) εδώ'), 'δες εδώ');
  assert.equal(stripUrls(`[οδηγός](${URL}) για αρχάριους`), 'οδηγός για αρχάριους');
  assert.equal(stripUrls(`"${URL}" είπε`), 'είπε');
});

test('stripUrls: keeps lines, drops a line that held only a link, leaves mention tokens whole', () => {
  assert.equal(stripUrls(`πρώτη\n${URL}\nδεύτερη`), 'πρώτη\nδεύτερη');
  assert.equal(stripUrls(`γραμμή <${URL}>\nάλλη`), 'γραμμή\nάλλη');
  assert.equal(stripUrls(`<@123456789012345678> έστειλε ${URL}`), '<@123456789012345678> έστειλε');
});

// ---- a member's public profile ----

test('applyProfileOps: character, style and relationship are stored without links; a link alone writes nothing', () => {
  const store = tmpStore();
  const profile = store.applyProfileOps(accountOf(store, 'u1'), {
    character: `Γράφει πολύ ${URL} κάθε βράδυ.`,
    style: URL,
    relationship: `Φίλη (${URL}).`,
  });
  assert.equal(asRecord(profile).character, 'Γράφει πολύ κάθε βράδυ.');
  assert.equal(asRecord(profile).style, '');
  assert.equal(asRecord(profile).relationship, 'Φίλη.');
  store.applyProfileOps(accountOf(store, 'u1'), { character: URL, relationship: ` ${URL} ` });
  assert.equal(
    asRecord(store.getUser(accountOf(store, 'u1'))).character,
    'Γράφει πολύ κάθε βράδυ.',
    'a link alone never blanks the stored text'
  );
  assert.equal(asRecord(store.getUser(accountOf(store, 'u1'))).relationship, 'Φίλη.');
});

test('applyProfileOps: interests, details, aliases and the real name are stored without links', () => {
  const store = tmpStore();
  store.touchUser(accountOf(store, 'u1'), 'Ελένη', 1000);
  const profile = store.applyProfileOps(accountOf(store, 'u1'), {
    interests: {
      add: [
        { topic: `ταινίες ${URL}`, note: `βλέπει στο ${URL} συχνά` },
        { topic: URL, note: 'τίποτα' },
      ],
    },
    details: { add: [`ζει στη Λιόν ${URL}`, URL] },
    aliases: { add: [`Λένα ${URL}`, URL] },
    realName: `Hélène ${URL}`,
  });
  assert.deepEqual(
    asRecord(profile).interests.map((i: Untyped) => [i.topic, i.note]),
    [['ταινίες', 'βλέπει στο συχνά']]
  );
  assert.deepEqual(
    asRecord(profile).details.map((d: Untyped) => d.text),
    ['ζει στη Λιόν']
  );
  assert.deepEqual(
    asRecord(profile).aliases.map((a: Untyped) => a.name),
    ['Λένα']
  );
  assert.equal(asRecord(profile).realName.name, 'Hélène');
  noUrl(profile);
});

test('applyProfileOps: a real name that is only a link is not stored', () => {
  const store = tmpStore();
  const profile = store.applyProfileOps(accountOf(store, 'u1'), { realName: URL });
  assert.equal(asRecord(profile).realName, undefined);
});

test('updateUser: the prose fields are stored without links; a link alone does not blank them', () => {
  const store = tmpStore();
  store.updateUser(accountOf(store, 'u1'), { character: `Ήσυχη ${URL}`, portraitDueAt: '2026-10-14T00:00:00.000Z' });
  store.updateUser(accountOf(store, 'u1'), { style: URL, character: URL });
  const profile = store.getUser(accountOf(store, 'u1'));
  assert.equal(asRecord(profile).character, 'Ήσυχη');
  assert.equal(asRecord(profile).style, '');
  assert.equal(asRecord(profile).portraitDueAt, '2026-10-14T00:00:00.000Z');
});

test('addEpisodes: episodes are stored without links; one that is only a link is not added', () => {
  const store = tmpStore();
  const now = Date.UTC(2026, 9, 14);
  const added = store.addEpisodes(
    accountOf(store, 'u1'),
    [
      {
        date: '2026-10-14',
        what: `Έστειλε ένα βίντεο ${URL}`,
        quote: `κοίτα ${URL}`,
        feeling: `χαρά ${URL}`,
        weight: 2,
      },
      { date: '2026-10-14', what: URL, weight: 2 },
    ],
    { maxEpisodes: 10, now }
  );
  assert.equal(added, 1);
  const [episode] = asRecord(store.getUser(accountOf(store, 'u1'))).episodes;
  assert.deepEqual([episode.what, episode.quote, episode.feeling], ['Έστειλε ένα βίντεο', 'κοίτα', 'χαρά']);
});

test('adjustAffinity: a move reason is stored without links', () => {
  const store = tmpStore();
  const affinity = store.adjustAffinity(accountOf(store, 'u1'), 3, `βοήθησε ${URL}`, {
    maxDelta: 5,
    historySize: 10,
    now: 1000,
  });
  assert.equal(affinity?.reason, 'βοήθησε');
  assert.equal(asRecord(affinity?.history.at(-1)).reason, 'βοήθησε');
  const next = store.adjustAffinity(accountOf(store, 'u1'), 2, URL, { maxDelta: 5, historySize: 10, now: 2000 });
  assert.equal(asRecord(next?.history.at(-1)).reason, '', 'a reason that is only a link is no reason');
});

// ---- the private layer ----

test('private layer: relationship, items, episodes and reasons are stored without links', () => {
  const store = tmpStore();
  store.applyPrivateOps(accountOf(store, 'u1'), {
    relationship: `Της μιλά τα βράδια ${URL}`,
    interests: { add: [{ topic: `ποίηση ${URL}`, note: URL }] },
    details: { add: [`δουλεύει σε café ${URL}`] },
  });
  store.addPrivateEpisodes(accountOf(store, 'u1'), [{ date: '2026-10-14', what: `Μίλησαν ${URL}`, weight: 2 }], {
    maxEpisodes: 10,
    now: Date.UTC(2026, 9, 14),
  });
  store.adjustPrivateAffinity(accountOf(store, 'u1'), 2, `ειλικρίνεια ${URL}`, {
    maxDelta: 5,
    historySize: 10,
    now: 1000,
  });
  const priv = store.getPrivate(accountOf(store, 'u1'));
  assert.equal(asRecord(priv).relationship, 'Της μιλά τα βράδια');
  assert.deepEqual(
    asRecord(priv).interests.map((i: Untyped) => [i.topic, i.note]),
    [['ποίηση', '']]
  );
  assert.deepEqual(
    asRecord(priv).details.map((d: Untyped) => d.text),
    ['δουλεύει σε café']
  );
  assert.equal(asRecord(priv).episodes[0].what, 'Μίλησαν');
  assert.equal(asRecord(priv).affinity.reason, 'ειλικρίνεια');
  noUrl(priv);
});

// ---- the guild: server notes, lessons, self facts ----

test('updatePlace: patterns, starters, in-jokes and self facts are stored without links', () => {
  const store = tmpStore();
  store.updatePlace(placeOfCommunity(store, 'g1'), {
    patterns: `Μιλούν για μιμίδια ${URL}`,
    starters: `«καλημέρα» ${URL}`,
    injokes: [`ο βράχος ${URL}`, URL],
    self: [`μου αρέσει το τσάι ${URL}`, URL],
  });
  store.updatePlace(placeOfCommunity(store, 'g1'), { starters: URL });
  const guild = store.getPlace(placeOfCommunity(store, 'g1'));
  assert.equal(asRecord(guild).patterns, 'Μιλούν για μιμίδια');
  assert.equal(asRecord(guild).starters, '«καλημέρα»', 'a link alone never blanks the stored notes');
  assert.deepEqual(asRecord(guild).injokes, ['ο βράχος']);
  assert.deepEqual(asRecord(guild).self, ['μου αρέσει το τσάι']);
});

test('applyLearnedOps: lessons are stored without links; a link alone adds nothing', () => {
  const store = tmpStore();
  const learned = store.applyLearnedOps(
    placeOfCommunity(store, 'g1'),
    { add: [{ text: `το café ανοίγει στις 8 ${URL}` }, URL] },
    { seenAt: 1000 }
  );
  assert.deepEqual(
    learned.map((item) => asRecord(item).text),
    ['το café ανοίγει στις 8']
  );
  noUrl(store.getPlace(placeOfCommunity(store, 'g1')));
});

// ---- channel notes ----

test('updateChannel: purpose, topics and tone are stored without links; a link alone writes nothing', () => {
  const store = tmpStore();
  store.updateChannel(placeOfConversation(store, { id: 'c1' }), {
    purpose: `Μουσική ${URL}`,
    topics: URL,
    tone: 'χαλαρός',
  });
  const channel = store.updateChannel(placeOfConversation(store, { id: 'c1' }), { purpose: URL });
  assert.equal(asRecord(channel).purpose, 'Μουσική');
  assert.equal(asRecord(channel).topics ?? '', '');
  assert.equal(asRecord(channel).tone, 'χαλαρός');
});

// ---- the lorebook ----

test('setLore: title, keys and text are stored without links; a text that is only a link is no entry', () => {
  const store = tmpStore();
  const upserted = store.setLore(
    placeOfCommunity(store, 'g1'),
    [
      { title: `Ο βράχος ${URL}`, keys: ['βράχος', URL], text: `Ένα αστείο του server ${URL}.` },
      { title: 'Κενό', keys: ['κενό'], text: URL },
    ],
    { source: 'analyzer', now: 1000 }
  );
  assert.equal(upserted, 1);
  const [entry] = store.getLore(placeOfCommunity(store, 'g1'));
  assert.equal(asRecord(entry).title, 'Ο βράχος');
  assert.deepEqual(asRecord(entry).keys, ['βράχος']);
  assert.equal(asRecord(entry).text, 'Ένα αστείο του server.');
});

// ---- recent notes ----

test('applyRecentOps: a recent line is stored without links; one that is only a link is invalid', () => {
  const store = tmpStore();
  const now = Date.UTC(2026, 9, 14, 12);
  const counts = store.applyRecentOps(
    'g1',
    [
      { text: `Ανέβηκε νέο τραγούδι ${URL}`, at: now, placeId: 'c1' },
      { text: URL, at: now, placeId: 'c1' },
    ],
    { now }
  );
  assert.equal(counts.added, 1);
  assert.equal(counts.invalid, 1);
  assert.deepEqual(
    store.getRecent(placeOfCommunity(store, 'g1')).lines.map((line) => line.text),
    ['Ανέβηκε νέο τραγούδι']
  );
});

// ---- the archive ----

test('archiveEntry: the archived text holds no link, and its revision matches archiveRevision', () => {
  const item = { itemId: 'dt-1', text: `ζει στη Λιόν ${URL}`, weight: 1 };
  const entry = archiveEntry(item, { itemKind: 'detail', event: 'evicted', uuid: () => 'x' });
  assert.deepEqual(asRecord(entry).text, { text: 'ζει στη Λιόν' });
  assert.equal(asRecord(entry).revisionId, archiveRevision('detail', item));
});

test('restoreArchived: an item restored from an old archive line comes back without links', () => {
  const store = tmpStore();
  store.touchUser(accountOf(store, 'u1'), 'Ελένη', 1000);
  const entry = {
    itemKind: 'detail',
    itemId: 'dt-9',
    scope: { user: 'u1' },
    text: { text: `παίζει πιάνο ${URL}` },
    stored: { id: 9, firstSeen: '2026-10-01T00:00:00.000Z' },
    weight: 1,
  };
  const result = store.restoreArchived(placeOfCommunity(store, 'g1'), entry);
  assert.equal(result.restored, true);
  assert.equal(
    asRecord(store.getUser(accountOf(store, 'u1'))).details.find((d: Untyped) => d.itemId === 'dt-9').text,
    'παίζει πιάνο'
  );
  const self = store.restoreArchived(placeOfCommunity(store, 'g1'), {
    itemKind: 'selfFact',
    itemId: 'sf-1',
    scope: { guild: true },
    text: { text: URL },
  });
  assert.equal(self.restored, false, 'a self fact that is only a link is not restored');
});

// ---- the owner's ops (and the persona's skills that run them) ----

function opsEnv(store: ReturnType<typeof tmpStore>) {
  const rootDir = tempDir('nep-links-ops-');
  const hot = {
    config: {
      bot: { owners: ['42'] },
      llm: { model: 'x/y', maxRequestsPerDay: 10 },
      memory: { confirmAfter: 2 },
      lore: {},
    },
    prompts: { labels: {} },
    promptSources: {},
    promptsDir: path.join(rootDir, 'prompts'),
    localPromptsDir: path.join(rootDir, 'prompts.local'),
    rootDir,
    reloadConfig: () => true,
    reloadPrompts: () => true,
  };
  return createOpsEnv({
    discord: DISCORD,
    hot,
    store,
    client: {},
    spontaneous: {},
    calibrator: { ratio: 1 },
    isServedCommunity: (id: unknown) => id === 'g1',
  });
}

test('ops lore.add / learning.add / alias.add: what they store holds no link', async () => {
  const store = tmpStore();
  store.touchUser(accountOf(store, '7'), 'Ελένη', 1000);
  const ctx = { env: opsEnv(store), placeId: 'g1', accountId: '42', roleIds: [] };
  await runOp('lore.add', { title: `Ο βράχος ${URL}`, keys: `βράχος, ${URL}`, text: `Το αστείο ${URL}` }, ctx);
  await runOp('learning.add', { text: `το café κλείνει νωρίς ${URL}` }, ctx);
  await runOp('alias.add', { accountId: '7', name: `Λένα ${URL}` }, ctx);
  const [entry] = store.getLore(placeOfCommunity(store, 'g1'));
  assert.deepEqual(
    [asRecord(entry).title, asRecord(entry).keys, asRecord(entry).text],
    ['Ο βράχος', ['βράχος'], 'Το αστείο']
  );
  assert.deepEqual(
    asRecord(store.getPlace(placeOfCommunity(store, 'g1'))).learned.map((item: Untyped) => item.text),
    ['το café κλείνει νωρίς']
  );
  assert.deepEqual(
    asRecord(store.getUser(accountOf(store, '7'))).aliases.map((a: Untyped) => a.name),
    ['Λένα']
  );
});

test('ops lore.add: a text that is only a link is refused and stores nothing', async () => {
  const store = tmpStore();
  const ctx = { env: opsEnv(store), placeId: 'g1', accountId: '42', roleIds: [] };
  const result = await runOp('lore.add', { title: 'Κενό', keys: 'κενό', text: URL }, ctx);
  assert.notEqual(asRecord(result).ok, true);
  assert.deepEqual(store.getLore(placeOfCommunity(store, 'g1')), []);
});
