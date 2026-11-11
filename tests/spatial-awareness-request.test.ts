// buildRequest (src/behavior/prompt.ts) with `<spatial_awareness>`: where the block sits in a request, so the cached
// parts stay the same from place to place, what a turn of her own time says, and the owner's notes read from
// `config.spatial.notes` at the moment of use. The labels are the fixture's markers. Synthetic names only.
//
// The request input gains `whereabouts?: Whereabouts | null` (src/turn/request/spatial.ts). A heartbeat and a
// selfimprovement wake are her own time: their block says she is at the command line of her own server, and a
// selfreflection post that she is in her own world, whatever place the input names (stage AC, the owner's word of
// 2026-11-06). With the block the clock leaves `<now>`, which keeps her recent time away (the lead's ruling for stage AC).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatNow } from '../src/format.ts';
import { buildRequest } from './fixtures/built-request.ts';
import type { Built } from './fixtures/built-request.ts';
import { labels } from './fixtures/labels.ts';
import { NOW, baseInput, fakeConfig, fakePrompts } from './fixtures/prompt-rig.ts';

const WHEN = formatNow(NOW, 'Europe/Moscow', labels.locale);

const placeIn = (channelName: string) => ({
  kind: 'place',
  iface: 'discord',
  private: false,
  chain: [
    { id: `p-${channelName}`, kind: 'channel', name: channelName },
    { id: 'p-server', kind: 'server', name: 'Example Server' },
  ],
});

/** The parts of the user message. */
function partsOf(request: Built): Built['messages'][1]['content'] {
  const [, user] = request.messages;
  return user.content;
}

/** The text of the user part with no cache segment: the tail. */
const tailOf = (request: Built): string =>
  partsOf(request)
    .filter((part) => !part.cacheSegment)
    .map((part) => part.text)
    .join('');

/** The texts of the cached user parts, by segment. */
const cachedOf = (request: Built): Array<string> =>
  partsOf(request)
    .filter((part) => part.cacheSegment)
    .map((part) => `${part.cacheSegment}:${part.text}`);

/** The body of `<spatial_awareness>` in a request, null when it has none. */
function spatialOf(request: Built): string | null {
  const text = partsOf(request)
    .map((part) => part.text)
    .join('');
  const match = /<spatial_awareness>\n([\s\S]*?)\n<\/spatial_awareness>/.exec(text);
  return match ? (match[1] ?? null) : null;
}

test('the block sits in the tail, after the chat and right before the task, and holds her time away', () => {
  // Bug: the block lands in a cached part, so every move between channels rewrites the prompt cache.
  // Slice 7: every request is built on its frame, whose order puts `<spatial_awareness>` before `<chat>` and folds
  // `<now>` into it (the lead's decisions 6 and 7 of the plan), so her time away is the block's last lines.
  const offPeriods = [{ kind: 'paused', from: NOW - 3_600_000, to: NOW - 1_800_000 }];
  const request = buildRequest(baseInput({ whereabouts: placeIn('general'), offPeriods }));
  const tail = tailOf(request);
  assert.ok(tail.includes('<chat>'), 'the base input has a chat');
  // The owner's decision of 2026-11-11 (cache layout): the turn's own blocks follow `<chat>`, this one last before `<task>`.
  assert.ok(
    tail.includes('</spatial_awareness>\n\n<task>') && tail.indexOf('</chat>') < tail.indexOf('<spatial_awareness>'),
    tail
  );
  assert.ok(!tail.includes('<now>'), tail);
  assert.match(spatialOf(request) ?? '', /30 min/);
  for (const part of cachedOf(request)) assert.ok(!part.includes('<spatial_awareness>'), part);
});

test('two places give the same cached parts byte for byte', () => {
  const here = buildRequest(baseInput({ whereabouts: placeIn('general') }));
  const there = buildRequest(baseInput({ whereabouts: placeIn('off-topic') }));
  assert.ok(cachedOf(here).length > 0, 'the request has a cached part to compare');
  assert.deepEqual(cachedOf(here), cachedOf(there));
  assert.notEqual(spatialOf(here), spatialOf(there));
});

test('a reply turn names its place, the interface and the time', () => {
  const body = spatialOf(buildRequest(baseInput({ whereabouts: placeIn('general') })));
  // Slice 7: a native kind reads `spatial.kind` with its noun, so the channel has no `#` of the old `kinds.channel`.
  assert.equal(body?.split('\n')[0], `SPATIAL-PLACE channel general < server Example Server ON discord AT ${WHEN}`);
});

// The lead's word of 2026-11-08: the command line is a private place, as a direct chat is, so its body gains the
// private line after the command line's own.
test('the command line says the command line, then that it is private', () => {
  const body = spatialOf(buildRequest(baseInput({ whereabouts: { kind: 'cli' } })));
  assert.equal(body, [`SPATIAL-CLI AT ${WHEN}`, 'SPATIAL-PRIVATE'].join('\n'));
});

for (const wakeKind of ['heartbeat', 'selfimprovement']) {
  test(`a ${wakeKind} wake is on her own server, even when the turn rode in on a channel`, () => {
    // Bug: the transport anchor of her own time is named as the place she is in.
    const request = buildRequest(
      baseInput({
        mode: 'inner',
        wakeKind,
        prompts: fakePrompts({ inner: 'INNER_TASK', heartbeat: 'HEARTBEAT_TASK', selfimprovement: 'SELF_TASK' }),
        whereabouts: placeIn('general'),
      })
    );
    assert.equal(spatialOf(request), `SPATIAL-SERVER AT ${WHEN}`);
  });
}

test('a selfreflection post is in her own world, even when it is published to a channel', () => {
  // Bug: the diary names the channel it goes to, and the illusion of her own world breaks.
  const request = buildRequest(
    baseInput({
      mode: 'selfreflection',
      prompts: fakePrompts({ selfreflection: 'SELFREFLECTION_TASK' }),
      whereabouts: placeIn('general'),
    })
  );
  assert.equal(spatialOf(request), `SPATIAL-WORLD AT ${WHEN}`);
});

test('the clock leaves <now> when the block carries it, so the time appears once', () => {
  const user = partsOf(buildRequest(baseInput({ whereabouts: placeIn('general') })))
    .map((part) => part.text)
    .join('');
  assert.equal(user.split(WHEN).length - 1, 1, user);
});

test('an inner turn of another kind keeps the place it runs in', () => {
  const request = buildRequest(
    baseInput({
      mode: 'inner',
      wakeKind: 'intention_due',
      prompts: fakePrompts({ inner: 'INNER_TASK' }),
      whereabouts: placeIn('general'),
    })
  );
  assert.ok(spatialOf(request)?.startsWith('SPATIAL-PLACE channel general'), String(spatialOf(request)));
});

test("the owner's note comes from config.spatial.notes and reaches the channel through its server", () => {
  const config = { ...fakeConfig(), spatial: { notes: { 'p-server': 'adults only' } } };
  const body = spatialOf(buildRequest(baseInput({ config, whereabouts: placeIn('general') })));
  assert.equal(body?.split('\n').at(-1), 'SPATIAL-NOTE adults only');
});

test('with no note set there is no note line', () => {
  const body = spatialOf(buildRequest(baseInput({ whereabouts: placeIn('general') })));
  assert.ok(body !== null && !body.includes('SPATIAL-NOTE'), String(body));
});
