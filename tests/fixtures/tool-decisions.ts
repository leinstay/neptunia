// The decision table of the persona's tools: for every tool of the registry, what the gateway answers in each
// context, generated from the code itself (the registry, `checkSkill`, `checkReplyEffect`, `rightsRefusal` and
// `wakeEnvelopeRefusal`). tests/fixtures/tool-decisions.json is this table as the code on `main` produced it before
// the tools moved to src/tools/; tests/tool-decisions.test.ts regenerates it and compares the two, so the move and
// the renames cannot change a single answer. `node tests/fixtures/tool-decisions.ts --write` rewrites the JSON.
//
// The modules are found where they are: each name lists the places it has lived, newest first, and the first file
// that exists is imported. A verdict is `ok` or `<code>:<detail>`. Every config the table builds sets both spellings
// of a switch (`features.skills` and `features.tools`, `skills.safeMode` and `tools.safeMode`), so the same table
// comes out of the code before and after the rename.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OWNER_PERSON, ownedBy } from './owner-accounts.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The places each module has lived, newest first. */
const LOCATIONS = {
  registry: ['src/tools/registry.ts', 'src/tools/registry.js', 'src/skills/registry.js'],
  gateway: ['src/tools/gateway.ts', 'src/tools/gateway.js', 'src/skills/gateway.js'],
  access: ['src/tools/access.ts', 'src/tools/access.js', 'src/skills/access.js'],
  rights: ['src/tools/operations/rights.ts', 'src/tools/operations/rights.js', 'src/ops/rights.js'],
  opsIndex: ['src/tools/operations/index.ts', 'src/tools/operations/index.js', 'src/ops/index.js'],
  opsRegistry: ['src/tools/operations/registry.ts', 'src/tools/operations/registry.js', 'src/ops/registry.js'],
};

async function load(name: keyof typeof LOCATIONS): Promise<unknown> {
  const found = LOCATIONS[name].find((candidate) => fs.existsSync(path.join(ROOT, candidate)));
  if (found === undefined) throw new Error(`no module found for ${name}`);
  return import(pathToFileURL(path.join(ROOT, found)).href);
}

const SELF = 'self-1';
const OWNER = 'owner-1';
const MEMBER = 'member-1';
const HERE = 'c-here';
const THERE = 'c-there';
const NOW = 1_000_000_000_000;
const MINUTE = 60_000;
const WAKE_KINDS = ['intention_due', 'review', 'errand_deadline', 'attend', 'feedback', 'heartbeat'];

type Schema = {
  type?: string;
  enum?: Array<unknown>;
  anyOf?: Array<Schema>;
  minLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  items?: Schema;
  required?: Array<string>;
  properties?: Record<string, Schema>;
};
type Tool = {
  name: string;
  op: string | null;
  effects: string;
  costClass: string;
  feature?: string | null;
  result?: string | null;
  ownerOnly: boolean;
  argsSchema: Schema;
};
type Answer = { ok: true } | { ok: false; code: string; reason: string };
type Refusal = { reason: string; detail: string };
type Settings = Record<string, unknown>;
type RegistryModule = { skillRegistry: () => Map<string, Tool> };
type GatewayModule = { checkSkill: (call: object) => Answer; checkReplyEffect: (effect: object) => Answer };
type RightsModule = { rightsRefusal: (op: object, caller: object) => string | null };
type OpsRegistryModule = { getOp: (name: string) => object | null };
type AccessModule = {
  wakeEnvelopeRefusal: (call: object) => Refusal | null;
  grantedToPersona: (config: object, selfId: string, name: string) => boolean;
  CARRIED_OVER: ReadonlyArray<string>;
  NOT_GRANTABLE_TO_PERSONA: ReadonlyArray<string>;
  NESTED_CAPABILITIES: Record<string, ReadonlyArray<string>>;
};
type ToolRow = {
  tool: string;
  effect: string;
  costClass: string;
  feature: string | null;
  result: string | null;
  ownerOnly: boolean;
  grantedByDefault: boolean;
  carriedOver: boolean;
  grantableToPersona: boolean;
  nested: Array<string>;
  reply: Record<string, string>;
  rights: Record<string, string>;
  envelope: Record<string, string>;
  verdicts: Record<string, string>;
};
export type DecisionTable = { contexts: Record<string, string>; tools: Array<ToolRow> };

/** A value a schema accepts, the smallest one that is valid. */
function sample(schema: Schema): unknown {
  if (Array.isArray(schema.enum)) return schema.enum[0];
  const first = schema.anyOf?.[0];
  if (first !== undefined) return sample(first);
  switch (schema.type) {
    case 'string':
      return 'x'.repeat(Math.max(1, schema.minLength ?? 1));
    case 'integer':
    case 'number':
      return Math.max(schema.minimum ?? 1, 1) > (schema.maximum ?? Infinity)
        ? schema.minimum
        : Math.max(schema.minimum ?? 1, 1);
    case 'boolean':
      return false;
    case 'array':
      return Array.from({ length: schema.minItems ?? 0 }, () => sample(schema.items ?? { type: 'string' }));
    case 'object':
      return Object.fromEntries(
        (schema.required ?? []).map((key) => [key, sample(schema.properties?.[key] ?? { type: 'string' })])
      );
    case undefined:
    default:
      return null;
  }
}

const verdictOf = (answer: Answer): string => (answer.ok ? 'ok' : `${answer.code}:${answer.reason}`);
const refusalOf = (answer: Refusal | null): string => (answer === null ? 'ok' : `${answer.reason}:${answer.detail}`);
const clone = <T>(value: T): T => structuredClone(value);

export async function toolDecisions(): Promise<DecisionTable> {
  await load('opsIndex');
  const { skillRegistry } = (await load('registry')) as RegistryModule;
  const { checkSkill, checkReplyEffect } = (await load('gateway')) as GatewayModule;
  const { rightsRefusal } = (await load('rights')) as RightsModule;
  const { getOp } = (await load('opsRegistry')) as OpsRegistryModule;
  const access = (await load('access')) as AccessModule;
  const registry = skillRegistry();
  const names = [...registry.keys()];
  // PR 7c: the shipped settings live in config/config.json.
  const shippedText = fs.readFileSync(path.join(ROOT, 'config', 'config.json'), 'utf8');
  const shipped = JSON.parse(shippedText) as { bot: Settings } & Settings;

  const featureKeys: Array<string> = [...new Set([...registry.values()].flatMap((skill) => (skill.feature ? [skill.feature] : [])))];
  const featuresOn: Record<string, boolean> = Object.fromEntries([...featureKeys, 'skills', 'tools'].map((key) => [key, true]));
  const grants = (everyone: boolean) =>
    Object.fromEntries(names.map((name) => [name, { everyone, roles: [], users: [SELF] }]));
  const envelopeOf = (kind: string) => {
    const index = WAKE_KINDS.indexOf(kind);
    if (index % 3 === 0) return { tools: ['memory.*', 'message.create'], maxActs: null, maxTasks: null };
    if (index % 3 === 1) return { tools: '*', maxActs: 0, maxTasks: null };
    return { tools: '*', maxActs: null, maxTasks: 0 };
  };
  /** The config of a context: everything on, every tool granted to her, the owner listed. */
  const configOf = ({
    everyone = false,
    granted = true,
    safeMode = false,
    featuresState = featuresOn,
  }: { everyone?: boolean; granted?: boolean; safeMode?: boolean; featuresState?: Record<string, boolean> } = {}): Settings => ({
    features: { ...featuresState },
    skills: { safeMode, destructiveCooldownMinutes: 10 },
    tools: { safeMode, destructiveCooldownMinutes: 10 },
    bot: { ownerPerson: OWNER_PERSON, access: granted ? grants(everyone) : {} },
    // The heartbeat's envelope is keys of its own section; every other kind's sits under `wakes.kinds`.
    wakes: {
      kinds: Object.fromEntries(
        WAKE_KINDS.filter((kind) => kind !== 'heartbeat').map((kind) => [kind, envelopeOf(kind)])
      ),
    },
    heartbeat: envelopeOf('heartbeat'),
  });
  const open = { quota: () => ({ spent: false, userSpent: false }) };
  const spent = { quota: () => ({ spent: true, userSpent: false }) };
  const budgets = {
    open: { images: open, speech: open, tasks: { budget: () => ({ spent: false }) } },
    spent: {
      images: spent,
      speech: { quota: () => ({ spent: true, code: 'daily-cap', key: 'speech.maxPerDay' }) },
      tasks: { budget: () => ({ spent: true, code: 'cap-open', key: 'tasks.maxOpen' }) },
    },
    none: {},
  };

  const contexts: Array<{
    name: string;
    about: string;
    config: object;
    requester: object | null;
    there?: boolean;
    context?: object;
  }> = [
    {
      name: 'owner-here',
      about: 'Every tool granted to her, the owner asked, in this chat',
      config: configOf(),
      requester: { id: OWNER },
      context: budgets.open,
    },
    {
      name: 'member-here',
      about: 'Granted to her, a member asked, nothing granted to the member',
      config: configOf(),
      requester: { id: MEMBER },
      context: budgets.open,
    },
    {
      name: 'member-granted-here',
      about: 'Granted to her and to everyone, a member asked',
      config: configOf({ everyone: true }),
      requester: { id: MEMBER },
      context: budgets.open,
    },
    {
      name: 'owner-there',
      about: 'The owner asked, aimed at another chat where the tool takes one',
      config: configOf(),
      requester: { id: OWNER },
      there: true,
      context: budgets.open,
    },
    {
      name: 'member-there',
      about: 'A member asked, aimed at another chat where the tool takes one',
      config: configOf(),
      requester: { id: MEMBER },
      there: true,
      context: budgets.open,
    },
    {
      name: 'ungranted-owner-here',
      about: 'Nothing granted to her, the owner asked',
      config: configOf({ granted: false }),
      requester: { id: OWNER },
      context: budgets.open,
    },
    {
      name: 'shipped-owner-here',
      about: 'The shipped config.json, the owner listed and asking',
      config: { ...clone(shipped), bot: { ...clone(shipped.bot), ownerPerson: OWNER_PERSON } },
      requester: { id: OWNER },
      context: budgets.open,
    },
    {
      name: 'no-requester',
      about: 'Granted to her, nobody asked',
      config: configOf(),
      requester: null,
      context: budgets.open,
    },
    {
      name: 'own-initiative',
      about: 'Granted to her, an inner turn with no wake kind',
      config: configOf(),
      requester: null,
      context: { ...budgets.open, ownInitiative: true },
    },
    ...WAKE_KINDS.map((kind) => ({
      name: `wake-${kind}`,
      about: `Granted to her, an inner turn woken by ${kind}, one reaction already done`,
      config: configOf(),
      requester: null,
      context: {
        ...budgets.open,
        ownInitiative: true,
        wakeKind: kind,
        wakeActions: [{ skill: 'message.react.add', status: 'executed' }],
      },
    })),
    {
      name: 'safe-mode',
      about: 'Safe mode on, the owner asked',
      config: configOf({ safeMode: true }),
      requester: { id: OWNER },
      context: budgets.open,
    },
    {
      name: 'tools-off',
      about: 'The tools switch off, the owner asked',
      config: configOf({ featuresState: { ...featuresOn, skills: false, tools: false } }),
      requester: { id: OWNER },
      context: budgets.open,
    },
    {
      name: 'features-off',
      about: 'Every feature switch of a tool off, the owner asked',
      config: configOf({
        featuresState: { skills: true, tools: true, ...Object.fromEntries(featureKeys.map((key) => [key, false])) },
      }),
      requester: { id: OWNER },
      context: budgets.open,
    },
    {
      name: 'mixed-requesters',
      about: 'The turn answers several people, the owner among them',
      config: configOf(),
      requester: { id: OWNER },
      context: { ...budgets.open, mixedRequesters: true },
    },
    {
      name: 'cooldown',
      about: 'A destructive tool ran a minute ago',
      config: configOf(),
      requester: { id: OWNER },
      context: { ...budgets.open, lastRunAt: NOW - MINUTE, now: NOW },
    },
    {
      name: 'budget-spent',
      about: 'Every daily budget spent',
      config: configOf(),
      requester: { id: OWNER },
      context: budgets.spent,
    },
    {
      name: 'budget-unknown',
      about: 'No budget source given',
      config: configOf(),
      requester: { id: OWNER },
      context: budgets.none,
    },
  ];

  const about: Record<string, string> = Object.fromEntries(contexts.map((entry) => [entry.name, entry.about]));
  const rows = names.map((name) => {
    const skill = registry.get(name);
    if (skill === undefined) throw new Error(`no tool ${name}`);
    const args = sample(skill.argsSchema) as Record<string, unknown>;
    const hasChannel = Object.hasOwn(skill.argsSchema.properties ?? {}, 'channel');
    const verdicts: Record<string, string> = {};
    for (const entry of contexts) {
      verdicts[entry.name] = verdictOf(
        checkSkill({
          skill: name,
          args: entry.there === true && hasChannel ? { ...args, channel: THERE } : args,
          principal: { kind: 'persona' },
          requester: entry.requester,
          audience: { chatId: HERE, accountIds: [MEMBER] },
          context: { config: entry.config, selfId: SELF, registry, ...(entry.context ?? {}) },
        })
      );
    }
    verdicts['unknown-principal'] = verdictOf(
      checkSkill({
        skill: name,
        args,
        principal: { kind: 'member' },
        requester: { id: OWNER },
        audience: { chatId: HERE },
        context: { config: configOf(), selfId: SELF, registry },
      })
    );
    const config = configOf();
    const reply = {
      on: verdictOf(checkReplyEffect({ skill: name, principal: { kind: 'persona' }, config })),
      off: verdictOf(
        checkReplyEffect({
          skill: name,
          principal: { kind: 'persona' },
          config: configOf({ featuresState: { ...featuresOn, skills: false, tools: false } }),
        })
      ),
    };
    const op = skill.op === null ? null : getOp(skill.op);
    const rightsFor = (accountId: string, cfg: Settings) =>
      op === null ? 'no-operation' : (rightsRefusal(op, { accountId, roleIds: [], config: cfg }) ?? 'ok');
    const rights = {
      owner: rightsFor(OWNER, config),
      member: rightsFor(MEMBER, config),
      'member-granted': rightsFor(MEMBER, configOf({ everyone: true })),
      'member-commands-off': rightsFor(MEMBER, {
        ...configOf(),
        features: { ...featuresOn, memberCommands: false },
      }),
    };
    const envelope = Object.fromEntries(
      WAKE_KINDS.map((kind) => [
        kind,
        refusalOf(
          access.wakeEnvelopeRefusal({
            config: configOf(),
            wakeKind: kind,
            skill: name,
            actions: [{ skill: 'message.react.add', status: 'executed' }],
          })
        ),
      ])
    );
    return {
      tool: name,
      effect: skill.effects,
      costClass: skill.costClass,
      feature: skill.feature ?? null,
      result: skill.result ?? null,
      ownerOnly: skill.ownerOnly === true,
      grantedByDefault: access.grantedToPersona(shipped, SELF, name),
      carriedOver: access.CARRIED_OVER.includes(name),
      grantableToPersona: !access.NOT_GRANTABLE_TO_PERSONA.includes(name),
      nested: [...(access.NESTED_CAPABILITIES[name] ?? [])],
      reply,
      rights,
      envelope,
      verdicts,
    };
  });
  return { contexts: about, tools: rows };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const table = await toolDecisions();
  if (process.argv.includes('--write')) {
    const file = fileURLToPath(new URL('./tool-decisions.json', import.meta.url));
    fs.writeFileSync(file, `${JSON.stringify(table, null, 1)}\n`);
    process.stdout.write(`wrote ${table.tools.length} tools to ${file}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(table, null, 1)}\n`);
  }
}

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy([OWNER]);
