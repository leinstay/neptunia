// src/turn/phases/request/searches.ts: the searches a turn may run (`planRequest`). The server search of a private chat
// runs on its partner's behalf, and in every private chat with `context.memory.openPrivate` on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRequest } from '../src/turn/phases/request/searches.ts';

type Ctx = Parameters<typeof planRequest>[0];
type Turn = Parameters<typeof planRequest>[1];

const ctx = { lookup: null, recallAvailable: () => true } as unknown as Ctx;
const dmTurn = (open: boolean) =>
  ({ isDm: true, likeServer: false, config: { context: { memory: { openPrivate: open } } } }) as unknown as Turn;

test('a private chat with no partner on the server searches the server only with context.memory.openPrivate on', () => {
  // Bug: the switch opens her memory but a direct chat whose partner is no member still has no server search.
  assert.equal(planRequest(ctx, dmTurn(false)).serverOn, false);
  assert.equal(planRequest(ctx, dmTurn(true)).serverOn, true);
});
