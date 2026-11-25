// Tests for src/tools/gateway.ts: the gateway check of one call of the persona's (the grant, the schema, the
// cooldown, safe mode and the carried-over reply tags), the catalogue rows of every skill, and the route decision of a
// model role's call (`abilityRoute`). Nothing here executes a skill: the gateway only answers whether one may run.
import { test, after, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import '../../../src/tools/operations/index.ts';
import { abilityRoute, checkReplyEffect, checkSkill, listSkills, bareToolName } from '../../../src/tools/gateway.ts';
import { createRoleHealth } from '../../../src/llm/role-health.ts';
import { toolsWith } from '../../../src/tools/definitions.ts';
import { skillArgs, grantedSkillNames } from '../../../src/tools/discovery.ts';
import { loadSkills, skillRegistry, skillNames } from '../../../src/tools/registry.ts';
import { CARRIED_OVER } from '../../../src/tools/access.ts';
import type { Rights, Untyped } from '../../../src/tools/types.ts';
import { asRecord } from '../../fixtures/records.ts';
import { OWNER_PERSON, ownedBy } from '../../fixtures/owner-accounts.ts';
import { chainsOf } from '../../fixtures/chains.ts';
import { labels } from '../../fixtures/labels.ts';
import { call, toolAnswer, completionOf } from '../../fixtures/tool-answers.ts';
import type { Completion } from '../../fixtures/tool-answers.ts';
import { NOW as HARNESS_NOW, appended, contentText, coreTurn, rawMessage } from '../../fixtures/turn-harness.ts';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openMemoryDb } from '../../../src/memory/db/open.ts';
import { observe, OBSERVATION_VERSION } from '../../../src/memory/db/observe.ts';
import { dbOf } from '../../../src/memory/db/types.ts';
import { fillStems } from '../../../src/memory/db/stems.ts';
import { generated } from '../../fixtures/memory-db/roundtrip.ts';
import { channelInfo } from '../../fixtures/core-over-fake.ts';
import { withRig, startUnitsCore, spawnCli, startedUnit, until, runCli } from '../../fixtures/core-units.ts';
import type { Dirs, Llm } from '../../fixtures/core-units.ts';
import { useIface, world } from '../../fixtures/turn-world.ts';
import { toolDecisions } from '../../fixtures/tool-decisions.ts';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import type { issueContext } from '../../../src/memory/db/scope.ts';
import { createTurnRunner } from '../../fixtures/turn-runner.ts';
import { createAdmin } from '../../../src/admin.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { objectMediaCache } from '../../../src/memory/store-media.ts';

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

/** An images client whose quota answers `quota`. */
function imagesWith(quota: Record<string, unknown>) {
  return {
    quota: ({ accountId }: { accountId?: string } = {}) => ({
      used: 0,
      cap: 5,
      userUsed: 0,
      userCap: 2,
      spent: false,
      userSpent: false,
      ...quota,
      askedFor: accountId,
    }),
  };
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

test("skills access: the persona's reply tags are carried over in the current chat, without a grant, even in safe mode", () => {
  assert.deepEqual([...CARRIED_OVER].sort(), ['draw.create', 'message.create', 'message.react.add', 'voice.say']);
  for (const skill of CARRIED_OVER) {
    assert.deepEqual(
      checkReplyEffect({ skill, principal: persona, config: config() } as unknown as Parameters<
        typeof checkReplyEffect
      >[0]),
      { ok: true },
      skill
    );
    assert.deepEqual(
      checkReplyEffect({
        skill,
        principal: persona,
        config: config({ tools: { safeMode: true } }),
      } as unknown as Parameters<typeof checkReplyEffect>[0]),
      { ok: true },
      skill
    );
  }
  assert.equal(
    asRecord(
      checkReplyEffect({ skill: 'message.delete', principal: persona, config: config() } as unknown as Parameters<
        typeof checkReplyEffect
      >[0])
    ).code,
    'unknown-skill'
  );
  assert.equal(
    asRecord(
      checkReplyEffect({
        skill: 'message.create',
        principal: { kind: 'member' },
        config: config(),
      } as unknown as Parameters<typeof checkReplyEffect>[0])
    ).code,
    'unknown-principal'
  );
  // a call of the persona's in the current chat is carried over too
  assert.deepEqual(check({ skill: 'message.create', args: { text: 'γεια' } }), { ok: true });
  assert.deepEqual(check({ skill: 'message.create', args: { text: 'γεια', place: 'c-other' } }), {
    ok: false,
    code: 'not-allowed',
    reason: 'message.create',
  });
  assert.deepEqual(
    check({ skill: 'message.create', args: { text: 'γεια' }, requester: { id: MEMBER } }),
    { ok: true },
    "the persona's own message, whoever asked"
  );
});

test("skills gateway: the persona's own expressive operations need only the persona's grant, whoever asked or with nobody asking", () => {
  // The persona's own operations are the tools with the trait `self`, read where they are declared.
  assert.deepEqual([...toolsWith('self')].sort(), [
    'draw.create',
    'intention.cancel',
    'intention.list',
    'intention.set',
    'intention.update',
    'message.create',
    'message.delete',
    'message.edit',
    'message.react.add',
    'message.react.remove',
    'skill.disable',
    'skill.read',
    // The script runner is the persona's like their other skill tools.
    'skill.run',
    'voice.say',
  ]);
  for (const name of toolsWith('self')) assert.ok(skillRegistry().has(name), name);
  const member = { id: MEMBER };
  // a member with no right of their own on them: the persona's grant alone decides
  assert.deepEqual(
    check({
      skill: 'message.edit',
      args: { message: 'm1', text: 'σωστό' },
      granted: ['message.edit'],
      requester: member,
    }),
    { ok: true }
  );
  assert.deepEqual(
    check({
      skill: 'draw.create',
      args: { text: 'ένα δέντρο', people: [] },
      granted: ['draw.create'],
      requester: member,
      images: imagesWith({}),
    }),
    { ok: true }
  );
  // still closed until granted to the persona
  assert.equal(
    asRecord(check({ skill: 'message.edit', args: { message: 'm1', text: 'σωστό' }, requester: member })).code,
    'not-allowed'
  );
  // A call of the persona's runs on their grant alone, so nobody asking refuses no write.
  assert.deepEqual(
    check({
      skill: 'message.edit',
      args: { message: 'm1', text: 'σωστό' },
      granted: ['message.edit'],
      requester: null,
    }),
    { ok: true }
  );
});

// ---- the gateway, check by check --------------------------------------------------------

test('skills gateway: an intention takes a purpose that holds a link and a reason', () => {
  const text = `Post https://example.org/${'a'.repeat(80)} where it fits. ${'Why it matters and what to say. '.repeat(10)}`;
  assert.equal(text.length > 400 && text.length <= 600, true);
  assert.deepEqual(check({ skill: 'intention.set', args: { text }, granted: ['intention.set'] }), { ok: true });
  assert.deepEqual(check({ skill: 'intention.update', args: { id: 'i1', text }, granted: ['intention.update'] }), {
    ok: true,
  });
});

test('skills gateway: an unknown skill or a non-persona principal is refused; arguments are checked against the schema', () => {
  assert.equal(asRecord(check({ skill: 'message.pin' })).code, 'unknown-skill');
  const wrong = checkSkill({
    skill: 'lore.list',
    args: {},
    principal: { kind: 'member' },
    audience,
    context: { config: config() },
  });
  assert.equal(asRecord(wrong).code, 'unknown-principal');
  const edit = (args: unknown) => check({ skill: 'message.edit', args, granted: ['message.edit'] });
  assert.deepEqual(edit({ message: 'm1', text: 'διορθωμένο' }), { ok: true });
  assert.deepEqual(edit({ message: 'm1' }), { ok: false, code: 'invalid-args', reason: 'args.text:required' });
  assert.deepEqual(edit({ message: 'm1', text: 'é'.repeat(2001) }), {
    ok: false,
    code: 'invalid-args',
    reason: 'args.text:max-length',
  });
  assert.deepEqual(edit({ message: 5, text: 'a' }), { ok: false, code: 'invalid-args', reason: 'args.message:type' });
  assert.deepEqual(edit({ message: 'm1', text: 'a', authorId: SELF }), {
    ok: false,
    code: 'invalid-args',
    reason: 'args.authorId:unknown',
  });
  assert.deepEqual(edit(null), { ok: false, code: 'invalid-args', reason: 'args:type' });
});

test('skills gateway: an owner-only operation is closed until the owner grants it to the persona', () => {
  assert.equal(asRecord(check({ skill: 'memory.journal.read', args: {} })).code, 'not-allowed', 'default deny');
  assert.deepEqual(check({ skill: 'memory.journal.read', args: {}, granted: ['memory.journal.read'] }), { ok: true });
});

// Who asked changes nothing about whether a call of the persona's runs.
test('skills gateway: a member who may not run an owner-only operation has it run when the persona holds the grant', () => {
  assert.deepEqual(
    check({ skill: 'memory.journal.read', args: {}, granted: ['memory.journal.read'], requester: { id: MEMBER } }),
    { ok: true }
  );
});

test('skills gateway: a write the persona holds runs when nobody asked and the turn is not their own initiative', () => {
  // The write is `errand.cancel`, a tool of the persona's.
  assert.deepEqual(
    check({
      skill: 'errand.cancel',
      args: { id: 'e1' },
      granted: ['errand.cancel'],
      requester: null,
    }),
    { ok: true }
  );
});

test('skills gateway: an ungrantable operation stays refused for the persona whoever asked, the owner included', () => {
  const restore = (requester: unknown) =>
    check({ skill: 'memory.restore', args: { id: 'ep-1' }, granted: ['memory.restore'], requester });
  for (const requester of [{ id: OWNER }, { id: MEMBER }, null])
    assert.deepEqual(
      restore(requester),
      { ok: false, code: 'not-grantable', reason: 'memory.restore' },
      JSON.stringify(requester)
    );
});

test('skills gateway: a call the persona holds no grant for stays refused not-allowed whoever asked', () => {
  // The call is `errand.cancel`, a tool of the persona's.
  const cancel = (requester: unknown) => check({ skill: 'errand.cancel', args: { id: 'e1' }, requester });
  for (const requester of [{ id: OWNER }, { id: MEMBER }, null])
    assert.deepEqual(
      cancel(requester),
      { ok: false, code: 'not-allowed', reason: 'errand.cancel' },
      JSON.stringify(requester)
    );
});

// The refusal carries the minutes left and the window (`values`) since the cooldown refusal says how long is left.
test('skills gateway: a destructive skill waits out its cooldown in a channel (tools.destructiveCooldownMinutes)', () => {
  // The destructive skill is `message.delete` and the write `errand.cancel`.
  const remove = (lastRunAt: null | number, cfg = config({ tools: { destructiveCooldownMinutes: 10 } })) =>
    check({
      skill: 'message.delete',
      args: { message: 'm1' },
      granted: ['message.delete'],
      lastRunAt,
      now: 1_000_000,
      cfg,
    });
  assert.deepEqual(remove(null), { ok: true });
  assert.deepEqual(remove(1_000_000 - 5 * 60_000), {
    ok: false,
    code: 'cooldown',
    reason: 'tools.destructiveCooldownMinutes',
    values: { minutes: 5, window: 10 },
  });
  assert.deepEqual(remove(1_000_000 - 5 * 60_000, config({ tools: { destructiveCooldownMinutes: 4 } })), { ok: true });
  // a write is no destructive call
  assert.deepEqual(
    check({
      skill: 'errand.cancel',
      args: { id: 'e1' },
      granted: ['errand.cancel'],
      lastRunAt: 999_999,
      now: 1_000_000,
    }),
    { ok: true }
  );
});

/** The `values` of a `message.delete` refused by its cooldown: the last run `agoMs` before `now` under `window` minutes. */
function cooldownValues(agoMs: number, window: number): unknown {
  const NOW_MS = 1_000_000;
  // The destructive skill is `message.delete`.
  const verdict = check({
    skill: 'message.delete',
    args: { message: 'm1' },
    granted: ['message.delete'],
    lastRunAt: NOW_MS - agoMs,
    now: NOW_MS,
    cfg: config({ tools: { destructiveCooldownMinutes: window } }),
  });
  return asRecord(verdict).values;
}

// Bug: a part of a minute left is rounded down, so the refusal says 0 minutes while the tool is still closed.
test('skills gateway: a cooldown with 30 seconds left says 1 minute', () => {
  assert.deepEqual(cooldownValues(9 * 60_000 + 30_000, 10), { minutes: 1, window: 10 });
});

// Bug: the minutes left are rounded to the nearest, so a call one second after the last says 9 minutes instead of 10.
test('skills gateway: a cooldown that began a second ago says the whole window is left', () => {
  assert.deepEqual(cooldownValues(1000, 10), { minutes: 10, window: 10 });
});

// Bug: the window and the minutes left come from the shipped default of 10 instead of tools.destructiveCooldownMinutes.
test('skills gateway: the cooldown values follow tools.destructiveCooldownMinutes', () => {
  assert.deepEqual(cooldownValues(60_000, 4), { minutes: 3, window: 4 });
});

test('skills gateway: safe mode lets only the carried-over calls pass', () => {
  const safe = config({ tools: { safeMode: true } });
  assert.deepEqual(check({ granted: ['lore.list'], cfg: safe }), {
    ok: false,
    code: 'safe-mode',
    reason: 'tools.safeMode',
  });
  assert.deepEqual(check({ skill: 'message.create', args: { text: 'γεια' }, cfg: safe }), { ok: true });
  // a config without tools settings is not in safe mode
  assert.deepEqual(check({ granted: ['lore.list'], cfg: { bot: { ownerPerson: OWNER_PERSON } } }), { ok: true });
});

// ---- the catalogue view -----------------------------------------------------------------

test('skills list: one row per skill with its texts, allowed or not and why', () => {
  const cfg = granting(['message.edit', 'memory.restore', 'draw.create', 'memory.private.read']);
  const texts = { 'message.create': { title: 'Στείλε', whenToUse: 'όταν θέλεις', whenNotToUse: 'όχι' } };
  const rows = listSkills({ config: cfg, selfId: SELF, texts, requester: { id: OWNER }, audience });
  // No skill sits behind a feature switch, so every skill has a row.
  assert.equal(rows.length, skillNames().length);
  const byName = new Map(rows.map((row) => [row.name, row]));
  const place = { name: 'place', required: false };
  const body = { name: 'text', required: true };
  const message = { name: 'message', required: true };
  assert.deepEqual(byName.get('message.create'), {
    name: 'message.create',
    title: 'Στείλε',
    whenToUse: 'όταν θέλεις',
    allowed: true,
    reason: 'carried-over',
    args: [
      place,
      { name: 'reply', required: false },
      { name: 'text', required: false },
      { name: 'file', required: false },
      { name: 'gif', required: false },
      { name: 'media', required: false },
      { name: 'item', required: false, minimum: 1, maximum: 20 },
    ],
  });
  assert.deepEqual(byName.get('message.edit'), {
    name: 'message.edit',
    title: '',
    whenToUse: '',
    allowed: true,
    reason: 'allowed',
    args: [message, body, place],
  });
  assert.deepEqual(byName.get('message.delete'), {
    name: 'message.delete',
    title: '',
    whenToUse: '',
    allowed: false,
    reason: 'not-allowed',
    args: [message, place],
  });
  assert.deepEqual(byName.get('memory.restore'), {
    name: 'memory.restore',
    title: '',
    whenToUse: '',
    allowed: false,
    reason: 'not-grantable',
    args: [{ name: 'id', required: true }],
  });
  // an owner-only skill the persona holds: allowed whoever asks
  const row = (name: string, requester: unknown) =>
    listSkills({ config: cfg, selfId: SELF, texts: {}, requester, audience } as unknown as Parameters<
      typeof listSkills
    >[0]).find((entry) => entry.name === name);
  assert.deepEqual(
    [row('memory.private.read', { id: OWNER })?.allowed, row('memory.private.read', { id: OWNER })?.reason],
    [true, 'allowed']
  );
  assert.deepEqual(
    [row('memory.private.read', { id: MEMBER })?.allowed, row('memory.private.read', { id: MEMBER })?.reason],
    // The persona's grant alone decides, so a member's row is open too.
    [true, 'allowed']
  );
  assert.deepEqual(
    [row('message.edit', { id: MEMBER })?.allowed, row('message.edit', { id: MEMBER })?.reason],
    [true, 'allowed']
  );
});

// A stand-in skill names no operation with `op: null`, which the loader reads as none; its input type says `undefined`.
type SkillInputs = Parameters<typeof loadSkills>[0];

type SkillMap = ReturnType<typeof loadSkills>;

const standIns = (specs: ReadonlyArray<object>): SkillMap => loadSkills(specs as SkillInputs);

/** Stand-in skills (no operation behind them, so no rights to check): a registry that needs no ops. */
function standInRegistry() {
  const names = [
    'message.create',
    'message.edit',
    'message.delete',
    'message.react.add',
    'message.react.remove',
    'lore.list',
    'errand.list',
  ];
  return standIns(
    names.map((name) => ({
      name,
      op: null,
      argsSchema: { type: 'object' },
      effects: name.endsWith('.list') ? 'read' : 'write',
      costClass: 'free',
      targets: null,
    }))
  );
}

/** `cfg` with `names` granted to the persona (the persona's user id, `self-1`). */
function grantingStandIns(names: Array<string>, cfg: Record<string, unknown> & { bot?: object }) {
  return {
    ...cfg,
    bot: {
      ...cfg.bot,
      access: Object.fromEntries(names.map((name) => [name, { everyone: false, roles: [], users: ['self-1'] }])),
    },
  };
}

// An operation declares its kind alone, and the persona's grant decides whoever asks.
test('listSkills: a skill the persona holds has its row, open whoever asks', () => {
  const ops: Record<string, { name: string; rights: Rights }> = {
    'x.owner.op': { name: 'x.owner.op', rights: { kind: 'read' } },
  };
  const getOp = (name: string) => ops[name] ?? null;
  const owner = loadSkills(
    [
      {
        name: 'x.owner',
        family: 'x',
        op: 'x.owner.op',
        argsSchema: { type: 'object' },
        effects: 'read',
        sharedState: false,
        costClass: 'free',
        targets: null,
      },
    ],
    { getOp }
  ).get('x.owner');
  assert.ok(owner, 'the loader keeps the skill');
  const registry = new Map([...standInRegistry(), ['x.owner', owner]]);
  const config = grantingStandIns(['message.edit', 'x.owner'], {
    tools: { safeMode: false },
    bot: { ownerPerson: OWNER_PERSON },
  });
  const rows = listSkills({
    config,
    selfId: 'self-1',
    texts: {},
    requester: { id: '7' },
    audience: { chatId: 'c1' },
    registry,
    getOp,
  });
  assert.equal(rows.length, registry.size);
  // The rows are read by name, and no request names a skill the registry lacks.
  const rowOf = (found: ReadonlyArray<{ name: string; allowed: boolean; reason: string }>, name: string) => {
    const row = found.find((one) => one.name === name);
    return row && { name: row.name, allowed: row.allowed, reason: row.reason };
  };
  assert.deepEqual(
    ['message.edit', 'message.delete', 'x.owner'].map((name) => rowOf(rows, name)),
    [
      { name: 'message.edit', allowed: true, reason: 'allowed' },
      { name: 'message.delete', allowed: false, reason: 'not-allowed' },
      // The persona's grant alone decides, so a member's row is open.
      { name: 'x.owner', allowed: true, reason: 'allowed' },
    ]
  );
  const asOwner = listSkills({
    config,
    selfId: 'self-1',
    texts: {},
    requester: { id: '42' },
    audience: { chatId: 'c1' },
    registry,
    getOp,
  });
  assert.deepEqual(rowOf(asOwner, 'x.owner'), { name: 'x.owner', allowed: true, reason: 'allowed' });
});

test("listSkills: each row carries the skill's arguments (skillArgs)", () => {
  const registry = skillRegistry();
  const rows = listSkills({
    config: {},
    selfId: 'self-1',
    texts: {},
    requester: null,
    audience: { chatId: 'c1' },
    registry,
  });
  const byName = new Map(rows.map((row) => [row.name, row]));
  for (const name of ['memory.journal.read', 'message.edit', 'memory.search'])
    assert.deepEqual(byName.get(name)?.args, skillArgs(registry.get(name)), name);
  assert.deepEqual(byName.get('memory.server.read')?.args, []);
});

const NOW = Date.parse('2026-10-31T09:00:00Z');

function httpError(status: number): Error {
  return Object.assign(new Error(`OpenRouter HTTP ${status}`), { statusCode: status, body: '' });
}

test('the analyzer and the embedding role never fall back to the core, even when both are down and the core could', () => {
  const health = createRoleHealth({ now: () => NOW, hasKey: () => true });
  for (const role of ['analyzer', 'embedding', 'vision']) health.failed(role, httpError(401));
  const config = {
    models: {
      routes: chainsOf({ core: 'x/core', analyzer: 'x/analyzer', embedding: 'x/embed', vision: 'x/eyes' }),
      abilities: { 'x/core': ['text', 'embeddings', 'imagesIn'] },
    },
  };
  assert.deepEqual(abilityRoute({ config, role: 'analyzer', health }), {
    kind: 'role',
    role: 'analyzer',
    model: 'x/analyzer',
  });
  assert.deepEqual(abilityRoute({ config, role: 'embedding', health }), {
    kind: 'role',
    role: 'embedding',
    model: 'x/embed',
  });
  // The same core and the same failure do move a tool role: the two above are refused a fallback by their role.
  assert.deepEqual(abilityRoute({ config, role: 'vision', health }), {
    kind: 'core',
    role: 'vision',
    ability: 'imagesIn',
    model: 'x/core',
    reason: 'unauthorized',
  });
});

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy([OWNER]);

// What the result of a destructive call refused by its cooldown tells the persona (src/tools/gateway.ts#checkSkill,
// src/turn/skill-calls.ts): the minutes left and the window of `tools.destructiveCooldownMinutes`, through the
// `cooldown` reason of the labels. One turn over the fake adapter: the first `message.delete` runs, the second follows in
// the next step three and a half minutes later and is refused.

const MINUTE_MS = 60_000;
const COOLDOWN = 'own call of this tool here within {window} min, again in {minutes} min';

/** The fixture labels with a `cooldown` reason of this test's own wording. */
function labelsWithCooldown() {
  const { tools } = labels;
  const { result } = tools;
  return { ...labels, tools: { ...tools, result: { ...result, reasons: { ...result.reasons, cooldown: COOLDOWN } } } };
}

// Bug: the refusal reaches the persona with no numbers, so the persona guesses which call closed the tool and for how long.
test('a destructive call refused by its cooldown tells the persona the minutes left and the window', async () => {
  let elapsed = 0;
  // Changed: the destructive call is `message.delete` of two lines of the persona's, since `lore.remove` is no tool of the persona's.
  const run = await coreTurn({
    answers: [
      toolAnswer('<think>x</think>', [call('message.delete', { message: '#1' }, { id: 'first' })]),
      toolAnswer('<think>x</think>', [call('message.delete', { message: '#2' }, { id: 'second' })]),
      '<skip/>',
    ],
    allowed: ['message.delete'],
    // Two lines of the persona's, #1 and #2, for the two deletions.
    earlier: [
      rawMessage({ id: 'b1', authorId: 'self-id', authorName: 'self', ts: HARNESS_NOW - 60_000, content: 'πρώτο' }),
      rawMessage({ id: 'b2', authorId: 'self-id', authorName: 'self', ts: HARNESS_NOW - 50_000, content: 'δεύτερο' }),
    ],
    loop: { timeBudgetMs: 60 * MINUTE_MS },
    prompts: { labels: labelsWithCooldown() },
    withHot(hot) {
      hot.config.tools.destructiveCooldownMinutes = 10;
    },
    // The second step's request comes three and a half minutes after the first call ran.
    onAnswer(index) {
      if (index === 1) elapsed = 3.5 * MINUTE_MS;
    },
    runner: { now: () => HARNESS_NOW + elapsed },
  });
  // The first call ran and answered ok, so the cooldown holds; the second never reached the port.
  const called = run.logs
    .filter((entry) => entry.msg === 'skills: called')
    .map((entry) => `${entry.skill} ${entry.status}`);
  assert.deepEqual(called, ['message.delete ok', 'message.delete denied']);
  const refusals = run.logs
    .filter((entry) => entry.msg === 'skill: refused')
    .map((entry) => `${entry.skill} ${entry.code}`);
  assert.deepEqual(
    refusals,
    ['message.delete cooldown'],
    'the second call is refused by the cooldown and nothing else'
  );
  const second = appended(run.llm, 2).find((message) => message.role === 'tool' && message.tool_call_id === 'second');
  const text = contentText(second?.content);
  assert.ok(text.includes('own call of this tool here within 10 min, again in 7 min'), text);
});

const CORE_OWNER_MEMORY_NOW = Date.parse('2026-10-24T12:00:00Z');
const PRIVATE = 'amber-orchid-731';
const NEIGHBOR = 'silver-fern-842';
const ANSWER = 'owner-memory-answer-953';

function seed(dirs: Dirs) {
  mkdirSync(dirs.dataDir, { recursive: true });
  const userDir = join(dirs.dataDir, 'guilds', 'g1', 'users');
  mkdirSync(userDir, { recursive: true });
  writeFileSync(
    join(userDir, 'u1.json'),
    JSON.stringify({ ...generated('user')[0], id: 'u1', names: ['Eleni'], affinity: { score: 10 } })
  );
  const handle = openMemoryDb(join(dirs.dataDir, 'memory.db'));
  try {
    for (const [id, person, chat, text, minute] of [
      ['target-before', 'benoit', 'dm', `κουνέλι κήπο ${NEIGHBOR}`, 0],
      ['target-anchor', 'benoit', 'dm', `κουνέλι κήπο ${PRIVATE}`, 1],
      ['target-old', 'benoit', 'dm', 'κουνέλι old-date-evidence-608', -14400],
      ['other-private', 'carol', 'dm', 'κουνέλι other-private-164', 2],
      ['public', 'alice', 'group', 'κουνέλι public-evidence-275', 3],
    ] as const) {
      const result = observe(
        handle,
        {
          v: OBSERVATION_VERSION,
          iface: 'telegram',
          authority: 'telegram/global',
          connection: 'conn:test',
          native: { kind: 'message', key: id, revision: 0 },
          place: { authority: 'telegram/global', key: `chat:${person}`, kind: 'room', chat, title: person },
          author: { kind: 'account', key: person, display: person },
          occurredAt: new Date(Date.parse('2026-10-23T10:00:00Z') + minute * 60_000).toISOString(),
          observedAt: new Date(CORE_OWNER_MEMORY_NOW).toISOString(),
          text,
          relations: [],
        },
        { now: () => CORE_OWNER_MEMORY_NOW }
      );
      assert.equal(result.ok, true);
    }
    const db = dbOf(handle);
    const account = db.prepare("SELECT author_account FROM sources WHERE native_id = 'target-anchor'").get();
    assert.ok(account && typeof account.author_account === 'string');
    db.prepare("INSERT OR IGNORE INTO people (id, kind) VALUES ('person:benoit', 'person')").run();
    db.prepare("UPDATE accounts SET person_id = 'person:benoit', link = 'verified', names = ? WHERE id = ?").run(
      JSON.stringify(['Benoit']),
      account.author_account
    );
    db.prepare(
      "INSERT INTO account_person_links (id, account_id, person_id, state, recorded_at) VALUES ('link:benoit', ?, 'person:benoit', 'verified', ?)"
    ).run(account.author_account, new Date(CORE_OWNER_MEMORY_NOW).toISOString());
    fillStems(db);
  } finally {
    handle.close();
  }
}

async function grantSearch(dirs: Dirs) {
  for (const command of ['/tools grant memory.search']) {
    const result = await runCli(dirs, ['-p', command]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
  }
}

// The lead: split, merge and missed answer in strict JSON.
function script(answers: Array<Completion>, split = '{"parts":[]}'): Llm {
  const requests: Array<unknown> = [];
  const options: Array<unknown> = [];
  return {
    requests,
    options,
    complete: (messages, given) => {
      const purpose = given && typeof given === 'object' && 'purpose' in given ? given.purpose : null;
      // Plan 2026-11-04-cli-and-memory B1 and B3: the door asks the classifier first, and a started turn the one pick.
      if (purpose === 'address') return Promise.resolve({ text: 'yes', usage: {}, estimated: 1 });
      if (purpose === 'lookup' || purpose === 'elsewhere-pick')
        return Promise.resolve({ text: 'none', usage: {}, estimated: 1 });
      if (purpose === 'split') return Promise.resolve({ text: split, usage: {}, estimated: 1 });
      requests.push(messages);
      options.push(given);
      const answer = answers[requests.length - 1];
      assert.ok(answer, 'the model must not make an unscripted request');
      return Promise.resolve(answer);
    },
  };
}

function toolText(request: unknown): string {
  assert.ok(Array.isArray(request));
  return request
    .filter(
      (message: unknown) =>
        message !== null && typeof message === 'object' && 'role' in message && message.role === 'tool'
    )
    .map((message: unknown) => JSON.stringify(message))
    .join('\n');
}

const CONFIG = {
  bot: {
    timezone: 'UTC',
    owners: ['u1'],
    placeId: 'g1',
    access: { 'memory.search': { everyone: true, roles: [], users: [] } },
  },
  dm: { enabled: true },
  private: { likeServer: true, minAffinity: 0 },
  split: { minChars: 20, maxTasks: 2, contextMessages: 2, maxOutputTokens: 200 },
  tools: { loop: { maxSteps: 5, timeBudgetMs: 20000, maxCallsPerStep: 1 } },
  recall: {
    prefetch: {
      deadlineMs: 1000,
      maxTokens: 1500,
      contextTokens: 500,
      minFormsMatched: 1,
      singleTermScore: 0,
      maxTermShare: 1,
      trivial: [],
    },
  },
  gifs: { backfillMessages: 0 },
};

test('an internal CLI turn retains its private answer and refuses a generated group publication', async () => {
  await withRig({ config: CONFIG }, async ({ dirs, cores, clis, units, logs }) => {
    seed(dirs);
    const llm = script([
      toolAnswer('', [call('memory.search', { question: 'κουνέλι', people: 'Benoit' })]),
      toolAnswer(`<msg>${ANSWER} ${PRIVATE}</msg>`, [
        call('message.create', { place: '555', text: `outward ${PRIVATE}` }),
      ]),
      toolAnswer(`<msg>${ANSWER} ${PRIVATE}</msg>`),
    ]);
    cores.push(await startUnitsCore(dirs, llm, () => CORE_OWNER_MEMORY_NOW));
    const unit = await startedUnit(dirs);
    units.push(unit);
    await unit.ask({ op: 'seed-chat', info: channelInfo('555') }, 'done');
    await grantSearch(dirs);
    const granted = await runCli(dirs, ['-p', '/tools grant message.create']);
    assert.equal(granted.code, 0, granted.stdout + granted.stderr);
    const chat = spawnCli(dirs, []);
    clis.push(chat);
    chat.type('Recall what Benoit said about κουνέλι and answer here.');
    await until(
      () => chat.stdout().includes(ANSWER),
      () => JSON.stringify({ stderr: chat.stderr(), requestCount: llm.requests.length, logs: logs.slice(-20) })
    );
    assert.ok(toolText(llm.requests[1]).includes(PRIVATE));
    assert.ok(chat.stdout().includes(PRIVATE));
    assert.deepEqual(await unit.posted('555'), []);
    assert.ok(
      logs.some(
        (entry) => entry.msg === 'skills: called' && entry.skill === 'message.create' && entry.status === 'denied'
      )
    );
  });
});

// Tests for the inner turn (src/behavior/turn.ts, mode `inner`; docs/inner-life.md): no message
// is fabricated, the request carries why the persona woke and the inner task, the reads run; in shadow mode
// nothing else does (proposed, journalled as shadow, no call mark), live the calls run through
// the gateway on the persona's own grants, the kill switch is asked right before an action, the public post
// cap refuses, the persona's output tags (<msg>, <draw>, <react to>) are lowered into the calls they
// stand for in the current channel (a refusal when there is none or a reaction names no line);
// a refusal in shadow reaches the persona within the turn. The loop's inner rules: the loop runs under wakes.loop's
// own bounds (a generous budget: nobody waits), the open-intentions line lists what the persona woke for
// and has not touched, the persona's last step still runs one post or intention change, and a post that
// leaves nothing to show while a woken intention is untouched gets one open follow-up step. Over a real admin and the fake interface adapter; no network, no data/.

/** The test memory databases opened here; closed when the file is done. */
const OPENED_MEMORY: Array<Untyped> = [];

function personaGrants(names: Array<string>) {
  return Object.fromEntries(names.map((name) => [name, { everyone: false, roles: [], users: ['self-id'] }]));
}
describe('inner turns', () => {
  before(() => {
    useIface('fake');
  });
  after(() => {
    useIface('discord');
  });

  after(async () => {
    for (const mem of OPENED_MEMORY) await mem.close();
  });

  test('gateway: with nobody asking a write the persona holds runs, on the initiative of the persona or not; without the grant it is refused', () => {
    const config = {
      bot: { owners: ['u1'], access: personaGrants(['errand.cancel']) },
      tools: { safeMode: false },
    };
    // Changed: the write is `errand.cancel`, since `lore.add` is no tool of the persona's.
    const call = {
      skill: 'errand.cancel',
      args: { id: 'e1' },
      principal: { kind: 'persona' },
      requester: null,
      audience: { chatId: 'c1' },
    };
    const unasked = checkSkill({ ...call, context: { config, selfId: 'self-id', registry: skillRegistry() } });
    // Changed: a call of the persona's runs on the persona's grant alone, so nobody asking refuses no write.
    assert.deepEqual(unasked, { ok: true });
    const own = checkSkill({
      ...call,
      context: { config, selfId: 'self-id', registry: skillRegistry(), ownInitiative: true },
    });
    assert.deepEqual(own, { ok: true });
    // The grant still decides.
    const ungranted = checkSkill({
      ...call,
      context: {
        config: { ...config, bot: { ...config.bot, access: {} } },
        selfId: 'self-id',
        registry: skillRegistry(),
        ownInitiative: true,
      },
    });
    assert.equal('code' in ungranted ? ungranted.code : undefined, 'not-allowed');
  });
});

// Tests for the intentions as the persona sees them: the `<intentions>` block's body
// (src/intentions/blocks.ts) -- the active ones with their wait, due time and outcome, then the
// candidates with the line they came from, cut to the token budget -- and the switch that hides
// the `intention.*` skills from the persona entirely while features.intentions is off (src/tools/access.ts).

const INTENTIONS_BLOCK_SELF = 'self-1';
const INTENTIONS_BLOCK_OWNER = 'o1';

function intentionsBlockConfig() {
  const access = Object.fromEntries(
    ['intention.set', 'intention.list', 'lore.list'].map((name) => [
      name,
      { everyone: false, roles: [], users: [INTENTIONS_BLOCK_SELF] },
    ])
  );
  return { bot: { owners: [INTENTIONS_BLOCK_OWNER], access } };
}

// `features.intentions` is code, so the intent skills are the persona's once granted; the off half went with the switch.
test('skills: the intent skills belong to the persona once granted', () => {
  const registry = skillRegistry();
  const audience = { chatId: 'c1' };
  const call = (cfg: Record<string, Untyped>) =>
    checkSkill({
      skill: 'intention.set',
      args: { text: 'κάτι' },
      principal: { kind: 'persona' },
      audience,
      context: { config: cfg, selfId: INTENTIONS_BLOCK_SELF, registry },
    });
  assert.deepEqual(call(intentionsBlockConfig()), { ok: true });
  const listed = (cfg: Record<string, Untyped>) =>
    listSkills({
      config: cfg,
      selfId: INTENTIONS_BLOCK_SELF,
      texts: {},
      requester: { id: INTENTIONS_BLOCK_OWNER },
      audience,
      registry,
    }).map((row) => row.name);
  assert.equal(listed(intentionsBlockConfig()).filter((name) => name.startsWith('intention.')).length, 4);
  // Changed: the six narrow reads leave the offered list, and the grant of lore.list opens memory.read in its place (lookup loop slice 12).
  assert.deepEqual(grantedSkillNames({ config: intentionsBlockConfig(), selfId: INTENTIONS_BLOCK_SELF, registry }), [
    'intention.list',
    'intention.set',
    'memory.read',
  ]);
  // Nobody asked: the persona's own intention runs on the persona's grant. Changed: an unasked write is not refused.
  const verdict = checkSkill({
    skill: 'intention.set',
    args: { text: 'κάτι' },
    principal: { kind: 'persona' },
    audience,
    context: { config: intentionsBlockConfig(), selfId: INTENTIONS_BLOCK_SELF, registry },
  });
  assert.deepEqual(verdict, { ok: true });
});

// The MCP server the persona's tools reach the CLI through, and the bridge that carries its calls to the core
// (docs/keys.md). The server is pure over a
// peer: a fake peer stands for the core here. The bridge is tested through its tokens, and the wire pair
// (`bridgePeer`, `serveBridge`) over the protocol's loopback, which encodes every envelope as the socket would.

test('bareToolName strips the server prefix and leaves a bare name alone', () => {
  // Catches: a name stripped twice or a bare name cut, so the gateway refuses a call the persona wrote correctly.
  assert.equal(bareToolName('mcp__nep__draw_create'), 'draw_create');
  assert.equal(bareToolName('draw_create'), 'draw_create');
});

// The decision table of the persona's tools (tests/fixtures/tool-decisions.ts): what the gateway answers for every tool
// in every context, regenerated from the code and compared with the table committed from the code before the tools moved
// to src/tools/. The comparison goes through TOOL_ALIASES, the one list of strings the renames changed (the ten tools
// of the errands and intentions, and the config keys named in a refusal's detail),
// applied to both sides, so a move that changes no answer passes before and after it.

type Table = Awaited<ReturnType<typeof toolDecisions>>;

/** Old string to new string, for every name the tools rename changed. */
const TOOL_ALIASES: Readonly<Record<string, string>> = {
  'features.skills': 'features.tools',
  'skills.safeMode': 'tools.safeMode',
  'skills.destructiveCooldownMinutes': 'tools.destructiveCooldownMinutes',
  'task.run': 'errand.scout',
  'task.status': 'errand.list',
  'task.read': 'errand.read',
  'task.resolve': 'errand.resolve',
  'task.cancel': 'errand.cancel',
  'task.list': 'errand.list',
  'intent.set': 'intention.set',
  'intent.update': 'intention.update',
  'intent.cancel': 'intention.cancel',
  'intent.list': 'intention.list',
  // The key a refused errand names when the open-errand cap is spent (the daily cap names
  // `agents.<agent>.daily.tasks`, which no row of the table holds).
  'agents.maxOpen': 'errands.maxOpen',
};

const pattern = new RegExp(
  `(?<![\\w.])(${Object.keys(TOOL_ALIASES)
    .sort((a, b) => b.length - a.length)
    .map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})(?![\\w])`,
  'g'
);

const canonical = (text: string): string => text.replace(pattern, (old) => TOOL_ALIASES[old] ?? old);

/** The table with every string of it (names, verdicts, details) in the new spelling. */
function canon(table: Table): Table {
  const text = canonical(JSON.stringify(table));
  return JSON.parse(text) as Table;
}

const committed = JSON.parse(
  readFileSync(new URL('../../fixtures/tool-decisions.json', import.meta.url), 'utf8')
) as Table;

test('answers every context for every tool exactly as the committed table says', async () => {
  const generated = await toolDecisions();
  assert.deepEqual(canon(generated), canon(committed));
});

// conversation.read in a turn (features.coreTools, src/behavior/turn.ts): the persona's call reads a channel
// from the record first and the interface's history when the record lacks the span, the lines
// carry handles that resolve in the next steps (message calls, before=/around= paging), a channel
// the pull rail hides is refused. Over a real admin and the fake interface adapter; no network.

const TURN_CONVERSATION_READ_NOW = Date.parse('2026-10-17T12:00:00Z');
const HOUR = 3_600_000;
const { tools: toolsValue } = labels.tools;
const L = {
  ...labels,
  tools: {
    ...labels.tools,
    tools: {
      ...toolsValue,
      conversation: {
        source: 'from conversation.read #{channel}',
        handles: 'lines carry message numbers',
        none: 'no messages',
        cut: '({dropped} lines cut)',
        earlier: 'earlier: before=#{n}',
        later: 'later: after=#{n}',
      },
    },
  },
};

function turnConversationReadRawMessage({
  id,
  authorId = 'u1',
  authorName = 'Alice',
  ts = TURN_CONVERSATION_READ_NOW - 1000,
  content = 'hey bot',
  placeId = 'c1',
}: {
  id: string;
  authorId?: string;
  authorName?: string;
  ts?: number;
  content?: string;
  placeId?: string;
}) {
  return {
    id,
    placeId,
    author: { id: authorId, bot: false, globalName: authorName, username: authorName },
    member: { displayName: authorName },
    cleanContent: content,
    createdTimestamp: ts,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
  };
}

function normalizedTrigger(raw: ReturnType<typeof turnConversationReadRawMessage>) {
  return {
    id: raw.id,
    placeId: raw.placeId,
    authorId: raw.author.id,
    authorName: raw.author.globalName,
    self: false,
    bot: false,
    content: raw.cleanContent,
    ts: raw.createdTimestamp,
    replyToId: null,
    attachments: [],
    stickers: [],
  };
}

/**
 * The server: #general (c1, the turn's), #jardin (c2, readable), #secret (c3, the bot cannot read it), in the world of
 * the test. `fetches` lists the history reads made of each.
 */
function fakeServer(history: Array<Record<string, unknown>>, jardinLive: Array<Record<string, unknown>> = []) {
  const fetches: Record<string, Array<unknown>> = { c1: [], c2: [], c3: [] };
  world().tap('history', ([ref, query]) => {
    fetches[(ref as { chatId: string }).chatId]?.push(query);
  });
  const channels = new Map([
    ['c1', world().channel({ id: 'c1', name: 'general', placeId: 'g1', historyMessages: history })],
    ['c2', world().channel({ id: 'c2', name: 'jardin', placeId: 'g1', historyMessages: jardinLive })],
    ['c3', world().channel({ id: 'c3', name: 'secret', placeId: 'g1', permissions: { read: false } })],
  ]);
  return { channels, fetches };
}

function fakeStore() {
  const profiles = [{ id: 'u7', names: ['Éloïse'] }];
  return {
    getPlace: () => ({}),
    getUser: (id: string) => profiles.find((profile) => profile.id === id) ?? null,
    getPrivate: () => null,
    listChannels: () => [],
    listUserProfiles: () => profiles,
    countUsers: () => profiles.length,
    getLore: () => [],
    liveRules: () => [],
    ...objectMediaCache({}),
    state: { data: {}, markDirty() {} },
  };
}

function hotWith(allowed: Array<string>, features: Record<string, unknown>) {
  return {
    config: {
      bot: {
        timezone: 'UTC',
        dryRunChannelId: '',
        owners: ['u1'],
        access: Object.fromEntries(allowed.map((name) => [name, { everyone: false, roles: [], users: ['self-id'] }])),
      },
      context: {
        channelMessages: 100,
        neighborMessages: 5,
        neighborMaxAgeMinutes: 60,
        neighborMaxChannels: 8,
        maxMessageChars: 800,
        gapMarkerMinutes: 20,
        otherProfiles: 6,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: {
          maxImages: 2,
          tokensPerImage: 400,
          imageSize: 512,
          recentImages: 0,
          recentImageMinutes: 0,
          maxBytes: 1_500_000,
          fetchTimeoutMs: 10_000,
        },
        pull: { scanMessages: 20, maxChannels: 1, sameAudience: false },
      },
      llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [1, 1], minMs: 0, maxMs: 100, betweenMessagesMs: [0, 0] },
      features: {
        memory: true,
        reactions: true,
        multiMessage: true,
        typingSimulation: false,
        vision: false,
        callMarkers: true,
        coreTools: true,
        record: true,
        ...features,
      },
      models: { routes: chainsOf({ analyzer: 'x/text' }) },
      media: { maxPerTurn: 6, filePreviewChars: 500 },
      gifs: { maxPerDay: 40 },
      tools: {
        safeMode: false,
        resultMaxChars: 2000,
        callTimeoutMs: 120000,
        loop: { maxSteps: 4, timeBudgetMs: 20000, maxCallsPerStep: 4 },
      },
    },
    prompts: {
      main: 'You are a regular member of this chat, not an assistant.',
      persona: 'You are friendly and terse.',
      format: 'Use <msg> and <react> tags.',
      'turn/reply': 'Someone called you: {{author}}.',
      interject: 'Jump into the chat.',
      initiate: 'Start a topic.',
      lookup: 'Decide whether {{name}} needs to look something up.',
      labels: L,
    },
  };
}

function sequenceLlm(answers: Array<unknown>) {
  const calls: Array<Array<{ role: string; content: unknown }>> = [];
  return {
    calls,
    complete: async (messages: Array<{ role: string; content: string }>) => {
      const { content } = messages[0];
      if (content.startsWith('Decide whether') || content.startsWith('Pick a second look'))
        return { text: 'none', usage: {}, estimated: 5 };
      calls.push(messages);
      return completionOf(answers[Math.min(calls.length - 1, answers.length - 1)]);
    },
  };
}

/** A record line of channel `channel`, `hoursAgo` before NOW. */
function line(
  id: string,
  hoursAgo: number,
  text: string,
  {
    channel = 'c2',
    kind = 'seen',
    by = 'u7',
    revision = 1,
  }: { channel?: string; kind?: string; by?: string; revision?: number } = {}
) {
  const at = new Date(TURN_CONVERSATION_READ_NOW - hoursAgo * HOUR).toISOString();
  return {
    kind,
    messageId: id,
    revision,
    occurredAt: at,
    recordedAt: at,
    scope: { channel },
    ...(kind === 'said' ? {} : { by }),
    text,
    media: [],
    mentions: [],
  };
}

function fakeRecord(lines: Array<Record<string, unknown>>) {
  const reads: Array<{ placeIds?: Array<string>; from?: string }> = [];
  return {
    reads,
    append: async () => ({ written: 0, duplicates: 0 }),
    iterate: async function* iterate(placeId: string, query: { placeIds?: Array<string>; from?: string }) {
      reads.push(query);
      for (const entry of lines) {
        if (query.placeIds && !query.placeIds.includes((entry.scope as { channel: string }).channel)) continue;
        if (query.from && Date.parse(entry.occurredAt as string) < Date.parse(query.from)) continue;
        yield entry;
      }
    },
  };
}

const JARDIN = [
  line('q0', 6, 'παλιότερη γραμμή'),
  line('q2', 5, 'ξένο κείμενο'),
  line('q1', 4, 'παλιό κείμενο', { kind: 'said' }),
  line('q3', 3, 'πριν την αλλαγή'),
  line('q3', 3, 'μετά την αλλαγή', { revision: 2 }),
  line('q4', 2, 'θα διαγραφεί'),
  {
    kind: 'deleted',
    messageId: 'q4',
    occurredAt: new Date(TURN_CONVERSATION_READ_NOW - 2 * HOUR).toISOString(),
    scope: { channel: 'c2' },
    participants: ['u7'],
  },
  line('q5', 1, 'η τελευταία'),
];

/** One mention in #general answered with `answers` in turn; `record` and `jardinLive` are what the record and the history of #jardin hold. */
async function turn({
  answers,
  allowed = ['conversation.read'],
  record = fakeRecord(JARDIN),
  jardinLive = [],
  features = {},
  seeds = [],
  memoryContext,
}: {
  answers: Array<unknown>;
  allowed?: Array<string>;
  record?: ReturnType<typeof fakeRecord>;
  jardinLive?: Array<Record<string, unknown>>;
  features?: Record<string, unknown>;
  seeds?: Array<{ chatId: string; authorId: string; messageId: string; text: string }>;
  memoryContext?: ReturnType<typeof issueContext>;
}) {
  const history = [
    turnConversationReadRawMessage({
      id: 'm0',
      ts: TURN_CONVERSATION_READ_NOW - 5000,
      authorId: 'u2',
      authorName: 'Zoë',
      content: 'καλημέρα',
    }),
    turnConversationReadRawMessage({ id: 'm1', content: 'διάβασε το jardin' }),
  ];
  const hot = hotWith(allowed, features);
  const server = fakeServer(history, jardinLive);
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => TURN_CONVERSATION_READ_NOW });
  for (const seed of seeds) port.seed(seed.chatId, seed);
  const client = { user: { id: 'self-id', username: 'Bot' } };
  const store = fakeStore();
  const admin = createAdmin({
    hot,
    store,
    client,
    isServedRoot: (id: unknown) => id === 'g1',
    reads: world().adopt(port),
    port,
  });
  const llm = sequenceLlm(answers);
  const calibrator = { ratio: 1, apply: (value: number) => value, observe: () => {} };
  const turns = createTurnRunner({
    hot,
    store,
    llm,
    calibrator,
    now: () => TURN_CONVERSATION_READ_NOW,
    port,
    skills: skillRegistry(),
    journal: null,
    record,
    runOp: admin.runSkillOp,
    runOwnOp: admin.runOwnSkillOp,
  });
  const { result, logs } = await withCapturedLogs(() =>
    turns.runTurn({
      channel: server.channels.get('c1'),
      mode: 'reply',
      trigger: normalizedTrigger(history[1]),
      triggerKind: 'mention',
      ...(memoryContext === undefined ? {} : { memoryContext }),
    })
  );
  return { result, logs, llm, port, server, record };
}

/** What the persona read of the calls in request `i`: the content of each tool message, in order. */
const toolReads = (llm: { calls: Array<Array<{ role: string; content: unknown }>> }, i: number) => {
  const request = llm.calls[i];
  return request
    .filter((message) => message.role === 'tool')
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : (message.content as Array<{ text: string }>).map((part) => part.text).join('')
    );
};
const requestText = (llm: { calls: Array<Array<{ role: string; content: unknown }>> }, i: number) =>
  toolReads(llm, i).join('\n');
describe('conversation reads in a turn', () => {
  before(() => {
    useIface('fake');
  });
  after(() => {
    useIface('discord');
  });

  test('not granted: the call is refused before anything is read', async () => {
    const run = await turn({
      answers: [toolAnswer('', [call('conversation.read', { place: 'jardin' })]), '<skip/>'],
      allowed: ['lore.list'],
    });
    const { reads } = run.record;
    assert.ok(
      reads.every((query) => !query.placeIds?.includes('c2')),
      'the record of #jardin was not read'
    );
    const { fetches } = run.server;
    assert.deepEqual(fetches.c2, []);
    const { result } = labels.tools;
    assert.ok(!requestText(run.llm, 1).startsWith(result.ok));
  });
});
