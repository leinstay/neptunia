// How a selfreflection turn ends when her last answer skips (src/turn/phases/outcome.ts#outcomePhase): with no speech
// held and no entry recorded it ends `skip`, so the scheduler (src/behavior/selfreflection.ts) counts no slot as
// posted. The real turn runner over the fake interface, a fake store and a scripted model; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labels } from './fixtures/labels.ts';
import { call, completionOf, toolAnswer } from './fixtures/tool-answers.ts';
import { planAnswerText } from './fixtures/plan-answer.ts';
import { objectMediaCache } from '../src/memory/store-media.ts';
import '../src/tools/operations/index.ts';
import { useIface, useSelf, world } from './fixtures/turn-world.ts';
import { worldTurnRunner } from './fixtures/world-runner.ts';

useIface('fake');
useSelf('self-id');

const NOW = Date.UTC(2026, 9, 6, 19, 30, 0);
const PLAN = { kind: 'status', brief: 'a quiet evening', search: '', picture: false };

type Appended = { post: Record<string, unknown>; opts: unknown };

function fakeStore() {
  const appended: Array<Appended> = [];
  return {
    appended,
    getPlace: () => ({}),
    getUser: () => null,
    getPrivate: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    getLore: () => [],
    ...objectMediaCache({}),
    getSelfreflection: () => ({ posts: [], updatedAt: 0 }),
    appendSelfreflectionPost: (post: Record<string, unknown>, opts: unknown) => appended.push({ post, opts }),
    state: { data: {}, markDirty() {} },
  };
}

/** A model that answers the plan request with PLAN and the writer's requests with `answers` in order, the last repeated. */
function fakeLlm(answers: Array<unknown>) {
  let composed = 0;
  return {
    complete: (_messages: unknown, opts: { purpose?: string }) => {
      if (opts?.purpose === 'selfreflection-planner')
        return Promise.resolve({ text: planAnswerText(PLAN, opts), usage: {}, estimated: 5 });
      const answer = answers[Math.min(composed, answers.length - 1)];
      composed += 1;
      return Promise.resolve(completionOf(answer));
    },
  };
}

const hot = {
  config: {
    bot: { timezone: 'Europe/Athens' },
    context: {
      channelMessages: 50,
      caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
      vision: { fetchTimeoutMs: 10_000 },
      pull: { sameAudience: true },
    },
    llm: { maxRequestTokens: 50000 },
    typing: { reactionDelayMs: [0, 0], msPerChar: [0, 0], minMs: 0, maxMs: 0, betweenMessagesMs: [0, 0] },
    selfreflection: { placeId: 'd1', world: false, planMaxOutputTokens: 250, planTimeoutMs: 15000 },
  },
  prompts: {
    'system-prompt': 'SYSTEM for {{name}}',
    'character-card': 'CARD_TEXT',
    format: 'FORMAT_TEXT',
    selfreflection: 'DIARY_TASK for {{name}}',
    'selfreflection-planner': 'PLAN_SYSTEM for {{name}}',
    'selfreflection-seeds': '# place\na pier\n# light\nfog',
    world: 'WORLD of {{name}}',
    labels,
  },
};

test('a selfreflection turn whose refused call is followed by her skip ends skip and records no entry', async () => {
  // Bug: a turn that held nothing ended `spoke`, so the scheduler counted the slot as an entry posted.
  const channel = world().channel({ id: 'd1', name: 'journal', placeId: 'g1' });
  const store = fakeStore();
  const llm = fakeLlm([toolAnswer('', [call('message.create', { text: 'ένα βράδυ' })]), '<skip/>']);
  const runner = worldTurnRunner({
    hot,
    store,
    llm,
    calibrator: { ratio: 1, apply: (n: number) => n, observe: () => {} },
    images: null,
    lookup: null,
    rng: () => 0.5,
    now: () => NOW,
  });
  const result = (await runner.runTurn({
    channel,
    mode: 'selfreflection',
    selfreflection: { kind: 'status', forced: false },
  })) as { outcome?: unknown; reason?: unknown };
  assert.equal(result.outcome, 'skip');
  assert.equal(result.reason, 'nothing-to-do');
  assert.deepEqual(store.appended, [], 'no entry is recorded');
});
