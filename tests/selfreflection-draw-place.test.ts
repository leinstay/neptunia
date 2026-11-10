// A selfreflection turn's picture that names a place (src/turn/skill-calls.ts#planToolCall): the diary turn posts
// nothing itself, so the named place is set aside and the call is checked and staged for the entry as one in the
// turn's own place. The real turn runner over the fake interface, a fake store, a fake image client and a scripted
// model; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labels } from './fixtures/labels.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import type { LogEntry } from './fixtures/capture-logs.ts';
import { call, completionOf, toolAnswer } from './fixtures/tool-answers.ts';
import { planAnswerText } from './fixtures/plan-answer.ts';
import { objectMediaCache } from '../src/memory/store-media.ts';
import '../src/tools/operations/index.ts';
import { useIface, useSelf, world } from './fixtures/turn-world.ts';
import { worldTurnRunner } from './fixtures/world-runner.ts';

useIface('fake');
useSelf('self-id');

const NOW = Date.UTC(2026, 9, 6, 19, 30, 0);
const PLAN = { kind: 'selfPicture', brief: 'a pier', search: '', picture: true };

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

const images = {
  quota: () => ({ used: 0, cap: 10, userUsed: 0, userCap: 5, spent: false, userSpent: false }),
  generate: () => Promise.resolve({ buffer: Buffer.from('png'), mediaType: 'image/png', seconds: 1, cost: 0 }),
};

/** A model that answers the plan request with PLAN and every writer request with `answer`. */
function fakeLlm(answer: unknown) {
  return {
    complete: (_messages: unknown, opts: { purpose?: string }) =>
      Promise.resolve(
        opts?.purpose === 'selfreflection-planner'
          ? { text: planAnswerText(PLAN, opts), usage: {}, estimated: 5 }
          : completionOf(answer)
      ),
  };
}

const hot = {
  config: {
    // Her own grant of the picture, so a call aimed elsewhere passes her access and meets the rule on who asked.
    bot: { timezone: 'Europe/Athens', access: { 'draw.create': { users: ['self-id'] } } },
    context: {
      channelMessages: 50,
      caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
      vision: { fetchTimeoutMs: 10_000 },
      pull: { sameAudience: true },
    },
    llm: { maxRequestTokens: 50000 },
    typing: { reactionDelayMs: [0, 0], msPerChar: [0, 0], minMs: 0, maxMs: 0, betweenMessagesMs: [0, 0] },
    image: { maxPromptChars: 1000 },
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
    draw: 'DRAW for {{name}}\n{{when}}\n{{request}}',
    labels,
  },
};

/** The `skills: called` lines of a run, as `skill:status/code`. */
const calledOf = (logs: Array<LogEntry>) =>
  logs
    .filter((entry) => entry.msg === 'skills: called')
    .map((entry) => `${String(entry.skill)}:${String(entry.status)}${entry.code ? `/${String(entry.code)}` : ''}`);

test('a selfreflection draw.create that names another place is staged for the entry, never refused no-requester', async () => {
  // Bug: the named place made the call one aimed elsewhere, so a turn nobody asked for refused it `no-requester`.
  const channel = world().channel({ id: 'd1', name: 'journal', placeId: 'g1', permissions: { attach: true } });
  const other = world().channel({ id: 'c2', name: 'elsewhere', placeId: 'g1', permissions: { attach: true } });
  const store = fakeStore();
  const llm = fakeLlm(
    toolAnswer('<msg>un quai</msg>', [call('draw.create', { text: 'a pier at night', place: '#elsewhere' })])
  );
  const runner = worldTurnRunner({
    hot,
    store,
    llm,
    calibrator: { ratio: 1, apply: (n: number) => n, observe: () => {} },
    images,
    lookup: null,
    rng: () => 0.5,
    now: () => NOW,
  });
  const { logs } = await withCapturedLogs(() =>
    runner.runTurn({ channel, mode: 'selfreflection', selfreflection: { kind: 'selfPicture', forced: false } })
  );
  assert.deepEqual(calledOf(logs), ['draw.create:ok/staged']);
  assert.equal(store.appended[0]?.post.picture, 'a pier at night', 'the entry keeps the picture');
  assert.deepEqual(other.sent, [], 'nothing goes to the named place');
});
