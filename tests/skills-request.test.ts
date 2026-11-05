// Where her skill index stands in a request (src/behavior/prompt.ts#buildRequest, the `skillIndex` input) and what
// the old catalogue is called now that `<skills>` is the index: a request with no skill indexed is byte-identical to
// one built without the input, a request with one carries `<skills>` in the cached stable part between `<tools>`
// and `<self_facts>`, and the catalogue of the tools she may call is `<tool_catalogue>` in the tail. Fake input,
// no model, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest } from '../src/behavior/prompt.ts';
import type { BuildRequestInput, BuildRequestResult } from '../src/behavior/prompt-types.ts';
import { labels } from './fixtures/labels.ts';

const NOW = Date.UTC(2026, 10, 1, 10, 0, 0);

function fakeConfig() {
  return {
    bot: { timezone: 'UTC' },
    context: {
      gapMarkerMinutes: 20,
      maxMessageChars: 800,
      caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, server: 2500, lore: 1500 },
      vision: { maxImages: 0, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0 },
      customEmoji: { max: 30 },
    },
    features: { vision: false, promptCache: true },
    gifs: { max: 20, halfLifeDays: 30, ownMarkHours: 24 },
    llm: { maxRequestTokens: 50000, safetyMargin: 0.9, cache: { ttl: '1h' } },
    lore: { scanMessages: 30 },
    memory: {},
  };
}

function baseInput(overrides: Partial<BuildRequestInput> = {}): BuildRequestInput {
  const input = {
    config: fakeConfig(),
    prompts: {
      'system-prompt': 'SYSTEM',
      'character-card': 'CARD',
      rules: 'RULES',
      format: 'FORMAT',
      reply: 'REPLY_TASK',
      labels,
    },
    calibrator: { ratio: 1, apply: (n: number) => n },
    mode: 'reply',
    now: NOW,
    selfName: 'Nept',
    history: [
      {
        id: '1',
        ts: NOW - 60_000,
        authorId: 'a',
        authorName: 'Zoé',
        self: false,
        content: 'γεια',
        attachments: [],
        stickers: [],
        replyToId: null,
      },
    ],
    neighbors: [],
    trigger: null,
    triggerKind: null,
    placeMemory: { self: ['likes tea'] },
    toolsBlock: 'TOOLS_BODY',
    interlocutor: null,
    otherProfiles: [],
    ...overrides,
  };
  // The labels fixture nests groups (callStatus) that the Labels type reads as plain strings.
  return input as unknown as BuildRequestInput;
}

const INDEX = 'SKILLS_HEADER\n- look-it-up: I check the web first';

/** The stable text and the tail text of a reply request. */
function parts(request: BuildRequestResult): { stable: string; tail: string } {
  const content = request.messages[1]?.content as Array<{ cacheSegment?: string; text: string }>;
  const stable = content.find((entry) => entry.cacheSegment === 'stable');
  return { stable: stable?.text ?? '', tail: content.at(-1)?.text ?? '' };
}

test('buildRequest: with no skill indexed the request is byte-identical to one built without the input', () => {
  const plain = JSON.stringify(buildRequest(baseInput()));
  assert.equal(JSON.stringify(buildRequest(baseInput({ skillIndex: '' }))), plain);
  assert.equal(JSON.stringify(buildRequest(baseInput({ skillIndex: null }))), plain);
  assert.equal(plain.includes('<skills>'), false);
});

test('buildRequest: the skill index is the block <skills> in the stable part, after <tools> and before <self_facts>', () => {
  const { stable, tail } = parts(buildRequest(baseInput({ skillIndex: INDEX })));
  assert.ok(stable.includes(`<skills>\n${INDEX}\n</skills>`), stable);
  assert.ok(stable.indexOf('<tools>') < stable.indexOf('<skills>'));
  assert.ok(stable.indexOf('<skills>') < stable.indexOf('<self_facts>'));
  assert.equal(tail.includes('<skills>'), false, 'the index is never in the tail');
});

test('buildRequest: the same index twice gives the same stable text, so the cache holds', () => {
  const first = parts(buildRequest(baseInput({ skillIndex: INDEX }))).stable;
  const second = parts(buildRequest(baseInput({ skillIndex: INDEX, now: NOW + 1000 }))).stable;
  assert.equal(second, first);
});

test('buildRequest: the tool catalogue is <tool_catalogue> in the tail, and <skills> stays the index', () => {
  const rows = [{ name: 'message.create', title: 'Post', whenToUse: 'to speak', allowed: true, reason: 'allowed' }];
  const { stable, tail } = parts(buildRequest(baseInput({ skillsInventory: rows, skillIndex: INDEX })));
  assert.ok(tail.includes('<tool_catalogue>\n'));
  assert.equal(tail.includes('<skills>'), false);
  assert.equal(stable.includes('<tool_catalogue>'), false);
  assert.ok(stable.includes('<skills>\n'));
});
