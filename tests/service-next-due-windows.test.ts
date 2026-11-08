// `/services selfreflection status` while no `selfreflection.schedule` is set (stage T.7 of the master plan): the diary
// is drawn from `selfreflection.windows` in `bot.timezone`, and `next due` names the start of the next window that can
// post, as an ISO moment, instead of `unknown`. A window whose `posts` maximum is 0 never posts and is skipped. The core
// holds no wake clock here (`wakeClock` answers null), so the answer comes from the configuration alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConsole } from '../src/interface/commands/console.ts';
import { parseCommandLine } from '../src/interface/commands/table.ts';
import { tempDir } from './fixtures/tmp.ts';

const at = (text: string): number => Date.parse(text);

type Window = { from: number; to: number; posts: [number, number] };

/** The `key: value` lines of `/services selfreflection status` for `config` at `now`. */
async function statusOf(config: unknown, now: number): Promise<Map<string, string>> {
  const dir = tempDir('nep-next-due-');
  const desk = createConsole({
    runOp: () => Promise.resolve({ status: 'ok', code: '', summary: 'done', data: null }),
    ownerReads: { lessons: () => '', aliases: () => '' },
    places: () => ['g1'],
    selfId: () => 'self-1',
    hot: { config },
    privateDir: dir,
    dataDir: dir,
    memoryDb: null,
    usage: null,
    metrics: null,
    chatLines: () => [],
    now: () => now,
    wakeClock: () => null,
  });
  const parsed = parseCommandLine('/services selfreflection status');
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason);
  const answer = await desk.run(parsed.name, parsed.args, { id: 'owner-1' });
  assert.equal(answer.status, 'ok', answer.text);
  return new Map(
    answer.text.split('\n').flatMap((line): Array<[string, string]> => {
      const found = /^([a-z ]+): (.*)$/.exec(line);
      return found === null ? [] : [[found[1] ?? '', found[2] ?? '']];
    })
  );
}

const config = (windows: Array<Window>, timezone = 'UTC') => ({
  bot: { timezone },
  selfreflection: { enabled: true, windows },
});

const DAYTIME: Array<Window> = [
  { from: 7, to: 11, posts: [0, 1] },
  { from: 18, to: 1, posts: [0, 2] },
];

test('between two windows, next due is the start of the next one', async () => {
  // Catches: status answers `unknown` for a diary that is on and has a window ahead.
  const fields = await statusOf(config(DAYTIME), at('2026-11-05T12:00:00Z'));
  assert.equal(fields.get('next due'), '2026-11-05T18:00:00.000Z');
});

test('inside the last window of the day, next due is the first window of tomorrow', async () => {
  // Catches: the window being lived in counts as ahead, or the day ends with no next moment.
  const fields = await statusOf(config(DAYTIME), at('2026-11-05T20:00:00Z'));
  assert.equal(fields.get('next due'), '2026-11-06T07:00:00.000Z');
});

test('the window hours are read in bot.timezone', async () => {
  // Catches: windows are laid on the UTC clock, so a diary in another zone is announced hours off.
  const fields = await statusOf(config(DAYTIME, 'Europe/Berlin'), at('2026-11-05T05:00:00Z'));
  assert.equal(fields.get('next due'), '2026-11-05T06:00:00.000Z');
});

test('a window that cannot post is skipped', async () => {
  // Catches: status promises a post at the start of a window whose maximum is zero.
  const fields = await statusOf(
    config([
      { from: 7, to: 11, posts: [0, 0] },
      { from: 12, to: 16, posts: [0, 1] },
    ]),
    at('2026-11-05T05:00:00Z')
  );
  assert.equal(fields.get('next due'), '2026-11-05T12:00:00.000Z');
});
