// The rules block of the two system texts (src/rules-list.ts): with no rule the rules prompt reaches no request, with
// one or more the prompt goes in followed by one line per rule. Fixed prompts and rules, no memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemTextOf } from '../src/memory/db/session.ts';
import { buildRequest } from './fixtures/built-request.ts';
import { baseInput, fakePrompts } from './fixtures/prompt-rig.ts';

const PREAMBLE = 'A preamble.\n\n## Rules\n';
const prompts = { ...fakePrompts(), rules: PREAMBLE };
/** The system message of a request built from `input`. */
const systemOf = (input: Parameters<typeof buildRequest>[0]): unknown => buildRequest(input).messages[0].content;
const RULES = [
  { id: 'r1', text: 'one rule' },
  { id: 'r2', text: 'another rule' },
];

test('buildRequest: with no rule the system message holds no rules prompt and no gap', () => {
  assert.equal(systemOf({ ...baseInput(), prompts, rules: [] }), 'SYSTEM_TEXT for Nept\n\nCARD_TEXT\n\nFORMAT_TEXT');
});

test('buildRequest: with rules the system message holds the prompt and a line per rule after it', () => {
  assert.equal(
    systemOf({ ...baseInput(), prompts, rules: RULES }),
    'SYSTEM_TEXT for Nept\n\nCARD_TEXT\n\nA preamble.\n\n## Rules\n\n- one rule\n- another rule\n\nFORMAT_TEXT'
  );
});

test('systemTextOf: with no rule the text holds no rules prompt and no gap', () => {
  assert.equal(systemTextOf(prompts, 'Nept', 'EXTRA', []), 'SYSTEM_TEXT for Nept\n\nCARD_TEXT\n\nFORMAT_TEXT\n\nEXTRA');
});

test('systemTextOf: with a rule the text holds the prompt and the rule line after it', () => {
  assert.equal(
    systemTextOf(prompts, 'Nept', '', RULES.slice(0, 1)),
    'SYSTEM_TEXT for Nept\n\nCARD_TEXT\n\nA preamble.\n\n## Rules\n\n- one rule\n\nFORMAT_TEXT'
  );
});

test('buildRequest: a bullet in the rules prompt is no rule, so with no rule the prompt stays out', () => {
  assert.equal(
    systemOf({ ...baseInput(), prompts: { ...prompts, rules: `${PREAMBLE}\n- an old bullet\n` } }),
    'SYSTEM_TEXT for Nept\n\nCARD_TEXT\n\nFORMAT_TEXT'
  );
});
