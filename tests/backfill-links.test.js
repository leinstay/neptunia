// tools/backfill.mjs `links` and its pure part in tools/lib/backfill.mjs: which record lines get
// their link previews back (a URL in the text, no `links`, not a GIF site's), the new revision
// that carries them (revision + 1, every other field of the newest revision), the dry run that
// writes nothing, the stopped-bot rule of --write, and a second run that finds nothing left.
// Discord is a fake; every data directory is a fresh temp one.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { linkCandidates, linkRevision, linkUrls } from '../tools/lib/backfill.mjs';
import { main } from '../tools/backfill.mjs';
import { CliError } from '../tools/lib/cli.mjs';
import { toRecordLine } from '../src/memory/record.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-backfill-links-'));
after(() => fs.rmSync(TEMP, { recursive: true, force: true }));

const GUILD = '600000000000000001';
const SELF = '900000000000000001';
const ANA = '411111111111111111';
const CH = '700000000000000001';
const CH2 = '700000000000000002';
const T0 = Date.UTC(2026, 8, 23, 10, 0, 0);
const NOW = T0 + 20 * 86_400_000;
const id = (n) => `80000000000000${String(n).padStart(4, '0')}`;

/** A record line as the live path writes it. */
function rec(n, text, { channelId = CH, revision = 1, kind = 'seen', linkCards = undefined } = {}) {
  return {
    ...toRecordLine(
      { id: id(n), channelId, authorId: ANA, content: text, ts: T0 + n * 60_000, attachments: [], links: [], ...(linkCards ? { linkCards } : {}) },
      { kind, revision, now: () => T0, uuid: () => `u-${n}-${revision}` },
    ),
    guildId: GUILD,
  };
}

/** A normalized message (interfaces/discord/collect.js#normalizeMessage shape) with one link preview, none when `title` is empty. */
function normalized(n, { channelId = CH, title = 'Ο φάρος της Αλεξάνδρειας', url = 'https://example.org/faros' } = {}) {
  return {
    id: id(n), channelId, channelName: 'général', authorId: ANA, authorName: 'Ana', self: false, bot: false,
    content: `δες ${url}`, ts: T0 + n * 60_000, replyToId: null, mentionedUserIds: [], attachments: [],
    links: title ? [{ id: `${id(n)}#e0`, kind: 'link', url, title, text: 'Ένα από τα επτά θαύματα.', site: 'example.org', thumbnailUrl: null }] : [],
    stickers: [], emojis: [], forwarded: [], reactions: [],
  };
}

let dirs = 0;
function tmpDir() {
  const dir = path.join(TEMP, `d${(dirs += 1)}`);
  fs.mkdirSync(path.join(dir, 'data', 'guilds', GUILD), { recursive: true });
  return dir;
}

function writeRecord(dir, lines) {
  const file = path.join(dir, 'data', 'guilds', GUILD, 'record', '2026-09', '2026-09-23.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
  return file;
}

const readLines = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

/** Every file under `dir` with its content, for "nothing changed" checks. */
function tree(dir) {
  const out = {};
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return out;
}

function fakeHot() {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  config.bot = { ...config.bot, guildId: GUILD };
  return { config, prompts: {}, close() {} };
}

/** A fake Discord: messages by id; `gone` ids answer `deleted`, `closedChannels` `no-access`; `calls` lists the fetches. */
function fakeSource(messages, { gone = [], closedChannels = [] } = {}) {
  const calls = [];
  return {
    calls,
    async connect() {
      return {
        self: { id: SELF },
        async message(channelId, messageId) {
          calls.push({ channelId, messageId });
          if (closedChannels.includes(channelId)) return { status: 'no-access' };
          if (gone.includes(messageId)) return { status: 'deleted' };
          const found = messages.find((m) => m.id === messageId);
          return found ? { status: 'ok', message: found } : { status: 'deleted' };
        },
        async close() {},
      };
    },
  };
}

// ---- pure ------------------------------------------------------------------------------------

test('backfill links: the URLs of a text leave GIF sites out', () => {
  assert.deepEqual(linkUrls('δες https://example.org/a και http://tenor.com/view/x-1 <https://example.com/b>'), ['https://example.org/a', 'https://example.com/b']);
  assert.deepEqual(linkUrls('μόνο https://media.giphy.com/x.gif'), []);
  assert.deepEqual(linkUrls('χωρίς σύνδεσμο'), []);
  assert.deepEqual(linkUrls(null), []);
});

test('backfill links: candidates are the newest revisions with a non-GIF URL and no links', () => {
  const withCards = [{ kind: 'link', url: 'https://example.org/c', title: 'Ήδη εδώ', text: '', site: 'example.org' }];
  const lines = [
    rec(1, 'δες https://example.org/a'),
    rec(2, 'δες https://example.org/b'),
    rec(2, 'δες https://example.org/b ξανά', { revision: 2 }),
    rec(3, 'δες https://example.org/c', { linkCards: withCards }),
    rec(4, 'https://tenor.com/view/gata-123'),
    rec(5, 'καλημέρα σε όλους'),
    rec(6, 'δες https://example.org/f'),
    { kind: 'deleted', messageId: id(6), occurredAt: new Date(T0).toISOString(), scope: { channel: CH }, participants: [ANA] },
    rec(7, 'δες https://example.org/g', { kind: 'said' }),
    { kind: 'felt', occurredAt: new Date(T0).toISOString(), text: 'https://example.org/h' },
  ];
  const { candidates, counts } = linkCandidates(lines);
  assert.deepEqual(candidates.map((l) => [l.messageId, l.revision]), [[id(1), 1], [id(2), 2], [id(7), 1]]);
  assert.deepEqual(counts, { messages: 6, deleted: 1, withLinks: 1, gifOnly: 1, candidates: 3 });
});

test('backfill links: the new revision is revision + 1 with every other field and the links', () => {
  const newest = rec(2, 'δες https://example.org/b', { revision: 2 });
  const links = [{ url: 'https://example.org/b', title: 'Τίτλος', description: 'Περιγραφή', site: 'example.org' }];
  const next = linkRevision(newest, links, { id: 'u-new', recordedAt: new Date(NOW).toISOString() });
  assert.equal(next.revision, 3);
  assert.equal(next.id, 'u-new');
  assert.equal(next.recordedAt, new Date(NOW).toISOString());
  assert.deepEqual(next.links, links);
  const { id: _a, revision: _b, recordedAt: _c, links: _d, ...rest } = next;
  const { id: _e, revision: _f, recordedAt: _g, ...was } = newest;
  assert.deepEqual(rest, was, 'every other field as the newest revision');
  assert.equal(newest.revision, 2, 'the newest revision itself is not changed');
  assert.equal(linkRevision({ ...newest, revision: undefined }, links, { id: 'x', recordedAt: 'y' }).revision, 2, 'a line without a revision is revision 1');
});

// ---- the tool --------------------------------------------------------------------------------

test('backfill links: the dry run fetches, counts and writes nothing', async () => {
  const dir = tmpDir();
  writeRecord(dir, [
    rec(1, 'δες https://example.org/faros'),
    rec(2, 'δες https://example.org/x'),
    rec(3, 'δες https://example.org/y', { channelId: CH2 }),
    rec(4, 'https://tenor.com/view/a-1'),
    rec(5, 'δες https://example.org/z'),
  ]);
  const before = tree(dir);
  const source = fakeSource([normalized(1), normalized(5, { title: '' })], { gone: [id(2)], closedChannels: [CH2] });
  const out = await main(['links', '--guild', GUILD], { cwd: dir, hot: fakeHot(), source, now: () => NOW });
  assert.deepEqual(tree(dir), before, 'not one file written or changed');
  assert.equal(source.calls.length, 4, 'every candidate is fetched once, never the GIF line');
  assert.match(out, /dry run/);
  assert.match(out, /candidates: 4/);
  assert.match(out, /fetched: 2/);
  assert.match(out, /with links: 1/);
  assert.match(out, /deleted 1/);
  assert.match(out, /no-access 1/);
  assert.match(out, /no-preview 1/);
  assert.match(out, /lines to append: 1/);
  assert.ok(!out.includes('Αλεξάνδρειας') && !out.includes('example.org'), 'no message text or link in the output');
});

test('backfill links: --write appends a new revision once, and a second run finds no candidate', async () => {
  const dir = tmpDir();
  const file = writeRecord(dir, [rec(1, 'δες https://example.org/faros'), rec(2, 'καλημέρα')]);
  const hot = fakeHot();
  const source = fakeSource([normalized(1)]);
  const out = await main(['links', '--guild', GUILD, '--write'], { cwd: dir, hot, source, now: () => NOW });
  assert.match(out, /appended: 1/);
  const lines = readLines(file);
  assert.equal(lines.length, 3);
  const added = lines[2];
  assert.equal(added.messageId, id(1));
  assert.equal(added.revision, 2);
  assert.equal(added.text, lines[0].text);
  assert.equal(added.by, ANA);
  assert.equal(added.guildId, GUILD);
  assert.equal(added.occurredAt, lines[0].occurredAt);
  assert.equal(added.recordedAt, new Date(NOW).toISOString());
  assert.notEqual(added.id, lines[0].id);
  assert.deepEqual(added.links, [{ id: `${id(1)}#e0`, url: 'https://example.org/faros', title: 'Ο φάρος της Αλεξάνδρειας', description: 'Ένα από τα επτά θαύματα.', site: 'example.org' }]);
  const ids = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'ids.json'), 'utf8'));
  assert.ok(ids.includes(`${id(1)}:2`), 'the month index holds the new revision');

  source.calls.length = 0;
  const again = await main(['links', '--guild', GUILD, '--write'], { cwd: dir, hot, source, now: () => NOW });
  assert.match(again, /candidates: 0/);
  assert.equal(source.calls.length, 0, 'nothing is fetched again');
  assert.equal(readLines(file).length, 3, 'nothing appended twice');
});

test('backfill links: --write refuses while the bot runs, any run while a forget is under way', async () => {
  const dir = tmpDir();
  writeRecord(dir, [rec(1, 'δες https://example.org/faros')]);
  const guildDir = path.join(dir, 'data', 'guilds', GUILD);
  const hot = fakeHot();
  const source = fakeSource([normalized(1)]);
  fs.mkdirSync(path.join(guildDir, 'journal'), { recursive: true });
  fs.writeFileSync(path.join(guildDir, 'journal', '.running'), '');
  const before = tree(dir);
  await assert.rejects(main(['links', '--guild', GUILD, '--write'], { cwd: dir, hot, source, now: () => NOW }), (err) => err instanceof CliError && /running/.test(err.message));
  assert.equal(source.calls.length, 0, 'Discord is not read');
  assert.deepEqual(tree(dir), before);
  fs.rmSync(path.join(guildDir, 'journal', '.running'));
  fs.mkdirSync(path.join(guildDir, 'forgetting'), { recursive: true });
  fs.writeFileSync(path.join(guildDir, 'forgetting', `${ANA}.json`), '{}');
  await assert.rejects(main(['links', '--guild', GUILD], { cwd: dir, hot, source, now: () => NOW }), (err) => err instanceof CliError && /forget/.test(err.message));
  assert.equal(source.calls.length, 0);
  await assert.rejects(main(['links', '--guild', GUILD, '--dry-run'], { cwd: dir, hot, source, now: () => NOW }), CliError, 'the dry run is the default: no --dry-run');
});
