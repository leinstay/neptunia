// Tests for src/tools/tools-json.ts: the skills as native tool definitions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTools, canonicalJson, skillNameOfToolCall } from '../src/tools/tools-json.ts';
import '../src/tools/impl/index.ts';
import { buildSkills } from '../src/tools/registry.ts';
import { SKILL_DEFINITIONS, apiNameOf } from '../src/tools/definitions.ts';
import { skillText, skillsRig } from './fixtures/skills-rig.ts';

const registry = buildSkills({ table: SKILL_DEFINITIONS });
const texts = {
  'web.search': {
    title: 'Search the web',
    whenToUse: 'For fresh facts.',
    whenNotToUse: 'For chat.',
    args: { query: 'What to look up.', bogus: 'ignored' },
  },
};

const parametersOf = (tool: { function: { parameters: unknown } }) =>
  tool.function.parameters as { type: string; properties: Record<string, { description?: string }> };

test('buildTools: OpenAI-format entries sorted by API name, one per granted skill', () => {
  const tools = buildTools(['web.search', 'draw.create', 'nope.none', 'draw.create'], { registry, texts });
  assert.deepEqual(
    tools.map((t) => t.function.name),
    ['draw_create', 'web_search']
  );
  for (const tool of tools) {
    assert.equal(tool.type, 'function');
    assert.deepEqual(Object.keys(tool), ['function', 'type']);
    assert.equal(parametersOf(tool).type, 'object');
  }
  assert.deepEqual(buildTools([], { registry, texts }), []);
  assert.deepEqual(buildTools(undefined, { registry, texts }), []);
});

test('buildTools: description joins title, whenToUse and whenNotToUse; argument texts become descriptions', () => {
  const [tool] = buildTools(['web.search'], { registry, texts });
  assert.equal(tool.function.description, 'Search the web\nFor fresh facts.\nFor chat.');
  assert.equal(parametersOf(tool).properties.query.description, 'What to look up.');
  assert.equal(Object.hasOwn(parametersOf(tool).properties ?? {}, 'bogus'), false);
  const [bare] = buildTools(['web.search'], { registry, texts: {} });
  assert.equal(bare.function.description, '');
  assert.equal(Object.hasOwn(parametersOf(bare).properties.query, 'description'), false);
});

test('buildTools: deterministic JSON whatever the order asked for, definitions never mutated', () => {
  const before = JSON.stringify(registry.get('web.search')?.argsSchema);
  const a = JSON.stringify(buildTools(['web.search', 'draw.create'], { registry, texts }));
  const b = JSON.stringify(buildTools(['draw.create', 'web.search'], { registry, texts }));
  assert.equal(a, b);
  assert.equal(JSON.stringify(registry.get('web.search')?.argsSchema), before);
  assert.equal(
    JSON.stringify(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: 0 } })),
    '{"a":{"c":0,"d":[{"y":2,"z":1}]},"b":1}'
  );
});

test('buildTools: every defined skill with an API name builds', () => {
  const names = SKILL_DEFINITIONS.map((d) => d.name);
  const tools = buildTools(names, { registry, texts: {} });
  assert.equal(tools.length, names.filter((n) => apiNameOf(n)).length);
});

test('skillNameOfToolCall: the dotted name back, null when unknown', () => {
  assert.equal(skillNameOfToolCall('draw_create'), 'draw.create');
  assert.equal(skillNameOfToolCall('draw.create'), null);
  assert.equal(skillNameOfToolCall('nothing_here'), null);
  assert.equal(skillNameOfToolCall(undefined), null);
});

test('buildTools: the fill option replaces {{key}} in descriptions and argument texts, and leaves other placeholders', () => {
  const marked = { 'web.search': { title: 'Up to {{n}} chars {{other}}', args: { query: 'At most {{n}}.' } } };
  const [tool] = buildTools(['web.search'], { registry, texts: marked, fill: { n: 1600 } });
  assert.equal(tool.function.description, 'Up to 1600 chars {{other}}');
  assert.equal(parametersOf(tool).properties.query.description, 'At most 1600.');
  const [plain] = buildTools(['web.search'], { registry, texts: marked });
  assert.equal(plain.function.description, 'Up to {{n}} chars {{other}}');
});

test('buildTools: the model gets a lean schema without validation-only keywords, meaningful caps stay', () => {
  const json = JSON.stringify(buildTools([...registry.keys()], { registry, texts: {} }));
  assert.equal(json.includes('"minLength":1'), false);
  assert.equal(json.includes('"maxLength":6000'), false);
  assert.equal(json.includes('"additionalProperties":false'), false);
  assert.match(json, /"maxLength":(?!6000)\d+/, 'smaller caps are kept');
  assert.match(json, /"enum":\[/);
  assert.match(json, /"required":\[/);
  assert.equal(registry.get('web.search')?.argsSchema.additionalProperties, false, 'the engine schema is untouched');
});

// --- slice 8 of the turn frame: a skill is an entry of the tools array --------------------------------------------

const PROCEDURE = 'PROCEDURE_SENTENCE';

test('buildTools: one entry per active skill follows the tools, and an inactive or disabled skill gets none', (t) => {
  // Bug: a pending or switched-off skill offered as a tool lets her follow a procedure nobody activated.
  const rig = skillsRig(t);
  rig.writeLocal('look-it-up', skillText('look-it-up', 'I check the web first', ['web.search']));
  rig.writeLocal('ask-around', skillText('ask-around', 'I ask the room before I search', ['message.create']));
  rig.writeLocal('write-it-down', skillText('write-it-down', 'I keep a note', ['web.read']));
  rig.port.activate('look-it-up', 'agent:hand');
  rig.port.activate('ask-around', 'agent:hand');
  rig.port.disable('ask-around', 'owner');
  const tools = buildTools(['web.search', 'draw.create'], {
    registry,
    texts,
    skills: rig.port.active(),
    procedure: PROCEDURE,
  });
  assert.deepEqual(
    tools.map((tool) => tool.function.name),
    ['draw_create', 'web_search', 'look-it-up']
  );
});

test('buildTools: a skill entry is described by its line and the procedure sentence and takes no parameters', () => {
  // Bug: an entry without the procedure sentence reads as an action that does the work, not a procedure to follow.
  const skill = { name: 'look-it-up', description: 'I check the web first', missing: [] };
  const entry = buildTools([], { registry, texts, skills: [skill], procedure: PROCEDURE }).at(-1);
  assert.equal(entry?.function.name, 'look-it-up');
  assert.equal(entry?.function.description, `I check the web first\n${PROCEDURE}`);
  assert.deepEqual(entry?.function.parameters, { type: 'object', properties: {} });
});

test('buildTools: a skill whose tools are not all granted gets no entry beside one that has them all', () => {
  // Bug: a procedure that needs a tool she lacks is offered, and every step she follows is refused.
  const lacking = {
    name: 'look-it-up',
    description: 'I check the web first',
    missing: [{ tool: 'web.search', reason: 'not-granted' as const }],
  };
  const whole = { name: 'ask-around', description: 'I ask the room before I search', missing: [] };
  const tools = buildTools(['web.search'], { registry, texts, skills: [lacking, whole], procedure: PROCEDURE });
  assert.deepEqual(
    tools.map((tool) => tool.function.name),
    ['web_search', 'ask-around']
  );
});
