// The decision table of the persona's tools (tests/fixtures/tool-decisions.mjs): what the gateway answers for every tool
// in every context, regenerated from the code and compared with the table committed from the code before the tools moved
// to src/tools/. The comparison goes through TOOL_ALIASES, the one list of strings the renames changed (the tool
// `skills.describe`, the ten tools of the errands and intentions, and the config keys named in a refusal's detail),
// applied to both sides, so a move that changes no answer passes before and after it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toolDecisions } from './fixtures/tool-decisions.mjs';

type Table = Awaited<ReturnType<typeof toolDecisions>>;

/** Old string to new string, for every name the tools rename changed. */
const TOOL_ALIASES: Readonly<Record<string, string>> = {
  'skills.describe': 'tools.describe',
  'features.skills': 'features.tools',
  'skills.safeMode': 'tools.safeMode',
  'skills.destructiveCooldownMinutes': 'tools.destructiveCooldownMinutes',
  'task.run': 'errand.run',
  'task.status': 'errand.status',
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

const committed = JSON.parse(readFileSync(new URL('./fixtures/tool-decisions.json', import.meta.url), 'utf8')) as Table;

test('answers every context for every tool exactly as the committed table says', async () => {
  const generated = await toolDecisions();
  assert.deepEqual(canon(generated), canon(committed));
});

test('the committed table holds a row per tool of the registry and a verdict per context', () => {
  const contexts = Object.keys(committed.contexts);
  const gaps = committed.tools.flatMap((row) =>
    contexts.filter((name) => row.verdicts[name] === undefined).map((name) => `${row.tool}:${name}`)
  );
  assert.deepEqual(gaps, []);
  // Two more since the board tools board.propose and board.status (PR 6c).
  assert.equal(committed.tools.length, 69);
});
