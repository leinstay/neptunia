import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, test } from 'node:test';
import { mentionDirectory, resolveMentions } from '../../../src/behavior/turn.ts';
import '../../../src/tools/operations/index.ts';
import { ownedBy } from '../../fixtures/owner-accounts.ts';

/** The test memory databases opened here; closed when the file is done. */
const OPENED_MEMORY: Array<{ close: () => Promise<void> }> = [];

after(async () => {
  for (const mem of OPENED_MEMORY) await mem.close();
});

function historyMsg(authorName: string, authorId: string, overrides = {}) {
  return { authorName, authorId, self: false, bot: false, ...overrides };
}

test('resolveMentions: replaces a known @name with a real Discord mention', () => {
  const history = [historyMsg('Alice', 'u1')];
  const result = resolveMentions('γεια @Alice πώς είσαι', history);
  assert.equal(result.text, 'γεια <@u1> πώς είσαι');
  assert.deepEqual(result.accountIds, ['u1']);
});

test('resolveMentions: an unknown name is left untouched', () => {
  const history = [historyMsg('Alice', 'u1')];
  const result = resolveMentions('γεια @Ghost', history);
  assert.equal(result.text, 'γεια @Ghost');
  assert.deepEqual(result.accountIds, []);
});

// A bot is a person to the persona, so a bot's name resolves like a member's.
test('resolveMentions: excludes its own lines from candidates, a bot line counts', () => {
  const history = [
    historyMsg('Zoë', 'self-id', { self: true }),
    historyMsg('SomeBot', 'bot-id', { bot: true }),
    historyMsg('Alice', 'u1'),
  ];
  const result = resolveMentions('@Zoë @SomeBot @Alice', history);
  assert.equal(result.text, '@Zoë <@bot-id> <@u1>');
  assert.deepEqual(result.accountIds, ['bot-id', 'u1']);
});

test('resolveMentions: longer names are matched before their shorter prefixes', () => {
  const history = [historyMsg('Anna', 'short-id'), historyMsg('AnnaMaria', 'long-id')];
  const result = resolveMentions('γεια @AnnaMaria', history);
  // Must not first match "@Anna" inside "@AnnaMaria" and leave "Maria" dangling.
  assert.equal(result.text, 'γεια <@long-id>');
  assert.deepEqual(result.accountIds, ['long-id']);
});

test('resolveMentions: replaces every occurrence of the same name', () => {
  const history = [historyMsg('Alice', 'u1')];
  const result = resolveMentions('@Alice γεια @Alice', history);
  assert.equal(result.text, '<@u1> γεια <@u1>');
  assert.deepEqual(result.accountIds, ['u1']);
});

test('resolveMentions: deduplicates authors that appear more than once in history', () => {
  const history = [historyMsg('Alice', 'u1'), historyMsg('Alice', 'u1', { content: 'again' })];
  const result = resolveMentions('@Alice', history);
  assert.deepEqual(result.accountIds, ['u1']);
});

test('resolveMentions: a stored multi-word name of a member shown resolves', () => {
  const history = [historyMsg('Whammy', 'u3')];
  const known = [
    { name: 'Más tarde nunca', id: 'u3' },
    { name: 'Whammy', id: 'u3' },
  ];
  const result = resolveMentions('@Más tarde nunca ναι', history, known);
  assert.equal(result.text, '<@u3> ναι');
  assert.deepEqual(result.accountIds, ['u3']);
});

test('resolveMentions: a transcript author wins a name a stored profile shares', () => {
  const history = [historyMsg('Bob', 'u2')];
  const result = resolveMentions('@Bob ναι', history, [{ name: 'Bob', id: 'u7' }]);
  assert.equal(result.text, '<@u2> ναι');
  assert.deepEqual(result.accountIds, ['u2']);
});

test('resolveMentions: a name only a member not handed over carries stays text', () => {
  // The caller hands over the members the request showed; anyone else is no candidate.
  const history = [historyMsg('Alice', 'u1')];
  const result = resolveMentions('@Ταξιάρχης γεια', history, [{ name: 'Αλίκη', id: 'u1' }]);
  assert.equal(result.text, '@Ταξιάρχης γεια');
  assert.deepEqual(result.accountIds, []);
});

test('resolveMentions: a stored name containing a shorter transcript name is matched first', () => {
  const history = [historyMsg('Anna', 'short-id')];
  const result = resolveMentions('@Anna María, @Anna', history, [{ name: 'Anna María', id: 'long-id' }]);
  assert.equal(result.text, '<@long-id>, <@short-id>');
  assert.deepEqual(result.accountIds, ['long-id', 'short-id']);
});

test('resolveMentions: the first member handed over keeps a stored name two share; empty names are skipped', () => {
  const known = [
    { name: 'Zoé', id: 'z1' },
    { name: 'Zoé', id: 'z2' },
    { name: '', id: 'z3' },
    { name: ' ', id: 'z4' },
  ];
  const result = resolveMentions('@Zoé @ x', [], known);
  assert.equal(result.text, '<@z1> @ x');
  assert.deepEqual(result.accountIds, ['z1']);
});

// The fallback directory: every member of the served guild the bot knows, behind the request's own sources.

/** A discord.js-shaped GuildMember: `displayName` (the nickname, else the global name), `nickname`, `user`. */
function cachedMember(
  id: string,
  {
    username,
    globalName = null,
    nickname = null,
    bot = false,
  }: { username: string; globalName?: string | null; nickname?: string | null; bot?: boolean }
) {
  return { id, nickname, displayName: nickname ?? globalName ?? username, user: { id, username, globalName, bot } };
}

test('resolveMentions: a member the request never showed resolves through the fallback directory', () => {
  const directory = [{ name: 'Ταξιάρχης', id: 'u9' }];
  const result = resolveMentions('@Ταξιάρχης https://example.com/a', [historyMsg('Alice', 'u1')], [], directory);
  assert.equal(result.text, '<@u9> https://example.com/a');
  assert.deepEqual(result.accountIds, ['u9']);
});

test('resolveMentions: a fallback name two members carry stays text, whatever its case', () => {
  const directory = [
    { name: 'Zoé', id: 'z1' },
    { name: 'zoé', id: 'z2' },
    { name: 'Zoé', id: 'z1' },
  ];
  const result = resolveMentions('@Zoé @ZOÉ ναι', [], [], directory);
  assert.equal(result.text, '@Zoé @ZOÉ ναι');
  assert.deepEqual(result.accountIds, []);
});

test("resolveMentions: the request's own sources win a name the fallback directory also has", () => {
  const history = [historyMsg('Bob', 'u2')];
  const known = [{ name: 'Αλίκη', id: 'u1' }];
  const directory = [
    { name: 'Bob', id: 'u7' },
    { name: 'bob', id: 'u8' },
    { name: 'Αλίκη', id: 'u5' },
  ];
  const result = resolveMentions('@Bob @Αλίκη @bob', history, known, directory);
  assert.equal(
    result.text,
    '<@u2> <@u1> <@u2>',
    'a shown member keeps the name in any case; an ambiguous fallback never takes it'
  );
  assert.deepEqual(result.accountIds, ['u1', 'u2']);
});

test('resolveMentions: the fallback matches case-insensitively, longest first and only as a whole name', () => {
  const directory = [
    { name: 'Anna María', id: 'long' },
    { name: 'Anna', id: 'short' },
    { name: 'Kai', id: 'k1' },
  ];
  const result = resolveMentions('@anna maría, @ANNA, @Kaiser', [], [], directory);
  assert.equal(result.text, '<@long>, <@short>, @Kaiser');
  assert.deepEqual(result.accountIds, ['long', 'short']);
});

test('resolveMentions: the case-insensitive fallback is for the directory only, never a shown name', () => {
  const result = resolveMentions('@alice', [historyMsg('Alice', 'u1')], [], []);
  assert.equal(result.text, '@alice');
  assert.deepEqual(result.accountIds, []);
});

// A bot is a person to the persona, so a bot's names are in the directory like a member's.
test('mentionDirectory: every name of the cached members and of the stored profiles, bots too, never the persona', () => {
  const members = [
    cachedMember('u1', { username: 'alice_01', globalName: 'Alice', nickname: 'Αλίκη' }),
    cachedMember('b1', { username: 'HelperBot', bot: true }),
    cachedMember('self-id', { username: 'persona', globalName: 'Persona' }),
  ];
  const profiles = [
    { id: 'u2', names: ['Bob'], aliases: [{ name: 'Bobby' }, { name: '' }, null] },
    { id: 'b1', names: ['HelperBot'], aliases: [] },
    { id: 'self-id', names: ['Persona'], aliases: [] },
    { id: 'u1', names: ['Alice'], aliases: [{ name: 'Lis' }] },
  ];
  const directory = mentionDirectory({ members, profiles, selfId: 'self-id' });
  const byId = (id: string) =>
    directory
      .filter((entry) => entry.id === id)
      .map((entry) => entry.name)
      .sort();
  assert.deepEqual(byId('u1'), ['Alice', 'Lis', 'alice_01', 'Αλίκη']);
  assert.deepEqual(byId('u2'), ['Bob', 'Bobby']);
  assert.deepEqual(byId('b1'), ['HelperBot']);
  assert.deepEqual(byId('self-id'), []);
});

test('mentionDirectory: no sources give an empty directory', () => {
  assert.deepEqual(mentionDirectory({}), []);
});

const DRAW_FOLDERS: Array<string> = [];

after(() => {
  for (const folder of DRAW_FOLDERS.splice(0)) rmSync(folder, { recursive: true, force: true });
});

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy(['u1']);
