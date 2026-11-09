// Tests for src/behavior/sandbox.ts: the replay sandbox (a real moment's
// request as a turn builds it, sampled, nothing sent), the memory as it stood
// at the moment, the cached media a replay renders, and scripts/replay.ts's use
// of the module, all against fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as sandbox from '../src/behavior/sandbox.ts';
import { fetchHistoryWindow } from '../interfaces/discord/index.ts';
import { formatTranscript } from '../src/format.ts';
import { videoUrlCacheKey } from '../src/media/video-sites.ts';
import { createCalibrator } from '../src/llm/tokens.ts';
import '../src/tools/operations/index.ts';
import { handleOf } from '../src/behavior/handles.ts';

const {
  liveView,
  situationHistory,
  answerReply,
  sandboxRequestInput,
  SANDBOX_OMITS,
  momentView,
  momentCutoff,
  hiddenLater,
  replayMedia,
} = sandbox;
import { labels } from './fixtures/labels.ts';
import { call, completionOf, textAnswer, toolAnswer } from './fixtures/tool-answers.ts';
import type { Untyped } from '../src/tools/types.ts';
import { asRecord } from './fixtures/records.ts';
import { ALICE, BRUNO, CHANNEL, NOW, SELF_ID, fakeHot, fakeLlm, fakeStore, twoLines } from './fixtures/sandbox-kit.ts';

// The casts through `Parameters<typeof f>` hand a function a fake that carries only the fields the test reads.

// ---- liveView ----------------------------------------------------------------

test('liveView: reads prompts at call time', () => {
  const hot = fakeHot();
  const view = liveView({ hot, store: fakeStore(), placeId: 'g1' });
  assert.equal(view.prompts.reply, 'Someone called you: {{author}}.');
  hot.prompts = { ...hot.prompts, reply: 'EDITED' };
  hot.config = { ...hot.config, marker: 1 };
  assert.equal(view.prompts.reply, 'EDITED');
  assert.equal(view.config.marker, 1);
});

test('liveView: memory reads go to the store for the one guild', () => {
  const seen: Array<Array<Untyped>> = [];
  const store = {
    getPlace: (g: string) => (seen.push(['getPlace', g]), { patterns: 'p' }),
    getUser: (id: string) => (seen.push(['getUser', id]), { id }),
    listUserProfiles: () => (seen.push(['listUserProfiles']), []),
    listChannels: (g: string) => (seen.push(['listChannels', g]), []),
    getLore: (g: string) => (seen.push(['getLore', g]), []),
  };
  const view = liveView({ hot: fakeHot(), store, placeId: 'g1' });
  view.memory.getPlace();
  view.memory.getUser('u9');
  view.memory.listUserProfiles();
  view.memory.listChannels();
  view.memory.getLore();
  assert.deepEqual(seen, [
    ['getPlace', 'g1'],
    // A person's memory belongs to the account and not to a place, so these two name no place.
    ['getUser', 'u9'],
    ['listUserProfiles'],
    ['listChannels', 'g1'],
    ['getLore', 'g1'],
  ]);
  assert.equal('getPrivate' in view.memory, false);
});

test('liveView: the calibrator follows the live ratio and never feeds it', () => {
  const live = createCalibrator(0.8);
  const view = liveView({ hot: fakeHot(), store: fakeStore(), placeId: 'g1', calibrator: live });
  assert.equal(view.calibrator.ratio, 0.8);
  assert.equal(view.calibrator.apply(1000), live.apply(1000));

  // The sandbox observes nothing: the live ratio stays where it was.
  assert.equal(view.calibrator.observe(1000, 1500), 0.8);
  assert.equal(live.ratio, 0.8);

  // A real turn moves the live ratio; the view reads it at the moment of use.
  live.observe(1000, 1500);
  assert.notEqual(live.ratio, 0.8);
  assert.equal(view.calibrator.ratio, live.ratio);
  assert.equal(view.calibrator.apply(1000), live.apply(1000));

  // Without a live calibrator the view measures tokens as they are.
  const plain = liveView({ hot: fakeHot(), store: fakeStore(), placeId: 'g1' });
  assert.equal(plain.calibrator.ratio, 1);
  assert.equal(plain.calibrator.apply(123), 123);
  assert.equal(plain.calibrator.observe(1000, 1500), 1);
});

// ---- answerReply -------------------------------------------------------------

// Slice 7: the member's profile from the store went with the old `<people>` producer; a request on its frame reads
// people from the memory database, so this test keeps the system prompt, the answers and the no-write rule.
test('answerReply: sends the live system prompt and parses the answers, writing nothing', async () => {
  const hot = fakeHot();
  const store = fakeStore({
    userProfiles: { [ALICE]: { id: ALICE, names: ['Alice'], character: 'CHARACTER_MARKER solves chess problems' } },
  });
  const view = liveView({ hot, store, placeId: 'g1' });
  const llm = fakeLlm('<msg reply="#2">δεν ξέρω</msg><react to="#1">👍</react>');
  const result = await answerReply({
    view,
    situation: twoLines(),
    selfId: SELF_ID,
    selfName: 'Zoë',
    channel: CHANNEL,
    llm,
    samples: 1,
    at: NOW,
  });

  assert.equal(llm.calls.length, 1);
  const [system, user] = llm.calls[0].messages;
  assert.equal(system.role, 'system');
  assert.ok(system.content.includes('SYSTEM_MARKER'));
  assert.equal(result.request.system, system.content);
  assert.equal(typeof result.request.user, 'string');
  assert.equal(result.request.user, user.content);
  assert.ok(result.request.user.includes('what do you think about chess?'));
  assert.deepEqual(result.answers, [
    {
      messages: [{ text: 'δεν ξέρω', replyTo: 2 }],
      reactions: [{ to: 1, emoji: '👍' }],
      skip: false,
      think: '',
    },
  ]);
  assert.equal(result.stopped, false);
  assert.deepEqual(store.writes, [], 'nothing is written to memory');
});

/** A real moment: normalized messages, the trigger last. */
function storedMoment({ replyToSelf = false, mentions = [] }: Record<string, Untyped> = {}) {
  const base = {
    placeId: CHANNEL.id,
    channelName: 'general',
    channelCategory: 'Talk',
    channelTopic: null,
    bot: false,
    mentionedAccountIds: [],
    replyToId: null,
    forwardedFrom: null,
    attachments: [],
    links: [],
    forwarded: [],
    stickers: [],
    emojis: [],
    reactions: [],
  };
  return {
    history: [
      {
        ...base,
        id: '800000000000000001',
        authorId: SELF_ID,
        authorName: 'Zoë',
        self: true,
        content: 'it opens at nine',
        ts: NOW - 120000,
      },
      {
        ...base,
        id: '800000000000000002',
        authorId: ALICE,
        authorName: 'Alice',
        self: false,
        content: `REAL_MOMENT ${'é'.repeat(1500)}`,
        ts: NOW - 60000,
        replyToId: replyToSelf ? '800000000000000001' : null,
        mentionedAccountIds: mentions,
        reactions: [{ emoji: '👍', count: 2, mine: false }],
      },
    ],
  };
}

test('situationHistory: a stored moment is replayed as stored, the last message the trigger', () => {
  const moment = storedMoment();
  const { history, trigger, triggerKind } = situationHistory(moment);
  assert.equal(history, moment.history);
  assert.equal(trigger, moment.history[1]);
  assert.equal(triggerKind, 'mention');
  assert.equal(situationHistory(storedMoment({ replyToSelf: true })).triggerKind, 'reply');
  assert.throws(() => situationHistory({ history: [] }), /empty/);
  assert.throws(() => situationHistory({} as unknown as Parameters<typeof situationHistory>[0]), /empty/);
  assert.throws(() => situationHistory({ history: [moment.history[0]] }), /self/);
});

test('answerReply: a stored moment is answered from its own messages, reactions included', async () => {
  const view = liveView({ hot: fakeHot(), store: fakeStore(), placeId: 'g1' });
  const llm = fakeLlm('<msg>ok</msg>');
  const result = await answerReply({
    view,
    situation: storedMoment({ replyToSelf: true }),
    selfId: SELF_ID,
    selfName: 'Zoë',
    channel: CHANNEL,
    llm,
    samples: 1,
    at: NOW,
  });
  assert.ok(result.request.user.includes('REAL_MOMENT'));
  assert.ok(result.request.user.includes('it opens at nine'));
  assert.ok(result.request.user.includes('[reactions: '));
  assert.equal(llm.calls[0].options.countAgainstDailyCap, false);
  assert.equal(llm.calls[0].options.skipCalibration, true);
});

test('answerReply: a stored moment over the request budget loses its oldest messages, never the trigger', async () => {
  const hot = fakeHot();
  hot.config.llm.maxRequestTokens = 2500;
  const moment = storedMoment();
  const filler = Array.from({ length: 30 }, (_, i) => ({
    ...moment.history[0],
    id: `70000000000000${1000 + i}`,
    self: false,
    authorId: BRUNO,
    authorName: 'Bruno',
    content: `OLD_${i} ${'x'.repeat(700)}`,
    ts: NOW - 3_600_000 + i * 1000,
  }));
  const view = liveView({ hot, store: fakeStore(), placeId: 'g1' });
  const llm = fakeLlm('<msg>ok</msg>');
  const result = await answerReply({
    view,
    situation: { ...moment, history: [...filler, ...moment.history] },
    selfId: SELF_ID,
    selfName: 'Zoë',
    channel: CHANNEL,
    llm,
    samples: 1,
    at: NOW,
  });
  assert.ok(result.request.user.includes('REAL_MOMENT'));
  assert.ok(!result.request.user.includes('OLD_0 '));
});

test('answerReply: makes samples requests, none counted against the daily cap', async () => {
  const view = liveView({ hot: fakeHot(), store: fakeStore(), placeId: 'g1' });
  const llm = fakeLlm(['<msg>a</msg>', '<msg>b</msg>', '<skip/>']);
  const result = await answerReply({
    view,
    situation: twoLines(),
    selfId: SELF_ID,
    selfName: 'Zoë',
    channel: CHANNEL,
    llm,
    samples: 3,
    at: NOW,
  });

  assert.equal(llm.calls.length, 3);
  for (const { options } of llm.calls) {
    assert.equal(options.countAgainstDailyCap, false);
    assert.equal(options.skipCalibration, true);
    assert.equal('maxRequestTokens' in options, false);
  }
  assert.deepEqual(
    result.answers.map((a) => a.messages.map((m) => m.text)),
    [['a'], ['b'], []]
  );
  assert.equal(result.answers[2].skip, true);
});

test('answerReply: a ratio under 1 lets a capped section keep more', async () => {
  // Enough self notes to go well past a small aboutChat cap.
  const self = Array.from(
    { length: 80 },
    (_, i) => `note ${i + 1}: the persona likes the café on the corner and tea with honey`
  );
  const userTextAt = async (ratio: number) => {
    const hot = fakeHot();
    hot.config.context.caps.aboutChat = 300;
    const view = liveView({
      hot,
      store: fakeStore({ placeMemory: { self } }),
      placeId: 'g1',
      calibrator: createCalibrator(ratio),
    });
    const llm = fakeLlm('<skip/>');
    const result = await answerReply({
      view,
      situation: twoLines(),
      selfId: SELF_ID,
      selfName: 'Zoë',
      channel: CHANNEL,
      llm,
      samples: 1,
      at: NOW,
    });
    return result.request.user;
  };
  const atOne = await userTextAt(1);
  const atLow = await userTextAt(0.7);
  assert.ok(atOne.includes('note 1:'), 'the cap keeps some notes');
  assert.equal(atOne.includes('note 80:'), false, 'the cap is reached at ratio 1');
  assert.ok(atLow.length > atOne.length, `${atLow.length} > ${atOne.length}`);
});

test('answerReply: reports usage through onUsage; the result carries no token count of its own', async () => {
  const view = liveView({ hot: fakeHot(), store: fakeStore(), placeId: 'g1' });
  const llm = fakeLlm('<msg>a</msg>', { usage: { total_tokens: 120 }, estimated: 100 });
  const seen: Array<Array<Untyped>> = [];
  const result = await answerReply({
    view,
    situation: twoLines(),
    selfId: SELF_ID,
    selfName: 'Zoë',
    channel: CHANNEL,
    llm,
    samples: 2,
    at: NOW,
    onUsage: (usage, estimated) => seen.push([usage, estimated]),
  });
  assert.deepEqual(seen, [
    [{ total_tokens: 120 }, 100],
    [{ total_tokens: 120 }, 100],
  ]);
  assert.deepEqual(Object.keys(result).sort(), ['answers', 'request', 'stopped']);
});

test('answerReply: without usage, onUsage gets null and the estimate (what the budget then charges)', async () => {
  const view = liveView({ hot: fakeHot(), store: fakeStore(), placeId: 'g1' });
  const llm = fakeLlm('<msg>a</msg>', { usage: null, estimated: 70 });
  const seen: Array<Array<Untyped>> = [];
  await answerReply({
    view,
    situation: twoLines(),
    selfId: SELF_ID,
    selfName: 'Zoë',
    channel: CHANNEL,
    llm,
    samples: 2,
    at: NOW,
    onUsage: (usage, estimated) => seen.push([usage, estimated]),
  });
  assert.deepEqual(seen, [
    [null, 70],
    [null, 70],
  ]);
});

const EMOJI = [{ id: '600000000000000001', name: 'wave', animated: false }];
const GIF_LIBRARY = {
  nextId: 2,
  entries: {
    k1: {
      id: 'g1',
      kind: 'link',
      url: 'https://tenor.com/view/dance-1',
      site: 'Tenor',
      name: 'Danse',
      itemId: 'k1',
      messageId: 'm1',
      placeId: CHANNEL.id,
      count: 3,
      last: NOW - 86_400_000,
      firstSeen: NOW - 86_400_000,
    },
  },
  backfill: null,
};
const MEDIA_CACHE = {
  'emoji:600000000000000001': { text: 'a waving hand', ts: NOW - 1000 },
  k1: { text: 'a dancing cat', ts: NOW - 1000 },
};

test("answerReply: the server's custom emoji and the GIF library stay out of the turn", async () => {
  const view = liveView({ hot: fakeHot(), store: fakeStore(), placeId: 'g1' });
  const result = await answerReply({
    view,
    situation: twoLines(),
    selfId: SELF_ID,
    selfName: 'Zoë',
    channel: CHANNEL,
    llm: fakeLlm('<msg>ok</msg>'),
    samples: 1,
    at: NOW,
    customEmoji: EMOJI,
    gifs: GIF_LIBRARY,
    mediaCache: MEDIA_CACHE,
  });
  // B8: the emoji list left the turn too.
  assert.ok(!result.request.user.includes('<emoji>'), result.request.user);
  // B7: the GIF library left the turn.
  assert.ok(!result.request.user.includes('<gifs>'), result.request.user);
  assert.ok(!result.request.user.includes(labels.senses.customEmoji));
  assert.ok(!result.request.user.includes(labels.senses.gifs));

  // Nothing handed in, nothing rendered.
  const bare = await answerReply({
    view,
    situation: twoLines(),
    selfId: SELF_ID,
    selfName: 'Zoë',
    channel: CHANNEL,
    llm: fakeLlm('<msg>ok</msg>'),
    samples: 1,
    at: NOW,
  });
  assert.ok(!bare.request.user.includes('<emoji>'));
  assert.ok(!bare.request.user.includes('<gifs>'));
});

// B7: `<gif>` left the output contract, so one alone leaves nothing to do, as a retired tag does in a live turn.
test('answerReply: a <gif> alone is nothing to do', async () => {
  const view = liveView({ hot: fakeHot(), store: fakeStore(), placeId: 'g1' });
  const result = await answerReply({
    view,
    situation: twoLines(),
    selfId: SELF_ID,
    selfName: 'Zoë',
    channel: CHANNEL,
    llm: fakeLlm('<gif reply="#2">g1</gif>'),
    samples: 1,
    at: NOW,
    gifs: GIF_LIBRARY,
  });
  assert.equal(result.answers[0].skip, true);
});

test('answerReply: an aborted signal stops before the next sample', async () => {
  const controller = new AbortController();
  const view = liveView({ hot: fakeHot(), store: fakeStore(), placeId: 'g1' });
  const llm = fakeLlm('<msg>a</msg>', { onCall: () => controller.abort() });
  const result = await answerReply({
    view,
    situation: twoLines(),
    selfId: SELF_ID,
    selfName: 'Zoë',
    channel: CHANNEL,
    llm,
    samples: 3,
    at: NOW,
    signal: controller.signal,
  });
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].options.signal, controller.signal);
  assert.equal(result.answers.length, 1);
  assert.equal(result.stopped, true);
});

test('answerReply: an abort during a request returns what was collected', async () => {
  const controller = new AbortController();
  const view = liveView({ hot: fakeHot(), store: fakeStore(), placeId: 'g1' });
  let calls = 0;
  const llm = {
    complete: async () => {
      calls += 1;
      if (calls === 2) {
        controller.abort();
        throw new Error('aborted');
      }
      return { text: '<msg>a</msg>', usage: null, estimated: 5 };
    },
  };
  const result = await answerReply({
    view,
    situation: twoLines(),
    selfId: SELF_ID,
    selfName: 'Zoë',
    channel: CHANNEL,
    llm,
    samples: 3,
    at: NOW,
    signal: controller.signal,
  });
  assert.equal(result.answers.length, 1);
  assert.equal(result.stopped, true);
});

test('answerReply: an llm error other than an abort is thrown to the caller', async () => {
  const view = liveView({ hot: fakeHot(), store: fakeStore(), placeId: 'g1' });
  const llm = {
    complete: async () => {
      throw new Error('provider down');
    },
  };
  await assert.rejects(
    answerReply({
      view,
      situation: twoLines(),
      selfId: SELF_ID,
      selfName: 'Zoë',
      channel: CHANNEL,
      llm,
      samples: 1,
      at: NOW,
    }),
    /provider down/
  );
});

test('answerReply: reads everything through the view, so another view of the same shape needs no hot or store', async () => {
  const hot = fakeHot();
  const overlay = {
    prompts: { ...hot.prompts, 'system-prompt': 'OVERLAY_SYSTEM' },
    config: hot.config,
    memory: {
      getPlace: () => ({}),
      getUser: (id: string) => (id === ALICE ? { id: ALICE, names: ['Alice'], character: 'OVERLAY_CHARACTER' } : null),
      listUserProfiles: () => [],
      listChannels: () => [],
      getLore: () => [],
    },
  };
  const llm = fakeLlm('<skip/>');
  const result = await answerReply({
    view: overlay,
    situation: twoLines(),
    selfId: SELF_ID,
    selfName: 'Zoë',
    channel: CHANNEL,
    llm,
    samples: 1,
    at: NOW,
  } as unknown as Parameters<typeof answerReply>[0]);
  // Slice 7: the overlay's member profile went with the old `<people>` producer, so the system prompt is what it shows.
  assert.ok(result.request.system.includes('OVERLAY_SYSTEM'));
});

// ---- a stored moment replayed as the turn it was ----------------------------

/** The task texts of the reply, overheard and interject prompts, each naming itself. */
function kindHot(featureOverrides = {}) {
  const hot = fakeHot(featureOverrides);
  hot.prompts = {
    ...hot.prompts,
    reply: 'REPLY_TASK {{author}}: {{trigger}}',
    overheard: 'OVERHEARD_TASK {{author}}: {{trigger}}',
    interject: 'INTERJECT_TASK',
  };
  return hot;
}

const TRIGGER_ID = '800000000000000002';

function aliceStore() {
  return fakeStore({
    userProfiles: {
      [ALICE]: { id: ALICE, names: ['Alice'], character: 'ALICE_PORTRAIT' },
      [BRUNO]: { id: BRUNO, names: ['Bruno'], character: 'BRUNO_PORTRAIT' },
    },
  });
}

async function replay(situation: unknown, { hot = kindHot(), samples = 1, ...extra }: Record<string, Untyped> = {}) {
  const view = liveView({ hot, store: aliceStore(), placeId: 'g1' });
  const llm = fakeLlm('<skip/>');
  const result = await answerReply({
    view,
    situation,
    selfId: SELF_ID,
    selfName: 'Zoë',
    channel: CHANNEL,
    llm,
    samples,
    at: NOW,
    ...extra,
  } as unknown as Parameters<typeof answerReply>[0]);
  return { ...result, llm };
}

test('situationHistory: a stored kind replaces the guess; the trigger is found by its id', () => {
  const moment = { ...storedMoment(), kind: 'overheard', triggerId: TRIGGER_ID };
  const { trigger, triggerKind } = situationHistory(moment);
  assert.equal(triggerKind, 'overheard');
  assert.equal(trigger?.id, TRIGGER_ID);
  // A kind a turn does not know is no kind: the guess.
  assert.equal(situationHistory({ ...storedMoment(), kind: 'shouted' }).triggerKind, 'mention');
  // A line of hers after the trigger (her request held it) does not make the moment unusable.
  const later = { ...moment.history[0], id: '800000000000000003', content: 'a later line of hers', ts: NOW - 30_000 };
  const extended = situationHistory({ ...moment, history: [...moment.history, later] });
  assert.equal(extended.trigger?.id, TRIGGER_ID);
  assert.equal(extended.history.length, 3);
  // A trigger id that points at her own line is refused.
  assert.throws(() => situationHistory({ ...moment, triggerId: '800000000000000001' }), /self/);
});

// Slice 5: the initiate mode is deleted (a recorded initiate moment reads as a reply), so only an interjection is a
// moment with no trigger.
test('situationHistory: an interjection has no trigger, whoever wrote last', () => {
  for (const mode of ['interject']) {
    const own = { ...storedMoment(), mode, history: storedMoment().history.slice(0, 1) };
    const { history, trigger, triggerKind } = situationHistory(own);
    assert.equal(history.length, 1);
    assert.equal(trigger, null);
    assert.equal(triggerKind, null);
  }
});

test('answerReply: a moment stored as overheard is replayed with the overheard task and its trigger label', async () => {
  const overheard = await replay({ ...storedMoment(), mode: 'reply', kind: 'overheard', triggerId: TRIGGER_ID });
  assert.ok(
    overheard.request.user.includes(`OVERHEARD_TASK Alice: ${labels.triggers.overheard}`),
    overheard.request.user
  );
  assert.ok(!overheard.request.user.includes('REPLY_TASK'));
  // The same moment without its kind is the old guess: a mention under the reply task. Slice 7: the portrait and the
  // interlocutor mark of the old `<people>` and `<people_now>` are no part of a request on its frame.
  const guessed = await replay(storedMoment());
  assert.ok(guessed.request.user.includes(`REPLY_TASK Alice: ${labels.triggers.mention}`));
});

// Plan 2026-11-04-cli-and-memory B1: the `name` kind is gone with name triggers.
test("answerReply: a follow-up keeps its trigger label; a spontaneous moment takes its mode's task", async () => {
  for (const kind of ['followUp']) {
    const result = await replay({ ...storedMoment(), mode: 'reply', kind, triggerId: TRIGGER_ID });
    assert.ok(
      result.request.user.includes(`REPLY_TASK Alice: ${(labels.triggers as Record<string, string>)[kind]}`),
      kind
    );
  }
  const unasked = await replay({ ...storedMoment(), mode: 'interject', kind: null, triggerId: null });
  assert.ok(unasked.request.user.includes('INTERJECT_TASK'));
  assert.ok(!unasked.request.user.includes('REPLY_TASK'));
  assert.ok(!unasked.request.user.includes(labels.peopleNow.marks.interlocutor), 'nobody called her');
  // An unknown mode is a reply.
  const odd = await replay({ ...storedMoment(), mode: 'auto' });
  assert.ok(odd.request.user.includes('REPLY_TASK'));
});

test('answerReply: a follow-up and an untagged reply are replayed with the follow-up task; a tagged reply keeps reply.md', async () => {
  const hot = kindHot();
  hot.prompts = { ...hot.prompts, 'follow-up': 'FOLLOW_UP_TASK {{author}}: {{trigger}}' };
  const followUp = await replay({ ...storedMoment(), mode: 'reply', kind: 'followUp', triggerId: TRIGGER_ID }, { hot });
  assert.ok(followUp.request.user.includes(`FOLLOW_UP_TASK Alice: ${labels.triggers.followUp}`), followUp.request.user);
  assert.ok(!followUp.request.user.includes('REPLY_TASK'));
  const untagged = await replay(
    { ...storedMoment({ replyToSelf: true }), mode: 'reply', kind: 'reply', triggerId: TRIGGER_ID },
    { hot }
  );
  assert.ok(untagged.request.user.includes(`FOLLOW_UP_TASK Alice: ${labels.triggers.reply}`), untagged.request.user);
  const tagged = await replay(
    {
      ...storedMoment({ replyToSelf: true, mentions: [SELF_ID] }),
      mode: 'reply',
      kind: 'reply',
      triggerId: TRIGGER_ID,
    },
    { hot }
  );
  assert.ok(tagged.request.user.includes(`REPLY_TASK Alice: ${labels.triggers.reply}`), tagged.request.user);
  assert.ok(!tagged.request.user.includes('FOLLOW_UP_TASK'));
});

test('answerReply: the sandbox never runs the server search, so <senses> never offers it', async () => {
  assert.ok(Object.hasOwn(SANDBOX_OMITS, 'recallAvailable'));
  const view = liveView({ hot: fakeHot(), store: fakeStore(), placeId: 'g1' });
  const input = sandboxRequestInput({
    view,
    situation: twoLines(),
    selfId: SELF_ID,
    selfName: 'Zoë',
    channel: CHANNEL,
    at: NOW,
    recallAvailable: true,
  } as unknown as Parameters<typeof sandboxRequestInput>[0]);
  assert.equal(input.recallAvailable, null);
  const result = await replay(storedMoment(), { searchAvailable: true });
  // No tool is granted in a plain replay, so neither of her search lines is offered.
  assert.ok(!result.request.user.includes(labels.senses.searchTool));
  assert.ok(!result.request.user.includes(labels.senses.recallTool));
});

test('answerReply: samples 1 and 2 carry the same marked user part', async () => {
  const cachedHot = () => {
    const hot = fakeHot();
    hot.config.models.routes.core = [{ via: 'api', key: 'main', model: 'anthropic/claude-test', effort: null }];
    return hot;
  };
  const view = liveView({ hot: cachedHot(), store: fakeStore(), placeId: 'g1' });
  const llm = fakeLlm('<msg>ok</msg>');
  const result = await answerReply({
    view,
    situation: twoLines(),
    selfId: SELF_ID,
    selfName: 'Zoë',
    channel: CHANNEL,
    llm,
    samples: 2,
    at: NOW,
  });
  const [first, second] = llm.calls.map((call) => call.messages[1].content);
  assert.deepEqual(first, second);
  assert.equal(first.length, 1);
  assert.equal(first[0].type, 'text');
  assert.equal(first[0].text, result.request.user);
  assert.ok(first[0].cache_control, 'the part carries the cache marker');

  // One sample, or a request the client does not cache: the plain text as before.
  const single = fakeLlm('<msg>ok</msg>');
  await answerReply({
    view,
    situation: twoLines(),
    selfId: SELF_ID,
    selfName: 'Zoë',
    channel: CHANNEL,
    llm: single,
    samples: 1,
    at: NOW,
  });
  assert.equal(typeof single.calls[0].messages[1].content, 'string');
});

test("answerReply: every sample is sent as the replay's", async () => {
  const { llm } = await replay(storedMoment(), { samples: 2 });
  assert.equal(llm.calls.length, 2);
  assert.ok(
    llm.calls.every(
      (call) => call.options.origin === 'replay' && call.options.role === 'core' && call.options.purpose === 'reply'
    )
  );
});

// ---- the last hours: <recent> -------------------------------------------------

const HOUR = 3_600_000;

/** A recent line the way the store hands it over (src/memory/store.ts#getRecent). */
function recentLine(id: number, text: string, { at = NOW - HOUR, placeId = CHANNEL.id } = {}) {
  return { id, at, addedAt: new Date(at + 60_000).toISOString(), placeId, text, who: [], weight: 2 };
}

/** A store that keeps a recent store too, counting its reads. */
function recentStore(lines: Untyped) {
  const reads: Array<Untyped> = [];
  return {
    ...fakeStore(),
    reads,
    getRecent: (placeId: string) => (reads.push(placeId), { nextId: lines.length + 1, lines }),
  };
}

test('liveView: the recent store is read for the one guild; a store without one reads as none', () => {
  const store = recentStore([recentLine(1, 'η αγορά άνοιξε')]);
  const view = liveView({ hot: fakeHot(), store, placeId: 'g1' });
  assert.deepEqual(
    view.memory.getRecent()?.lines.map((line) => line.text),
    ['η αγορά άνοιξε']
  );
  assert.deepEqual(store.reads, ['g1']);
  assert.equal(liveView({ hot: fakeHot(), store: fakeStore(), placeId: 'g1' }).memory.getRecent(), null);
});

/** Every input buildRequest reads: the keys it destructures from `input` and each `input.<key>` of its body. */
function buildRequestInputs() {
  const source = fs.readFileSync(new URL('../src/behavior/prompt.ts', import.meta.url), 'utf8');
  // The signature carries the input's type since the file is TypeScript, so only its start is searched.
  const start = source.indexOf('export function buildRequest(input');
  assert.ok(start >= 0, 'buildRequest is where this test reads it');
  const body = source.slice(start, source.indexOf('\n}\n', start));
  const destructured = /const \{([^}]*)\} = input;/.exec(body);
  assert.ok(destructured, 'buildRequest destructures its input');
  const keys = destructured[1]
    .split(',')
    .map((part) => part.trim().split(/[\s=:]/)[0])
    .filter(Boolean);
  for (const match of body.matchAll(/\binput\.(\w+)/g)) keys.push(match[1]);
  return new Set(keys);
}

test('sandboxRequestInput: names every input buildRequest reads; what it leaves out is SANDBOX_OMITS, passed as absent', () => {
  const view = liveView({ hot: fakeHot(), store: fakeStore(), placeId: 'g1' });
  const wanted = buildRequestInputs();
  // Slice 7: `pulled` left the input; the destructured key buildRequest reads is `currentChannelId`.
  assert.ok(
    wanted.has('history') && wanted.has('currentChannelId') && wanted.has('gifs'),
    'the reader finds both kinds of key'
  );
  for (const situation of [twoLines(), { ...storedMoment(), mode: 'interject' }]) {
    const input = sandboxRequestInput({ view, situation, selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, at: NOW });
    assert.deepEqual(Object.keys(input).sort(), [...wanted].sort());
    const passed = Object.keys(input).filter((key) => !Object.hasOwn(SANDBOX_OMITS, key));
    assert.deepEqual(new Set([...passed, ...Object.keys(SANDBOX_OMITS)]), wanted);
    for (const key of passed) assert.notEqual(input[key], undefined, `${key} is named`);
    for (const [key, reason] of Object.entries(SANDBOX_OMITS)) {
      assert.ok(typeof reason === 'string' && reason.trim(), `${key} says why`);
      // PR 7d: drawQuota became the boolean drawOn, absent as false.
      const absent =
        input[key] === null || input[key] === false || (Array.isArray(input[key]) && input[key].length === 0);
      assert.ok(absent, `${key} is left out`);
    }
  }
});

/** A fake model that answers each request, in order, with the next of `answers` (an object as it is, a string as speech only). */
function fakeToolLlm(answers: Untyped) {
  const calls: Array<{ messages: Untyped; options: Untyped }> = [];
  return {
    calls,
    complete: async (messages: unknown, options: unknown) => {
      calls.push({ messages, options });
      return completionOf(answers[calls.length - 1] ?? '<think>x</think>');
    },
  };
}

/** A view whose persona holds exactly the skills `names`, over `config` additions (`skills`, `features`). */
function grantedView(names: Untyped, { tools = {}, features = {} } = {}) {
  const hot = fakeHot(features);
  hot.config.tools = tools;
  hot.config = sandbox.personaGrantsConfig(hot.config, SELF_ID, names);
  return liveView({ hot, store: fakeStore(), placeId: 'g1' });
}

const OK_DATA = (skill: unknown, text = '') => ({
  verdict: { stage: 'gateway', ok: true },
  executed: { skill, args: {} },
  result: { skill, status: 'ok', data: { text } },
});
const BOUNDS = { settings: { maxSteps: 3, timeBudgetMs: 60000, maxCallsPerStep: 4 } };

test('sandboxToolset: her granted and carried-over skills as native definitions, or as the <tools> text on the text transport', () => {
  const native = sandbox.sandboxToolset({ view: grantedView(['learning.add']), selfId: SELF_ID });
  assert.equal(native.transport, 'native');
  assert.ok(native.names.includes('learning.add') && native.names.includes('message.create'));
  assert.equal(native.tools.length, native.names.length);
  assert.equal(native.block, null);
  assert.ok(native.tokens > 0);
  const text = sandbox.sandboxToolset({
    view: grantedView(['learning.add'], { tools: { transport: 'text' } }),
    selfId: SELF_ID,
  });
  assert.equal(text.transport, 'text');
  assert.equal(typeof text.block, 'string');
  assert.equal(text.tokens, 0);
});

test('sandboxRequestInput: a skill scenario passes its inventory and her tools set; everything else SANDBOX_OMITS leaves out stays out', () => {
  const { SKILL_SCENARIO_OMITS } = sandbox;
  assert.deepEqual(
    Object.keys(SKILL_SCENARIO_OMITS).sort(),
    Object.keys(SANDBOX_OMITS)
      .filter((key) => !['skillsInventory', 'toolsGranted', 'toolsBlock', 'toolsTokens'].includes(key))
      .sort()
  );
  const view = liveView({ hot: fakeHot(), store: fakeStore(), placeId: 'g1' });
  const wanted = buildRequestInputs();
  const rows = [
    { name: 'learning.add', title: 'Add a lesson', whenToUse: 'when asked', allowed: true, reason: 'allowed' },
  ];
  const toolset = { names: ['learning.add'], block: 'TOOLS_MARKER', tokens: 321 };
  const input = sandboxRequestInput({
    view,
    situation: twoLines(),
    selfId: SELF_ID,
    selfName: 'Zoë',
    channel: CHANNEL,
    at: NOW,
    skillsInventory: rows,
    toolset,
  } as unknown as Parameters<typeof sandboxRequestInput>[0]);
  assert.equal(input.skillsInventory, rows);
  assert.deepEqual([input.toolsGranted, input.toolsBlock, input.toolsTokens], [['learning.add'], 'TOOLS_MARKER', 321]);
  const passed = Object.keys(input).filter((key) => !Object.hasOwn(SKILL_SCENARIO_OMITS, key));
  assert.deepEqual(new Set([...passed, ...Object.keys(SKILL_SCENARIO_OMITS)]), wanted);
  for (const key of passed) assert.notEqual(input[key], undefined, `${key} is named`);
  for (const key of Object.keys(SKILL_SCENARIO_OMITS)) {
    // PR 7d: drawQuota became the boolean drawOn, absent as false.
    const absent =
      input[key] === null || input[key] === false || (Array.isArray(input[key]) && input[key].length === 0);
    assert.ok(absent, `${key} is left out`);
  }
  // An empty catalogue is no block, as in any other sandbox turn; no tools set, no tools.
  assert.equal(
    sandboxRequestInput({
      view,
      situation: twoLines(),
      selfId: SELF_ID,
      selfName: 'Zoë',
      channel: CHANNEL,
      at: NOW,
      skillsInventory: [],
    }).skillsInventory,
    null
  );
  const bare = sandboxRequestInput({
    view,
    situation: twoLines(),
    selfId: SELF_ID,
    selfName: 'Zoë',
    channel: CHANNEL,
    at: NOW,
    toolset: { names: [], block: null, tokens: 0 },
  } as unknown as Parameters<typeof sandboxRequestInput>[0]);
  assert.deepEqual([bare.toolsGranted, bare.toolsBlock, bare.toolsTokens], [null, null, null]);
});

test('answerSkillScenario: native -- the tools ride on every request; a data result is read in a second step that appends to the first messages; an effect covers the speech; nothing real runs', async () => {
  const { answerSkillScenario } = sandbox;
  const view = grantedView(['learning.add', 'web.search']);
  const llm = fakeToolLlm([
    toolAnswer('<think>a</think><msg>μια στιγμή</msg>', [call('web.search', { query: 'chess' }, { id: 'w1' })]),
    '<think>b</think><msg>έγινε</msg>',
    toolAnswer('<think>c</think><msg>σημειώθηκε</msg>', [call('learning.add', { text: 'όχι spoilers' })]),
    toolAnswer('<think>d</think><msg>πάω</msg>', [call('nope.skill', {})]),
    '<think>e</think><msg>δεν υπάρχει</msg>',
  ]);
  const seen: Array<{ given: Untyped; context: Untyped }> = [];
  const result = await answerSkillScenario({
    view,
    situation: twoLines(),
    selfId: SELF_ID,
    selfName: 'Zoë',
    channel: CHANNEL,
    llm,
    runs: 3,
    at: NOW,
    loop: BOUNDS,
    onCall: (given: Untyped, context: unknown) => {
      seen.push({ given, context });
      return given.skill === 'web.search' ? OK_DATA('web.search', 'RESULT_MARKER') : OK_DATA(given.skill);
    },
  });
  assert.equal(llm.calls.length, 5, 'run 1: two requests, run 2: one, run 3: two');
  for (const { options } of llm.calls) {
    assert.deepEqual(
      [options.origin, options.countAgainstDailyCap, options.skipCalibration, options.purpose, options.toolChoice],
      ['replay', false, true, 'reply', 'auto']
    );
    assert.ok(
      options.tools.some((tool: Untyped) => tool.function.name === 'web_search'),
      'her tools are sent'
    );
  }
  assert.ok(result.request.toolsTokens > 0 && result.request.tools >= 2);
  // Run 1: the call reached onCall with its tool call id; the second request appends to the first messages, which are the same objects.
  assert.deepEqual(seen[0].given, {
    skill: 'web.search',
    args: { query: 'chess' },
    body: '',
    toolCallId: 'w1',
    index: 0,
  });
  assert.ok(seen[0].context.idByIndex instanceof Map);
  assert.equal(seen[0].context.history.at(-1).authorId, ALICE);
  const [first, second] = [llm.calls[0].messages, llm.calls[1].messages];
  assert.equal(second[0], first[0]);
  assert.equal(second[1], first[1], 'the first user message is never rebuilt');
  assert.equal(second[2].role, 'assistant');
  assert.equal(second[2].tool_calls[0].id, 'w1');
  assert.deepEqual([second[3].role, second[3].tool_call_id], ['tool', 'w1']);
  assert.ok(second[3].content.includes('RESULT_MARKER'));
  assert.equal(second[4].role, 'user');
  assert.ok(second[4].content[0].text.includes(labels.task.step.held), 'the held speech is told');
  const [one, two, three] = result.runs;
  assert.equal(one.loop?.steps[0].held, true, 'a data result does not cover the speech of its step');
  assert.deepEqual(
    one.loop?.steps[0].answer.messages.map((m: Untyped) => m.text),
    ['μια στιγμή']
  );
  assert.deepEqual(
    one.followUp.answer.messages.map((m: Untyped) => m.text),
    ['έγινε']
  );
  assert.equal(one.followUp.extraCall, false);
  assert.deepEqual([one.call.skill, one.outcome.result.status], ['web.search', 'ok']);
  // Run 2: an effect covers the speech, nothing is read, no second request.
  assert.deepEqual([two.loop?.steps.length, two.loop?.steps[0].held, two.followUp], [1, false, null]);
  // Run 3: an unknown skill is refused with a result she reads; onCall never saw it.
  assert.equal(seen.length, 2);
  assert.equal(three.loop?.steps[0].calls[0].outcome.result.code, 'unknown-skill');
  assert.equal(three.callError, 'unknown-skill');
  assert.equal(three.loop?.steps[0].held, true);
  assert.equal(three.loop?.steps.length, 2);
  assert.equal(result.stopped, false);
  assert.equal(one.loop?.steps[0].thinkMissing, false);
});

test('answerSkillScenario: the last step allowed is final -- its calls get loop-cap results and its speech is held; a missing <think> is counted', async () => {
  const { answerSkillScenario } = sandbox;
  const view = grantedView(['web.search']);
  const llm = fakeToolLlm([
    toolAnswer('<think>a</think>', [call('web.search', { query: 'a' })]),
    toolAnswer('no think<msg>αργά</msg>', [call('web.search', { query: 'b' })]),
  ]);
  let n = 0;
  const result = await answerSkillScenario({
    view,
    situation: twoLines(),
    selfId: SELF_ID,
    selfName: 'Zoë',
    channel: CHANNEL,
    llm,
    runs: 1,
    at: NOW,
    loop: { settings: { maxSteps: 1, timeBudgetMs: 60000, maxCallsPerStep: 4 } },
    onCall: (given: Untyped) => {
      n += 1;
      return OK_DATA(given.skill, 'R');
    },
  });
  assert.equal(llm.calls.length, 2);
  assert.ok(llm.calls[1].messages.at(-1).content[0].text.includes(labels.task.step.last), 'the last-step notice');
  const [run] = result.runs;
  assert.equal(n, 1, "the final answer's call never runs");
  const last = run.loop?.steps[1];
  assert.deepEqual(
    [last?.calls[0].outcome.result.code, last?.capped, last?.held, last?.thinkMissing, last?.dropped],
    ['loop-cap', 'steps', true, true, 1]
  );
  assert.equal(run.loop?.steps[0].thinkMissing, false);
});

test('answerSkillScenario: the text transport -- no tools field, the <tools> block in the request, <tool_call> blocks read, results as <tool_result> parts', async () => {
  const { answerSkillScenario } = sandbox;
  const view = grantedView(['web.search'], { tools: { transport: 'text' } });
  const llm = fakeToolLlm([
    textAnswer('<think>a</think><msg>μια στιγμή</msg>', [call('web.search', { query: 'chess' }, { id: 'w1' })]),
    '<think>b</think><msg>έγινε</msg>',
  ]);
  const result = await answerSkillScenario({
    view,
    situation: twoLines(),
    selfId: SELF_ID,
    selfName: 'Zoë',
    channel: CHANNEL,
    llm,
    runs: 1,
    at: NOW,
    loop: BOUNDS,
    onCall: (given: Untyped) => OK_DATA(given.skill, 'RESULT_MARKER'),
  });
  assert.equal('tools' in llm.calls[0].options, false);
  assert.ok(result.request.user.includes('<tools>'));
  const [run] = result.runs;
  assert.deepEqual(
    run.loop?.steps[0].answer.messages.map((m: Untyped) => m.text),
    ['μια στιγμή'],
    'the block is cut out of her speech'
  );
  assert.equal(run.call.skill, 'web.search');
  const appended = llm.calls[1].messages;
  assert.equal(appended[2].role, 'assistant');
  assert.equal(appended[3].role, 'user');
  assert.ok(appended[3].content[0].text.startsWith('<tool_result id="s1c1" name="web.search" status="ok">'));
  assert.ok(appended[3].content[0].text.includes('RESULT_MARKER'));
  assert.deepEqual(
    run.followUp.answer.messages.map((m: Untyped) => m.text),
    ['έγινε']
  );
});

// ---- the memory as it stood at the moment: momentView, momentCutoff, hiddenLater ---------------

const CUTOFF = Date.UTC(2026, 8, 29, 18, 2, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const BEFORE = iso(CUTOFF - 60_000);
const EARLIER = iso(CUTOFF - 3_600_000);
const AT = iso(CUTOFF);
const AFTER = iso(CUTOFF + 60_000);

function aliceProfile() {
  return {
    id: ALICE,
    names: ['Alice'],
    firstSeen: '2026-08-01T10:00:00.000Z',
    lastSeen: AFTER,
    messageCount: 40,
    character: 'Argues with care.',
    style: 'Long messages, accents: é à.',
    relationship: 'Old friend of the persona.',
    interests: [
      { topic: 'chess', note: '', weight: 3, firstSeen: EARLIER, lastSeen: AFTER },
      { topic: 'όπερα', note: 'new', weight: 1, firstSeen: AT, lastSeen: AT },
      { topic: 'sailing', note: '', weight: 1, firstSeen: AFTER, lastSeen: AFTER },
      { topic: 'tea', note: '', weight: 1, firstSeen: null, lastSeen: null },
    ],
    details: [
      { id: 1, text: 'lives by the sea', weight: 2, firstSeen: BEFORE, lastSeen: AFTER },
      { id: 2, text: 'lost the argument', weight: 1, firstSeen: AFTER, lastSeen: AFTER },
      { id: 3, text: 'undated detail', weight: 1, firstSeen: null, lastSeen: null },
    ],
    detailsSeq: 4,
    aliases: [
      { name: 'Ali', weight: 2, firstSeen: EARLIER, lastSeen: AFTER },
      { name: 'Λίσα', weight: 1, firstSeen: AT, lastSeen: AT },
    ],
    affinity: {
      score: 12,
      reason: 'R3 after the argument',
      history: [
        { ts: EARLIER, delta: 5, appliedDelta: 5, score: 5, reason: 'R1' },
        { ts: BEFORE, delta: 4, appliedDelta: 4, score: 9, reason: 'R2' },
        { ts: AFTER, delta: 3, appliedDelta: 3, score: 12, reason: 'R3 after the argument' },
      ],
    },
    episodes: [
      { date: '2026-09-20', what: 'old episode', quote: '', feeling: '', weight: 3, addedAt: EARLIER },
      { date: '2026-09-29', what: 'the argument itself', quote: '', feeling: 'won it', weight: 4, addedAt: AFTER },
      { date: '2026-09-29', what: 'written at the cutoff', quote: '', feeling: '', weight: 2, addedAt: AT },
      { date: '2026-09-28', what: 'no addedAt, the day before', quote: '', feeling: '', weight: 2 },
      { date: '2026-09-29', what: 'no addedAt, the same day', quote: '', feeling: '', weight: 2 },
      { what: 'no date at all', quote: '', feeling: '', weight: 1 },
    ],
    updatedAt: AFTER,
  };
}

function brunoProfile() {
  return {
    id: BRUNO,
    names: ['Bruno'],
    character: 'Quiet.',
    style: '',
    relationship: '',
    interests: [],
    details: [],
    aliases: [],
    affinity: {
      score: -4,
      reason: 'R only after',
      history: [{ ts: AFTER, delta: -4, appliedDelta: -4, score: -4, reason: 'R only after' }],
    },
    episodes: [],
  };
}

function placeMemory() {
  return {
    patterns: 'Short greetings.',
    starters: 'Games.',
    injokes: ['the café'],
    self: ['likes rain'],
    learned: [
      { id: 1, text: 'answer in one line', weight: 3, firstSeen: '2026-09-01T00:00:00.000Z', lastSeen: AFTER },
      { id: 2, text: 'taught right after', weight: 1, firstSeen: AFTER, lastSeen: AFTER, from: `<@${ALICE}>` },
    ],
    learnedNextId: 3,
  };
}

function loreEntries() {
  return [
    {
      id: 'a',
      title: 'Old tale',
      keys: ['tale'],
      text: 'Known.',
      source: 'analyzer',
      createdAt: EARLIER,
      updatedAt: AFTER,
    },
    {
      id: 'b',
      title: 'The argument',
      keys: ['argument'],
      text: 'How it ended.',
      source: 'analyzer',
      createdAt: AFTER,
      updatedAt: AFTER,
    },
    { id: 'c', title: 'Owner note', keys: ['note'], text: 'Undated.', source: 'owner' },
  ];
}

function deepFreeze(value: unknown) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/** A base view (liveView's shape) over plain data; its data is deep-frozen, so a write throws. */
function baseView() {
  const data = deepFreeze({
    users: { [ALICE]: aliceProfile(), [BRUNO]: brunoProfile() },
    guild: placeMemory(),
    lore: loreEntries(),
    channels: [{ id: 'c1', name: 'games' }],
  });
  const hot = { prompts: { rules: 'RULES' }, config: { features: {} } };
  return {
    hot,
    view: {
      get prompts() {
        return hot.prompts;
      },
      get config() {
        return hot.config;
      },
      calibrator: { ratio: 1, apply: (n: number) => n },
      memory: {
        getPlace: () => asRecord(data).guild,
        getUser: (id: string) => asRecord(data).users[id] ?? null,
        listUserProfiles: () => Object.values(asRecord(data).users),
        listChannels: () => asRecord(data).channels,
        getLore: () => asRecord(data).lore,
      },
    },
  };
}

test('momentCutoff: the newest line she saw, else the answer time, else null', () => {
  const history = [{ ts: CUTOFF - 120_000 }, { ts: CUTOFF }];
  assert.equal(momentCutoff({ history, at: CUTOFF + 5000 } as unknown as Parameters<typeof momentCutoff>[0]), CUTOFF);
  assert.equal(
    momentCutoff({ history: [{ ts: 1 }, {}], at: CUTOFF + 5000 } as unknown as Parameters<typeof momentCutoff>[0]),
    CUTOFF + 5000
  );
  assert.equal(momentCutoff({ history: [{}], at: undefined } as unknown as Parameters<typeof momentCutoff>[0]), null);
  assert.equal(momentCutoff({}), null);
  // Lines after the trigger that her request held: the last of them.
  assert.equal(
    momentCutoff({
      history: [
        { id: 't', ts: CUTOFF - 60_000 },
        { id: 'n', ts: CUTOFF },
      ],
      triggerId: 't',
    } as unknown as Parameters<typeof momentCutoff>[0]),
    CUTOFF
  );
  // A trigger id found nowhere: the last line.
  assert.equal(
    momentCutoff({
      history: [
        { id: 'a', ts: CUTOFF - 120_000 },
        { id: 'b', ts: CUTOFF - 60_000 },
      ],
      triggerId: 'gone',
    } as unknown as Parameters<typeof momentCutoff>[0]),
    CUTOFF - 60_000
  );
});

test('momentView: episodes written at or after the cutoff are hidden, earlier ones kept', () => {
  const { view } = baseView();
  const episodes = momentView(view as unknown as Parameters<typeof momentView>[0], CUTOFF)
    .memory.getUser(ALICE)
    .episodes.map((e: Untyped) => e.what);
  assert.deepEqual(episodes, ['old episode', 'no addedAt, the day before', 'no date at all']);
});

test('momentView: affinity history entries at or after the cutoff are hidden; the reason falls back, the score stays', () => {
  const { view } = baseView();
  const at = momentView(view as unknown as Parameters<typeof momentView>[0], CUTOFF);
  const affinity = at.memory.getUser(ALICE).affinity;
  assert.deepEqual(
    affinity.history.map((h: Untyped) => h.reason),
    ['R1', 'R2']
  );
  assert.equal(affinity.reason, 'R2');
  assert.equal(affinity.score, 12);
  const other = at.memory.getUser(BRUNO).affinity;
  assert.deepEqual(other.history, []);
  assert.equal(other.reason, '');
  assert.equal(other.score, -4);
  const later = momentView(view as unknown as Parameters<typeof momentView>[0], CUTOFF + 3_600_000).memory.getUser(
    ALICE
  ).affinity;
  assert.equal(later.reason, 'R3 after the argument');
  assert.equal(later.history.length, 3);
});

test('momentView: the restored reason looks past kept entries whose reason is empty', () => {
  const { view } = baseView();
  const profile = {
    ...aliceProfile(),
    affinity: {
      score: 14,
      reason: 'R3 after the argument',
      history: [
        { ts: EARLIER, delta: 5, appliedDelta: 5, score: 5, reason: 'R1' },
        { ts: BEFORE, delta: 4, appliedDelta: 4, score: 9, reason: '' },
        { ts: AFTER, delta: 5, appliedDelta: 5, score: 14, reason: 'R3 after the argument' },
      ],
    },
  };
  const affinity = momentView({ ...view, memory: { ...view.memory, getUser: () => profile } }, CUTOFF).memory.getUser(
    ALICE
  ).affinity;
  assert.deepEqual(
    affinity.history.map((h: Untyped) => h.reason),
    ['R1', '']
  );
  assert.equal(affinity.reason, 'R1');
});

test('momentView: details, interests and aliases first recorded at or after the cutoff are hidden', () => {
  const { view } = baseView();
  const profile = momentView(view as unknown as Parameters<typeof momentView>[0], CUTOFF).memory.getUser(ALICE);
  assert.deepEqual(
    profile.details.map((d: Untyped) => d.text),
    ['lives by the sea', 'undated detail']
  );
  assert.deepEqual(
    profile.interests.map((i: Untyped) => i.topic),
    ['chess', 'tea']
  );
  assert.deepEqual(
    profile.aliases.map((a: Untyped) => a.name),
    ['Ali']
  );
  assert.deepEqual(profile.details[0], aliceProfile().details[0]);
});

test('momentView: learned items and lore entries created at or after the cutoff are hidden', () => {
  const { view } = baseView();
  const at = momentView(view as unknown as Parameters<typeof momentView>[0], CUTOFF);
  assert.deepEqual(
    at.memory.getPlace().learned.map((i: Untyped) => i.text),
    ['answer in one line']
  );
  assert.deepEqual(
    at.memory.getLore().map((e) => e.title),
    ['Old tale', 'Owner note']
  );
});

test('momentView: recent lines added at or after the cutoff are hidden; a base without a recent store reads none', () => {
  const { view } = baseView();
  const line = (id: number, fields = {}) => ({
    id,
    at: CUTOFF - 7_200_000,
    addedAt: EARLIER,
    placeId: 'c1',
    text: `σημείωση ${id}`,
    who: [],
    weight: 2,
    ...fields,
  });
  const stored = deepFreeze({
    nextId: 6,
    lines: [
      line(1),
      line(2, { addedAt: AT }),
      line(3, { at: CUTOFF - 60_000, addedAt: AFTER }),
      line(4, { addedAt: null }),
      line(5, { at: CUTOFF + 60_000, addedAt: null }),
    ],
  });
  const base = { prompts: view.prompts, config: view.config, memory: { ...view.memory, getRecent: () => stored } };
  const seen = momentView(base as unknown as Parameters<typeof momentView>[0], CUTOFF).memory.getRecent?.();
  assert.deepEqual(
    seen?.lines.map((entry) => entry.id),
    [1, 4]
  );
  assert.equal(seen?.lines[0], asRecord(stored).lines[0], 'a kept line is the stored one');
  assert.equal(
    momentView(base as unknown as Parameters<typeof momentView>[0], CUTOFF + 3_600_000).memory.getRecent?.(),
    stored
  );
  assert.equal(momentView(view as unknown as Parameters<typeof momentView>[0], CUTOFF).memory.getRecent?.(), null);
  assert.deepEqual(
    hiddenLater(base as unknown as Parameters<typeof hiddenLater>[0], CUTOFF),
    hiddenLater(view as unknown as Parameters<typeof hiddenLater>[0], CUTOFF)
  );
});

test('momentView: undated fields, channels, prompts and config are untouched', () => {
  const { view, hot } = baseView();
  const at = momentView(view as unknown as Parameters<typeof momentView>[0], CUTOFF);
  const profile = at.memory.getUser(ALICE);
  const stored = aliceProfile();
  for (const key of [
    'id',
    'names',
    'firstSeen',
    'lastSeen',
    'messageCount',
    'character',
    'style',
    'relationship',
    'detailsSeq',
    'updatedAt',
  ]) {
    assert.deepEqual(asRecord(profile)[key], asRecord(stored)[key], key);
  }
  const g = at.memory.getPlace();
  for (const key of ['patterns', 'starters', 'injokes', 'self', 'learnedNextId'])
    assert.deepEqual(asRecord(g)[key], asRecord(placeMemory())[key], key);
  assert.equal(at.memory.listChannels(), view.memory.listChannels());
  assert.equal(at.memory.getUser('333333333333333333'), null);
  assert.equal(at.calibrator, view.calibrator);
  assert.deepEqual(at.memory.listUserProfiles()[0], at.memory.getUser(ALICE));
  hot.prompts = { rules: 'NEW RULES' };
  assert.equal(at.prompts.rules, 'NEW RULES');
  assert.equal(at.config, hot.config);
});

test('hiddenLater: counts what the cutoff hides, by kind; nothing for undated memory', () => {
  const { view } = baseView();
  assert.deepEqual(hiddenLater(view as unknown as Parameters<typeof hiddenLater>[0], CUTOFF), {
    episodes: 3,
    affinity: 2,
    reasons: 2,
    details: 1,
    interests: 2,
    aliases: 1,
    learned: 1,
    lore: 1,
  });
  const bare = { id: ALICE, names: ['Alice'], character: 'x' };
  const plain = {
    memory: {
      getPlace: () => ({ patterns: 'p' }),
      getUser: () => bare,
      listUserProfiles: () => [bare],
      listChannels: () => [],
      getLore: () => null,
    },
  };
  assert.deepEqual(
    momentView(plain as unknown as Parameters<typeof momentView>[0], CUTOFF).memory.getUser(ALICE),
    bare
  );
  assert.equal(momentView(plain as unknown as Parameters<typeof momentView>[0], CUTOFF).memory.getLore(), null);
  assert.deepEqual(hiddenLater(plain as unknown as Parameters<typeof hiddenLater>[0], CUTOFF), {
    episodes: 0,
    affinity: 0,
    reasons: 0,
    details: 0,
    interests: 0,
    aliases: 0,
    learned: 0,
    lore: 0,
  });
});

// ---- what the persona saw of the moment's media: replayMedia ------------------------------------

const START = Date.UTC(2026, 8, 29, 18, 0, 0);
const VIDEO_ID = '810000000000000001';
const IMAGE_ID = '810000000000000002';
const BLANK_ID = '810000000000000003';
const EMOJI_ID = '810000000000000004';
const SITES = ['youtube.com'];
const YOUTUBE = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const SEEN_TS = START + 3 * 60_000 + 30_000;
const LATER_TS = START + 10 * 60_000;

/** A snowflake for the n-th message, a minute apart from START. */
function sf(n: number) {
  return ((BigInt(START + n * 60_000) - 1420070400000n) << 22n).toString();
}

function rawMessage(n: number, authorId: string, text: string, extra = {}) {
  const names: Record<string, string> = { [SELF_ID]: 'Zoë', [ALICE]: 'Alice', [BRUNO]: 'Bruno' };
  return {
    id: sf(n),
    placeId: CHANNEL.id,
    channel: { name: CHANNEL.name },
    author: { id: authorId, bot: authorId === SELF_ID, globalName: names[authorId], username: names[authorId] },
    member: { displayName: names[authorId] },
    cleanContent: text,
    createdTimestamp: START + n * 60_000,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
    embeds: [],
    messageSnapshots: new Map(),
    reactions: { cache: new Map() },
    ...extra,
  };
}

/** A readable guild channel over `raws` (oldest first). */
function fakeChannel(raws: Untyped) {
  return {
    id: CHANNEL.id,
    name: CHANNEL.name,
    guild: { id: '600000000000000001', members: { me: { id: SELF_ID } } },
    viewable: true,
    isTextBased: () => true,
    isThread: () => false,
    permissionsFor: () => ({ has: () => true }),
    messages: {
      async fetch(arg: Untyped) {
        let list = [...raws];
        if (arg.before) list = list.filter((m) => BigInt(m.id) < BigInt(arg.before)).slice(-arg.limit);
        else list = list.slice(-arg.limit);
        return new Map(list.map((m) => [m.id, m]));
      },
    },
  };
}

function attachmentsOf(...list: Array<Untyped>) {
  return new Map(
    list.map((a) => [a.id, { url: `https://cdn.discordapp.com/attachments/1/${a.id}/${a.name}`, size: 1000, ...a }])
  );
}

/** A chat with media: a clip, two pictures, a video-site link, a custom emoji in the trigger. */
function mediaChat() {
  return [
    rawMessage(0, BRUNO, 'look', {
      attachments: attachmentsOf({ id: VIDEO_ID, contentType: 'video/mp4', name: 'clip.mp4', duration: 12 }),
    }),
    rawMessage(1, ALICE, 'and these', {
      attachments: attachmentsOf(
        { id: IMAGE_ID, contentType: 'image/png', name: 'a.png' },
        { id: BLANK_ID, contentType: 'image/png', name: 'b.png' }
      ),
    }),
    rawMessage(2, BRUNO, `this one too ${YOUTUBE}`),
    rawMessage(3, ALICE, 'what do you think :wave:', { content: `what do you think <:wave:${EMOJI_ID}>` }),
  ];
}

/** The describer's cache as the live turns left it; frozen, so a write throws. */
function mediaCache() {
  return deepFreeze({
    [VIDEO_ID]: { text: 'a still of a cat', ts: SEEN_TS },
    [`video:${VIDEO_ID}`]: { text: 'a cat knocks a cup off the table', ts: SEEN_TS, watched: true },
    [IMAGE_ID]: { text: 'a café terrace at night', ts: SEEN_TS },
    [BLANK_ID]: { miss: true, ts: SEEN_TS },
    [`video:${videoUrlCacheKey(YOUTUBE)}`]: { text: 'a music video from the eighties', ts: SEEN_TS, watched: true },
    // Described only after she answered: she never saw it.
    [`emoji:${EMOJI_ID}`]: { text: 'a waving hand', ts: LATER_TS },
  });
}

function rendered(history: Untyped, { descriptions, videos }: Record<string, Untyped> = {}) {
  return formatTranscript(history, {
    timezone: 'UTC',
    gapMinutes: 60,
    maxChars: 2000,
    selfName: 'Zoë',
    labels,
    descriptions,
    videos,
  })
    .map((item) => item.text)
    .join('\n');
}

test('replayMedia: a stored watched length and total pass through, so a part-watched link renders as live', async () => {
  const history = await fetchHistoryWindow(
    fakeChannel(mediaChat()) as unknown as Parameters<typeof fetchHistoryWindow>[0],
    {
      anchorId: sf(3),
      limit: 30,
      selfId: SELF_ID,
      embedTextChars: 300,
      videoSites: SITES,
    }
  );
  const key = `video:${videoUrlCacheKey(YOUTUBE)}`;
  const cache = deepFreeze({
    [key]: { text: 'a long lecture', ts: SEEN_TS, watched: true, watchedSeconds: 300, totalSeconds: 3289 },
  });
  const media = replayMedia(
    history as unknown as Parameters<typeof replayMedia>[0],
    { cache, sites: SITES } as unknown as Parameters<typeof replayMedia>[1]
  );
  assert.deepEqual(media.videos.get(videoUrlCacheKey(YOUTUBE)), {
    state: 'watched',
    text: 'a long lecture',
    watchedSeconds: 300,
    totalSeconds: 3289,
  });
  assert.match(rendered(history, media), /\[watched the first 5:00 of 54:49 \(clip cap\): a long lecture\]/);
});

test('replayMedia: the describer cache as it stood when she answered renders as the live transcript did, read only', async () => {
  const history = await fetchHistoryWindow(
    fakeChannel(mediaChat()) as unknown as Parameters<typeof fetchHistoryWindow>[0],
    {
      anchorId: sf(3),
      limit: 30,
      selfId: SELF_ID,
      embedTextChars: 300,
      videoSites: SITES,
    }
  );
  assert.equal(history.length, 4);
  const cache = mediaCache();
  const media = replayMedia(
    history as unknown as Parameters<typeof replayMedia>[0],
    { cache, sites: SITES, before: START + 4 * 60_000 } as unknown as Parameters<typeof replayMedia>[1]
  );
  assert.deepEqual(
    media.descriptions,
    new Map([
      [VIDEO_ID, 'a still of a cat'],
      [IMAGE_ID, 'a café terrace at night'],
    ])
  );
  assert.deepEqual(
    media.videos,
    new Map([
      [VIDEO_ID, { state: 'watched', text: 'a cat knocks a cup off the table' }],
      [videoUrlCacheKey(YOUTUBE), { state: 'watched', text: 'a music video from the eighties' }],
    ])
  );
  const text = rendered(history, media);
  assert.match(text, /\[video: clip\.mp4, 0:12, watched: a cat knocks a cup off the table\]/);
  assert.match(text, /\[image: a café terrace at night\] \[image\]/);
  assert.match(text, /\[watched: a music video from the eighties\]/);
  assert.doesNotMatch(text, /a waving hand/);
  // No time bound: what was described later is taken too.
  assert.equal(
    replayMedia(
      history as unknown as Parameters<typeof replayMedia>[0],
      { cache, sites: SITES } as unknown as Parameters<typeof replayMedia>[1]
    ).descriptions.get(`emoji:${EMOJI_ID}`),
    'a waving hand'
  );
  // Nothing cached: empty maps, the transcript as it renders without any.
  for (const empty of [
    replayMedia(history as unknown as Parameters<typeof replayMedia>[0], { cache: null, sites: SITES }),
    replayMedia(history as unknown as Parameters<typeof replayMedia>[0], { cache: {}, sites: SITES }),
    replayMedia(history as unknown as Parameters<typeof replayMedia>[0]),
  ]) {
    assert.equal(empty.descriptions.size, 0);
    assert.equal(empty.videos.size, 0);
    assert.equal(rendered(history, empty), rendered(history));
  }
});

// ---- scripts/replay.ts ------------------------------------------------------------------------

test('scripts/replay.ts: replays through src/behavior/sandbox.ts, every name it takes exported there', () => {
  const source = fs.readFileSync(new URL('../scripts/replay.ts', import.meta.url), 'utf8');
  assert.ok(source.includes("path.join(src, 'behavior', 'sandbox.ts')"), 'the engine check names the sandbox');
  const match = /const \{([^}]*)\} = await load\('behavior\/sandbox\.ts'\);/.exec(source);
  assert.ok(match, 'replay loads the sandbox');
  const names = match[1]
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  assert.ok(names.length >= 10);
  for (const name of names) assert.notEqual((sandbox as Record<string, unknown>)[name], undefined, name);
  // The lead: the list also names the address reads of src/memory/store-addresses.ts since the replay reads a place
  // and an account through them; each reads a row or spells an id (tests/replay-reads.test.ts).
  assert.deepEqual([...sandbox.SANDBOX_STORE_READS].sort(), [
    'accountOf',
    'chatOfPlace',
    'dmHomeOf',
    'getGifs',
    'getLore',
    'getMediaCache',
    'getPlace',
    'getRecent',
    'getUser',
    'holdsSharedChat',
    'listChannels',
    'listChildren',
    'listUserProfiles',
    'nativeRootOf',
    'personOfAccount',
    'placeChainOf',
    'placeHolding',
    'placeOfChat',
    'placeOfRoot',
    'placesHolding',
    'sharedPlaceOf',
    'topPlaces',
  ]);
});

// ---- mention handles (features.mentionHandles) -------------------------------------------

const ZOE_ID = '333333333333333333';
const DIRECTORY_LABELS = {
  ...labels,
  transcript: { ...labels.transcript, author: '{name} [{handle}]' },
  directory: { lead: 'DIRECTORY', line: '{handle} {names}', lineAliases: '{handle} {names} aka {aliases}' },
};

/** A view whose labels render the directory and the author handles, with Zoé's stored profile (not in the moment). */
function handlesView(features = {}) {
  const hot = fakeHot(features);
  hot.prompts.labels = DIRECTORY_LABELS;
  const store = fakeStore({
    userProfiles: {
      [ZOE_ID]: { id: ZOE_ID, names: ['Zoé'], aliases: [{ name: 'Zo', weight: 3 }] },
      [SELF_ID]: { id: SELF_ID, names: ['Zoë'], aliases: [] },
    },
  });
  return liveView({ hot, store, placeId: 'g1' });
}

// Slice 7: no directory up front (the lead's decision 3), so a profiled member outside the request (Zoé) has no handle
// and her `@handle` stays text, as in a live turn.
test("answerReply: the replay shows the live turn's author handles, and resolves @handle as a live turn would", async () => {
  const view = handlesView();
  const zoe = `@${handleOf(ZOE_ID)}`;
  const alice = `@${handleOf(ALICE)}`;
  const unknown = [zoe, alice].includes('@uzzzz') ? '@u0000' : '@uzzzz';
  const llm = fakeLlm(`<msg>${zoe} ${alice} @Alice ${unknown}</msg><msg>ναι</msg>`);
  const result = await answerReply({
    view,
    situation: twoLines(),
    selfId: SELF_ID,
    selfName: 'Zoë',
    channel: CHANNEL,
    llm,
    samples: 1,
    at: NOW,
  });
  assert.equal(/<directory>/.exec(result.request.user), null);
  assert.ok(result.request.user.includes(`Alice [${alice}]: what do you think about chess?`), result.request.user);
  assert.ok(result.request.user.includes(`Bruno [@${handleOf(BRUNO)}]: καλημέρα`));
  assert.deepEqual(result.answers[0].messages, [
    { text: `${zoe} ${alice} @Alice ${unknown}`, replyTo: null, mentions: [ALICE], unknownHandles: 2 },
    { text: 'ναι', replyTo: null },
  ]);
});

test('answerSkillScenario: a message.create text is resolved like a <msg> (callMentions); the answers carry their mentions', async () => {
  const { answerSkillScenario } = sandbox;
  const view = handlesView();
  // Slice 7: the handle is an author's in the request; a profiled member outside it has none (no directory).
  const alice = `@${handleOf(ALICE)}`;
  const llm = fakeToolLlm([
    toolAnswer(`<think>a</think><msg>${alice}</msg>`, [
      call('message.create', { place: '#general', text: `${alice} @Alice` }),
    ]),
    toolAnswer('<think>b</think><msg>ok</msg>', []),
  ]);
  const result = await answerSkillScenario({
    view,
    situation: twoLines(),
    selfId: SELF_ID,
    selfName: 'Zoë',
    channel: CHANNEL,
    llm,
    runs: 2,
    at: NOW,
    onCall: (given: Untyped) => OK_DATA(given.skill),
  });
  const [first, second] = result.runs;
  assert.deepEqual(first.callMentions, { mentions: [ALICE], unknownHandles: 0 });
  assert.deepEqual(first.answer.messages[0].mentions, [ALICE]);
  assert.equal('callMentions' in second, false, 'a run without a call has none');
});

test("answerSkillScenario: only a message's text is rendered as a post (message.edit too, learning.add not)", async () => {
  const { answerSkillScenario } = sandbox;
  const view = handlesView();
  // Slice 7: the handle is an author's in the request; a profiled member outside it has none (no directory).
  const alice = `@${handleOf(ALICE)}`;
  const llm = fakeToolLlm([
    toolAnswer('<think>a</think>', [call('message.edit', { message: '#1', text: alice })]),
    toolAnswer('<think>b</think>', [call('learning.add', { text: alice })]),
  ]);
  const result = await answerSkillScenario({
    view,
    situation: twoLines(),
    selfId: SELF_ID,
    selfName: 'Zoë',
    channel: CHANNEL,
    llm,
    runs: 2,
    at: NOW,
    onCall: (given: Untyped) => OK_DATA(given.skill),
  });
  const [edit, other] = result.runs;
  assert.deepEqual(edit.callMentions, { mentions: [ALICE], unknownHandles: 0 });
  assert.equal('callMentions' in other, false);
});

test("answerReply: given tools, they are passed to the llm and the completion's tool calls ride on the answer; without them nothing changes", async () => {
  const hot = fakeHot();
  const view = liveView({ hot, store: fakeStore({ userProfiles: {} }), placeId: 'g1' });
  const tools = [
    { type: 'function', function: { name: 'draw_create', description: 'd', parameters: { type: 'object' } } },
  ];
  const toolCalls = [{ id: 'c1', name: 'draw_create', arguments: '{}', parsed: {}, parseError: null }];
  const llm = {
    calls: [] as Array<Untyped>,
    complete: async (messages: unknown, options: Untyped) => {
      llm.calls.push(options);
      return { text: '<msg>ok</msg>', usage: {}, estimated: 1, toolCalls };
    },
  };
  const withTools = await answerReply({
    view,
    situation: twoLines(),
    selfId: SELF_ID,
    selfName: 'Zoë',
    channel: CHANNEL,
    llm,
    samples: 1,
    at: NOW,
    tools,
    toolChoice: 'auto',
  });
  assert.deepEqual(asRecord(llm.calls[0]).tools, tools);
  assert.equal(asRecord(llm.calls[0]).toolChoice, 'auto');
  assert.deepEqual(asRecord(withTools.answers[0]).toolCalls, toolCalls);
  const plain = fakeLlm('<msg>ok</msg>');
  const without = await answerReply({
    view,
    situation: twoLines(),
    selfId: SELF_ID,
    selfName: 'Zoë',
    channel: CHANNEL,
    llm: plain,
    samples: 1,
    at: NOW,
    tools: null,
  });
  assert.equal('tools' in plain.calls[0].options, false);
  assert.equal('toolCalls' in without.answers[0], false);
  // By default her tools go as a live turn sends them.
  const live = fakeLlm('<msg>ok</msg>');
  await answerReply({
    view,
    situation: twoLines(),
    selfId: SELF_ID,
    selfName: 'Zoë',
    channel: CHANNEL,
    llm: live,
    samples: 1,
    at: NOW,
  });
  assert.ok(asRecord(live.calls[0].options.tools).some((tool: Untyped) => tool.function.name === 'message_create'));
  assert.equal(live.calls[0].options.toolChoice, 'auto');
});
