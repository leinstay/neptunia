// Tests for src/skills/tools-json.js: the skills as native tool definitions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTools, canonicalJson, skillNameOfToolCall } from '../src/skills/tools-json.js';
import '../src/ops/index.js';
import { buildSkills } from '../src/skills/registry.js';
import { SKILL_DEFINITIONS, apiNameOf } from '../src/skills/definitions.js';

const registry = buildSkills({ table: SKILL_DEFINITIONS });
const texts = {
  'web.search': {
    title: 'Search the web',
    whenToUse: 'For fresh facts.',
    whenNotToUse: 'For chat.',
    args: { query: 'What to look up.', bogus: 'ignored' },
  },
};

test('buildTools: OpenAI-format entries sorted by API name, one per granted skill', () => {
  const tools = buildTools(['web.search', 'draw.create', 'nope.none', 'draw.create'], { registry, texts });
  assert.deepEqual(
    tools.map((t) => t.function.name),
    ['draw_create', 'web_search']
  );
  for (const tool of tools) {
    assert.equal(tool.type, 'function');
    assert.deepEqual(Object.keys(tool), ['function', 'type']);
    assert.equal(tool.function.parameters.type, 'object');
  }
  assert.deepEqual(buildTools([], { registry, texts }), []);
  assert.deepEqual(buildTools(undefined, { registry, texts }), []);
});

test('buildTools: description joins title, whenToUse and whenNotToUse; argument texts become descriptions', () => {
  const [tool] = buildTools(['web.search'], { registry, texts });
  assert.equal(tool.function.description, 'Search the web\nFor fresh facts.\nFor chat.');
  assert.equal(tool.function.parameters.properties.query.description, 'What to look up.');
  assert.equal(Object.hasOwn(tool.function.parameters.properties, 'bogus'), false);
  const [bare] = buildTools(['web.search'], { registry, texts: {} });
  assert.equal(bare.function.description, '');
  assert.equal(Object.hasOwn(bare.function.parameters.properties.query, 'description'), false);
});

test('buildTools: deterministic JSON whatever the order asked for, definitions never mutated', () => {
  const before = JSON.stringify(registry.get('web.search').argsSchema);
  const a = JSON.stringify(buildTools(['web.search', 'draw.create'], { registry, texts }));
  const b = JSON.stringify(buildTools(['draw.create', 'web.search'], { registry, texts }));
  assert.equal(a, b);
  assert.equal(JSON.stringify(registry.get('web.search').argsSchema), before);
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
  assert.equal(tool.function.parameters.properties.query.description, 'At most 1600.');
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
  assert.equal(registry.get('web.search').argsSchema.additionalProperties, false, 'the engine schema is untouched');
});
