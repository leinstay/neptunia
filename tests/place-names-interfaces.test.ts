// A `place` argument on every interface (plan 2026-11-06-turn-frame, slice 7 (b)): the tools name a place by `place`,
// never by a platform noun, and src/tools/place-names.ts resolves the name against the name index of the memory
// (src/memory/db/names.ts#namesOf) instead of the interface's channel list. A handle to read a place and a way to write
// there are two facts: the interface's `conversationInfo` decides the second, so a room that grants no `send` refuses a
// write with `channel-no-permission` while a read of the same room goes through. One case per interface fake: the room
// `c3` "ανακοινώσεις" of the fake interface `fake`, and the room `k1` "λιμάνι" of a second fake interface `tele`.
// Both rooms are in the memory database only by their stored names; she names each the way she would write it, with
// another case and accents. An intention turn nowhere, so the place is never the turn's own. Synthetic names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeAdapter } from '../src/interface/fake.ts';
import { call, toolAnswer } from './fixtures/tool-answers.ts';
import { useIface } from './fixtures/turn-world.ts';
import type { Fake } from './fixtures/turn-world.ts';
import { addRoom, rootId } from './fixtures/memory-db/mind-world.ts';
import { TURN_NOW, serviceTurn, serviceWake, serviceWorld } from './fixtures/service-turn.ts';
import type { ServiceRun } from './fixtures/service-turn.ts';

useIface('fake');

const THINK = '<think>STEP 4. So: do it.</think>';

/** The second interface, holding the room `k1` where she may read and not write. */
function teleAdapter(): Fake {
  const tele = createFakeAdapter({ iface: 'tele', selfId: 'self-id', now: () => TURN_NOW });
  tele.seedConversation({
    iface: 'tele',
    id: 'k1',
    kind: 'channel',
    name: 'λιμάνι',
    rootId: 't1',
    topic: null,
    permissions: { read: true, send: false, attach: false, react: false },
    owner: null,
    lastMessageAt: null,
    voice: false,
    public: true,
  });
  return tele;
}

/** One case: the interface, the name she writes, and where a post there would land. */
type Case = { iface: string; written: string; sentThere: (run: ServiceRun, tele: Fake) => number };

const CASES: ReadonlyArray<Case> = [
  {
    iface: 'fake',
    written: 'Ανακοινωσεις',
    sentThere: (run) => run.port.messagesIn('c3').length,
  },
  {
    iface: 'tele',
    written: 'ΛΙΜΑΝΙ',
    sentThere: (_run, tele) => tele.calls.filter((one) => one.op === 'send').length,
  },
];

/** An intention turn nowhere whose one step calls `skill` with `args`, over the world with the room `c3` stored too. */
async function callNowhere(skill: string, args: Record<string, unknown>): Promise<{ run: ServiceRun; tele: Fake }> {
  const world = serviceWorld();
  addRoom(world.db, { iface: 'fake', native: 'c3', root: rootId('fake', 'g1'), name: 'ανακοινώσεις' });
  const tele = teleAdapter();
  const due = { id: '' };
  try {
    const run = await serviceTurn({
      world,
      adapters: [tele],
      wake: () =>
        serviceWake('intention_due', {
          items: [{ kind: 'intention_due', reason: 'due', intentionIds: [due.id], errandId: null }],
          intentions: [{ id: due.id, purpose: 'ΚΟΙΤΑ-ΕΚΕΙ', dueAt: TURN_NOW - 60_000 }],
          chainId: due.id,
        }),
      seed: (service) => {
        const made = service.set({ purpose: 'ΚΟΙΤΑ-ΕΚΕΙ', dueAt: TURN_NOW - 60_000, by: 'persona' }) as {
          intention?: { id: string };
        };
        due.id = made.intention?.id ?? '';
      },
      answers: [toolAnswer(THINK, [call(skill, args)]), '<skip/>'],
      conversation: null,
    });
    return { run, tele };
  } finally {
    world.close();
  }
}

/** `skill:status:code` of the turn's first call, split. The status is the action's (`executed` once the operation ran,
 * whatever it answered), so the code carries the refusal. */
function firstAction(run: ServiceRun): { skill: string; status: string; code: string } {
  const [skill = '', status = '', code = ''] = (run.actions[0] ?? '').split(':');
  return { skill, status, code };
}

for (const one of CASES) {
  test(`a write named by place to a room of ${one.iface} that grants no send is refused with channel-no-permission`, async () => {
    // Bug: the name does not resolve across interfaces, or the write goes out where the interface said she may only read.
    const { run, tele } = await callNowhere('message.create', { place: one.written, text: 'καλημέρα' });
    const action = firstAction(run);
    assert.deepEqual([action.skill, action.code], ['message.create', 'channel-no-permission'], run.actions.join(' '));
    assert.equal(one.sentThere(run, tele), 0, 'nothing was posted there');
  });

  test(`a read named by place of the same room of ${one.iface} goes through`, async () => {
    // Bug: a room she may not write in loses its read handle too, or the name is matched only among the turn's own
    // interface's channels and a room of another interface is unknown.
    const { run } = await callNowhere('conversation.read', { place: one.written });
    assert.deepEqual(firstAction(run), { skill: 'conversation.read', status: 'executed', code: 'ok' });
  });
}
