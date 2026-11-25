// Tests for src/tools/access.ts: the persona's access to a skill, by a grant to the persona's user id alone, the
// operations no grant opens, and the envelope of a wake kind with the nested capability of an operation that posts.
// Nothing here executes a skill of the real operations: the gateway answers whether one may run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../../src/tools/operations/index.ts';
import { createDiscordInterface } from '../../../interfaces/discord/index.ts';
import { skillRegistry } from '../../../src/tools/registry.ts';
import {
  NESTED_CAPABILITIES,
  NOT_GRANTABLE_TO_PERSONA,
  grantedToPersona,
  skillAccess,
  wakeEnvelope,
} from '../../../src/tools/access.ts';
import { executeCall } from '../../../src/tools/executors.ts';
import { postingChat } from '../../../src/tools/operations/shared.ts';
import { checkSkill } from '../../../src/tools/gateway.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { asRecord } from '../../fixtures/records.ts';
import { OWNER_PERSON, ownedBy } from '../../fixtures/owner-accounts.ts';

// The casts through `Parameters<typeof f>` hand a function a fake that carries only the fields the test reads.

// The Discord interface's capabilities object, as src/index.ts injects it.
const DISCORD = createDiscordInterface().capabilities;

const OWNER = '42';

const MEMBER = '7';

const SELF = 'self-1';

const HERE = 'c-here';

const persona = Object.freeze({ kind: 'persona' });

const audience = Object.freeze({ chatId: HERE, accountIds: [MEMBER] });

/** A config with the settings these tests read, each set here (never the shipped defaults). */
type Grant = { everyone?: boolean; roles?: Array<string>; users?: Array<string> };

function config({ tools = {}, access = {} }: { tools?: Record<string, unknown>; access?: Record<string, Grant> } = {}) {
  return {
    tools: { safeMode: false, ...tools },
    bot: { ownerPerson: OWNER_PERSON, access },
  };
}

/** `cfg` with each of `names` granted to the persona, the persona's user id in `bot.access[name].users`, as `access.grant` stores it. */
function granting(names: Array<string>, cfg: ReturnType<typeof config> & Record<string, unknown> = config()) {
  const access: Record<string, Grant> = { ...cfg.bot.access };
  for (const name of names)
    access[name] = {
      everyone: access[name]?.everyone === true,
      roles: [...(access[name]?.roles ?? [])],
      users: [...(access[name]?.users ?? []), SELF],
    };
  return { ...cfg, bot: { ...cfg.bot, access } };
}

/** One gateway check of a skill of the real registry (default: lore.list for the owner). */
function check({
  skill = 'lore.list',
  args = {},
  cfg = config(),
  granted = [],
  registry = skillRegistry(),
  images,
  lastRunAt,
  now,
}: Record<string, Untyped> = {}) {
  return checkSkill({
    skill,
    args,
    principal: persona,
    audience,
    context: { config: granting(granted, cfg), selfId: SELF, images, registry, lastRunAt, now },
  });
}

// ---- the persona's access: grants to the persona's user id --------------------------------

test("skills access: default deny; only a grant naming the persona's user id opens a skill", () => {
  const edit = skillRegistry().get('message.edit');
  assert.equal(
    skillAccess({ skill: edit, config: config(), selfId: SELF } as unknown as Parameters<typeof skillAccess>[0])
      .allowed,
    false
  );
  assert.deepEqual(
    skillAccess({ skill: edit, config: granting(['message.edit']), selfId: SELF } as unknown as Parameters<
      typeof skillAccess
    >[0]),
    {
      allowed: true,
      reason: 'allowed',
    }
  );
  assert.equal(
    skillAccess({ skill: edit, config: granting(['message.edit']), selfId: null } as unknown as Parameters<
      typeof skillAccess
    >[0]).allowed,
    false,
    "no id of the persona's, no grant"
  );
  // a grant to everyone or to a role is people's: it opens nothing for the persona
  const everyone = config({ access: { 'message.edit': { everyone: true, roles: ['r1'], users: [MEMBER] } } });
  assert.equal(
    skillAccess({ skill: edit, config: everyone, selfId: SELF } as unknown as Parameters<typeof skillAccess>[0])
      .allowed,
    false
  );
  assert.equal(
    // @ts-expect-error: the test stores a text where the list of users belongs, as a hand-edited config may
    grantedToPersona(config({ access: { 'message.edit': { users: 'self-1' } } }), SELF, 'message.edit'),
    false,
    'a malformed grant reads as none'
  );
});

// A stored everyone or role decides nothing, since no member rights layer exists.
test("skills access: an entry that still holds everyone or a role beside the persona's id opens the skill on that id alone", () => {
  const stale = { everyone: true, roles: ['r1'], users: [SELF] };
  const verdict = (name: string) =>
    skillAccess({
      skill: skillRegistry().get(name),
      config: config({ access: { [name]: stale } }),
      selfId: SELF,
    } as unknown as Parameters<typeof skillAccess>[0]);
  assert.deepEqual(verdict('message.edit'), { allowed: true, reason: 'allowed' });
  assert.deepEqual(verdict('memory.restore'), { allowed: false, reason: 'not-grantable' });
  assert.deepEqual(
    skillAccess({
      skill: skillRegistry().get('message.edit'),
      config: config({ access: { 'message.edit': { ...stale, users: [MEMBER] } } }),
      selfId: SELF,
    } as unknown as Parameters<typeof skillAccess>[0]),
    { allowed: false, reason: 'not-allowed' }
  );
});

test('skills access: the irreversible and administrative operations are never open to the persona, whatever is stored', () => {
  assert.deepEqual([...NOT_GRANTABLE_TO_PERSONA].sort(), [
    'access.grant',
    'access.revoke',
    'bot.pause',
    'bot.resume',
    'config.set',
    'config.unset',
    'memory.restore',
    'model.set',
    'route.remove',
    'route.set',
    // The rules are the owner's document, so no grant opens `rule.add` to the persona.
    'rule.add',
    'rule.remove',
  ]);
  for (const name of NOT_GRANTABLE_TO_PERSONA) {
    assert.deepEqual(
      skillAccess({
        skill: skillRegistry().get(name),
        config: granting([name], config()),
        selfId: SELF,
      } as unknown as Parameters<typeof skillAccess>[0]),
      { allowed: false, reason: 'not-grantable' },
      name
    );
  }
  assert.deepEqual(check({ skill: 'memory.restore', args: { id: 'ep-1' }, granted: ['memory.restore'] }), {
    ok: false,
    code: 'not-grantable',
    reason: 'memory.restore',
  });
});

// ---- wake envelopes (wakes.kinds.<kind>, heartbeat.*) ---------------------------------

/**
 * One gateway check of an inner turn's call: the persona's own initiative, nobody asked, `wakeKind` and the calls so far. `wakes`
 * holds an envelope per kind: the heartbeat's goes to the `heartbeat` section, every other under `wakes.kinds`.
 */
function innerCheck({
  skill,
  args = {},
  wakes = {},
  wakeKind = 'heartbeat',
  wakeActions = [],
  granted = [],
}: Record<string, Untyped>) {
  const { heartbeat, ...kinds } = wakes as Record<string, Untyped>;
  const cfg = granting(granted, { ...config(), wakes: { kinds }, ...(heartbeat ? { heartbeat } : {}) });
  return checkSkill({
    skill,
    args,
    principal: persona,
    audience,
    context: { config: cfg, selfId: SELF, registry: skillRegistry(), ownInitiative: true, wakeKind, wakeActions },
  });
}

test('wake envelope: "*" with no caps, or no envelope at all, is today\'s behaviour', () => {
  assert.deepEqual(wakeEnvelope({}, 'heartbeat'), { tools: '*', maxActs: null, maxTasks: null, inputTokens: null });
  assert.deepEqual(
    wakeEnvelope(
      { wakes: { kinds: { review: { tools: ['a.b'], maxActs: 2, maxTasks: 0, inputTokens: 6000 } } } },
      'review'
    ),
    { tools: ['a.b'], maxActs: 2, maxTasks: 0, inputTokens: 6000 }
  );
  for (const wakes of [{}, { heartbeat: { tools: '*', maxActs: null, maxTasks: null, inputTokens: null } }]) {
    assert.deepEqual(innerCheck({ skill: 'message.create', args: { text: 'γεια' }, wakes }), { ok: true });
    assert.deepEqual(innerCheck({ skill: 'lore.list', granted: ['lore.list'], wakes }), { ok: true });
  }
});

test('wake envelope: a tool outside the allowlist is refused at the call, carried-over tags included; a family entry opens the family', () => {
  const wakes = { heartbeat: { tools: ['lore.list', 'intention.*'] } };
  assert.deepEqual(innerCheck({ skill: 'message.create', args: { text: 'γεια' }, wakes }), {
    ok: false,
    code: 'not-allowed',
    reason: 'heartbeat.tools',
  });
  assert.deepEqual(innerCheck({ skill: 'lore.list', granted: ['lore.list'], wakes }), { ok: true });
  assert.deepEqual(
    innerCheck({
      skill: 'intention.set',
      args: { text: 'ρωτήσω αύριο' },
      granted: ['intention.set'],
      wakes,
    }),
    { ok: true }
  );
  // Another wake kind has its own envelope (here none: everything as before).
  assert.deepEqual(innerCheck({ skill: 'message.create', args: { text: 'γεια' }, wakes, wakeKind: 'review' }), {
    ok: true,
  });
  // Not an inner turn: no envelope applies.
  const cfg = granting([], { ...config(), heartbeat: wakes.heartbeat });
  assert.deepEqual(
    checkSkill({
      skill: 'message.create',
      args: { text: 'γεια' },
      principal: persona,
      audience,
      context: { config: cfg, selfId: SELF, wakeKind: 'heartbeat' },
    }),
    { ok: true }
  );
});

test('wake envelope: maxActs counts the calls that changed something, maxTasks the errands; reads stay free', () => {
  const wakes = { improvement: { maxActs: 1, maxTasks: 0 } };
  const done = [
    { skill: 'lore.list', status: 'executed' },
    { skill: 'intention.set', status: 'proposed' },
    { skill: 'message.create', status: 'refused' },
  ];
  assert.deepEqual(
    innerCheck({ skill: 'message.create', args: { text: 'γεια' }, wakes, wakeKind: 'improvement', wakeActions: done }),
    { ok: false, code: 'not-allowed', reason: 'wakes.kinds.improvement.maxActs' }
  );
  assert.deepEqual(
    innerCheck({ skill: 'lore.list', granted: ['lore.list'], wakes, wakeKind: 'improvement', wakeActions: done }),
    { ok: true }
  );
  assert.deepEqual(
    innerCheck({
      skill: 'message.create',
      args: { text: 'γεια' },
      wakes,
      wakeKind: 'improvement',
      wakeActions: done.slice(0, 1),
    }),
    { ok: true }
  );
  assert.deepEqual(
    innerCheck({
      skill: 'errand.scout',
      args: { agent: 'scout', goal: 'βρες' },
      granted: ['errand.scout'],
      wakes: { improvement: { maxTasks: 0 } },
      wakeKind: 'improvement',
    }),
    { ok: false, code: 'not-allowed', reason: 'wakes.kinds.improvement.maxTasks' }
  );
});

test('wake envelope: a skill that posts inside its own operation is refused at the nested capability, before anything runs', async () => {
  assert.deepEqual(NESTED_CAPABILITIES['draw.create'], ['message.create']);
  const registry = skillRegistry();
  const resolved = {
    skill: 'draw.create',
    args: { text: 'ένα δέντρο' },
    dispatch: registry.get('draw.create')?.dispatch,
  };
  let ran = 0;
  const deps = (tools: unknown) => ({
    envelope: { ownInitiative: true, wakeKind: 'heartbeat', requester: null },
    // draw.create is one of the persona's own expressive operations: it runs through runOwnOp.
    runOwnOp: async () => {
      ran += 1;
      return { status: 'ok', code: 'ok', summary: 'drawn', data: {} };
    },
    // The call's place alone.
    opContext: { placeId: HERE },
    config: { heartbeat: { tools } },
  });
  const refused = await executeCall(
    resolved as unknown as Parameters<typeof executeCall>[0],
    deps(['draw.create']) as unknown as Parameters<typeof executeCall>[1]
  );
  assert.equal(refused.status, 'denied');
  assert.equal(refused.code, 'not-allowed');
  assert.equal(refused.reason, 'heartbeat.tools');
  assert.equal(ran, 0, 'nothing paid is made for a post the envelope forbids');
  assert.equal(
    (
      await executeCall(
        resolved as unknown as Parameters<typeof executeCall>[0],
        deps(['draw.create', 'message.create']) as unknown as Parameters<typeof executeCall>[1]
      )
    ).status,
    'ok'
  );
  assert.equal(
    (
      await executeCall(
        resolved as unknown as Parameters<typeof executeCall>[0],
        deps('*') as unknown as Parameters<typeof executeCall>[1]
      )
    ).status,
    'ok'
  );
  assert.equal(ran, 2);
  // The posting point of the operations asks again: a send is refused, a read is not a post.
  const context = {
    placeId: HERE,
    ownInitiative: true,
    wakeKind: 'heartbeat',
    env: { hot: { config: { heartbeat: { tools: ['voice.say'] } } } },
  };
  await assert.rejects(
    postingChat({
      client: null,
      discord: DISCORD,
      chatId: null,
      context,
      need: 'attach',
    } as unknown as Parameters<typeof postingChat>[0]),
    (error) => asRecord(error).status === 'denied' && asRecord(error).code === 'not-allowed'
  );
  assert.equal(
    await postingChat({
      client: null,
      discord: DISCORD,
      chatId: null,
      context,
      need: 'read',
    } as unknown as Parameters<typeof postingChat>[0]),
    HERE
  );
  assert.equal(
    await postingChat({
      client: null,
      discord: DISCORD,
      chatId: null,
      context: { ...context, ownInitiative: false },
      need: 'send',
    } as unknown as Parameters<typeof postingChat>[0]),
    HERE,
    "not the persona's own initiative: no envelope"
  );
});

test("no grant opens rule.add to the persona, since the rules are the owner's", () => {
  // Bug: `rule.add` could be granted to the persona while `rule.remove` could not, so they could write the owner's rules.
  assert.ok(NOT_GRANTABLE_TO_PERSONA.includes('rule.add'));
});

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy([OWNER]);
