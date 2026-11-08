// `person.link` among her in-turn tools (src/turn/in-turn-tools.ts): the account it links is the one the turn answers,
// in the conversation the turn stands in, and a turn that answers nobody links nothing. The link itself is tested in
// tests/person-link.test.ts; here a recording stand-in takes the call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { turnRoutes } from '../src/behavior/turn-ability-route.ts';
import type { LinkAsk } from '../src/interface/person-link.ts';
import { groupContext } from '../src/memory/db/scope.ts';
import { createInTurnTools } from '../src/turn/in-turn-tools.ts';
import { channel, rig } from './fixtures/reads-rig.ts';
import { labels } from './fixtures/labels.ts';

function handlersFor(trigger: { id: string; authorId: string } | null): {
  asked: Array<LinkAsk>;
  link: (args: Record<string, unknown>) => unknown;
} {
  const asked: Array<LinkAsk> = [];
  const hot = { config: {}, prompts: { labels } };
  const tools = createInTurnTools({
    hot,
    store: { listUserProfiles: () => [] },
    recall: null,
    speech: null,
    record: null,
    routes: turnRoutes(hot, null),
    clock: () => 0,
    ifaceReads: rig().reads,
    lookup: undefined,
    describer: undefined,
    memberOf: () => null,
    chatOf: (current) => ({ iface: 'chatnet', chatId: current.id }),
    turnContextOf: () => groupContext('chatnet'),
    linkCalls: (lines) => lines,
    drawTool: () => Promise.reject(new Error('drawing is outside this fixture')),
    personLinks: {
      start: (ask) => {
        asked.push(ask);
        return Promise.resolve({ status: 'ok', data: { text: 'sent' } });
      },
    },
  });
  const handlers = tools.inTurnTools({
    channel: channel('room'),
    placeId: 'g1',
    selfId: 'self',
    selfName: 'Synthetic persona',
    history: [],
    trigger,
  });
  const link = handlers['person.link'];
  assert.ok(link, 'person.link is one of her in-turn tools');
  return { asked, link };
}

test('links the account the turn answers, in the conversation the turn stands in', async () => {
  const { asked, link } = handlersFor({ id: 'm1', authorId: 'a1' });
  await link({ person: 'person:7a1e' });
  assert.deepEqual(asked, [{ iface: 'chatnet', native: 'a1', chatId: 'room', person: 'person:7a1e' }]);
});

test('a turn that answers nobody links nothing', async () => {
  const { asked, link } = handlersFor(null);
  const result = (await link({ person: 'person:7a1e' })) as { status: string; code: string };
  assert.deepEqual([result.status, result.code], ['invalid', 'target-required']);
  assert.deepEqual(asked, []);
});
