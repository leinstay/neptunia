// Tests for the `<senses>` line of the abilities that are off (src/turn/request/senses.ts#renderSenses and the request
// built from it, src/behavior/prompt.ts#buildRequest). An optional model role with a null model is off
// (src/llm/roles.ts#offRoles); while one is, the stable half of `<senses>` carries one line naming the abilities
// that are down, in the words of `labels.tools.result.params.ability`, and with every role on the request is
// byte for byte what it is without any `models` setting. The labels here are this file's own words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userText } from '../src/behavior/prompt.ts';
import { fill } from '../src/format.ts';
import { renderSenses } from '../src/turn/request/senses.ts';
import { buildRequest } from './fixtures/built-request.ts';
import { labels } from './fixtures/labels.ts';
import { baseInput, fakeConfig, fakePrompts } from './fixtures/prompt-rig.ts';

const OFF_LINE = 'Down for you at the moment: {abilities}.';
const SEPARATOR = ' and ';
const WORDS = {
  imagesIn: 'looking at pictures',
  videoIn: 'watching videos',
  imagesOut: 'drawing',
  audioOut: 'voice messages',
};

/** The fixture labels with the off line, its separator and the ability words. */
const OFF_LABELS = {
  ...labels,
  senses: { ...labels.senses, abilitiesOff: OFF_LINE, abilitiesOffSeparator: SEPARATOR },
  tools: { ...labels.tools, result: { ...labels.tools.result, params: { ability: WORDS } } },
};

const ALL_ON = { vision: 'x/v', video: 'x/w', drawing: 'x/d', speech: 'x/s' };

/** The request config with the given `models.base` entries. */
const configWith = (base: Record<string, unknown>) => ({ ...fakeConfig(), models: { base } });

/** The line for these abilities, as the label fills it. */
const lineOf = (...abilities: Array<keyof typeof WORDS>) =>
  fill(OFF_LINE, { abilities: abilities.map((ability) => WORDS[ability]).join(SEPARATOR) });

// Bug caught: a deployment with every role on getting a new line, which moves its cached request and its replies.
test('renderSenses: with every optional role on, or with no models setting, the halves are those of today', () => {
  const bare = renderSenses(fakeConfig(), OFF_LABELS);
  const on = renderSenses(configWith(ALL_ON), OFF_LABELS);
  assert.deepEqual(on, bare);
  assert.equal(`${on.stable}\n${on.turn}`.includes('Down for you'), false);
});

// Bug caught: the line absent, so she claims to see pictures she is not given, or names roles in a random order.
test('renderSenses: off roles add one stable line naming their abilities in the order vision, video, drawing, speech', () => {
  const bare = renderSenses(fakeConfig(), OFF_LABELS);
  const off = renderSenses(configWith({ speech: null, drawing: null, video: 'x/w', vision: null }), OFF_LABELS);
  const line = lineOf('imagesIn', 'imagesOut', 'audioOut');
  assert.equal(off.stable.split('\n').filter((entry) => entry === line).length, 1);
  assert.equal(
    off.stable
      .split('\n')
      .filter((entry) => entry !== line)
      .join('\n'),
    bare.stable,
    'nothing else moved'
  );
  assert.equal(off.turn, bare.turn, 'the per-turn half is untouched');
});

// Bug caught: the line placed in the per-turn half, which would break the prompt cache's stable part every turn.
test('renderSenses: the line sits right after the files line', () => {
  const lines = renderSenses(configWith({ ...ALL_ON, video: null }), OFF_LABELS).stable.split('\n');
  const at = lines.indexOf(labels.senses.files);
  assert.ok(at >= 0);
  assert.equal(lines[at + 1], lineOf('videoIn'));
});

// Bug caught: false and null read differently, so a role set off the old way is announced as on.
test('renderSenses: a false model counts as off like a null one', () => {
  const lines = renderSenses(configWith({ ...ALL_ON, vision: false }), OFF_LABELS).stable.split('\n');
  assert.ok(lines.includes(lineOf('imagesIn')));
});

// Bug caught: an older labels file without the label printing an unfilled or empty line.
test('renderSenses: a labels file without senses.abilitiesOff adds nothing', () => {
  const older = { ...OFF_LABELS, senses: { ...labels.senses } };
  assert.deepEqual(renderSenses(configWith({ ...ALL_ON, vision: null }), older), renderSenses(fakeConfig(), older));
});

/** The whole text of the request: the system message and the user parts. */
const wholeOf = (request: ReturnType<typeof buildRequest>): string =>
  JSON.stringify(request.messages.map((message) => [message.role, userText(message.content)]));

// Bug caught: any byte of the request moving for a deployment where every role has a model.
test('buildRequest: with every role on the request is byte-identical to one without models, and an off role adds only the senses line', () => {
  const prompts = fakePrompts({ labels: OFF_LABELS });
  const bare = buildRequest(baseInput({ prompts }));
  const on = buildRequest(baseInput({ prompts, config: configWith(ALL_ON) }));
  assert.equal(wholeOf(on), wholeOf(bare));
  assert.deepEqual(on.messages[1].content, bare.messages[1].content, 'the cache segments too');

  const off = buildRequest(baseInput({ prompts, config: configWith({ ...ALL_ON, speech: null }) }));
  const line = lineOf('audioOut');
  const offUser = userText(off.messages[1].content).split('\n');
  assert.equal(offUser.filter((entry) => entry === line).length, 1, 'the line is in the request once');
  assert.equal(offUser.filter((entry) => entry !== line).join('\n'), userText(bare.messages[1].content));
  assert.equal(off.messages[0].content, bare.messages[0].content, 'the system message is untouched');
});
