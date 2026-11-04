// Tests for the rules list of the prompt layer (src/rules-list.ts), through the two system texts that carry it: the
// rules file reaches a request whole while its list holds a rule, and adds nothing at all while the list is empty.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemTextOf } from '../src/memory/db/session.ts';
import { buildRequest } from './fixtures/built-request.ts';
import { baseInput, fakePrompts } from './fixtures/prompt-rig.ts';

const PREAMBLE = 'A preamble.\n\n## Rules';
const withRules = (rules: string) => ({ ...fakePrompts(), rules });

test('buildRequest: a rules file with an empty list adds neither its preamble nor a gap', () => {
  const request = buildRequest({ ...baseInput(), prompts: withRules(PREAMBLE) });
  assert.equal(request.messages[0].content, 'SYSTEM_TEXT for Nept\n\nCARD_TEXT\n\nFORMAT_TEXT');
});

test('buildRequest: a rules file with one rule goes in whole, its preamble included', () => {
  const rules = `${PREAMBLE}\n\n- one rule`;
  const request = buildRequest({ ...baseInput(), prompts: withRules(rules) });
  assert.equal(request.messages[0].content, `SYSTEM_TEXT for Nept\n\nCARD_TEXT\n\n${rules}\n\nFORMAT_TEXT`);
});

test('systemTextOf: a rules file with an empty list adds neither its preamble nor a gap', () => {
  assert.equal(
    systemTextOf(withRules(PREAMBLE), 'Nept', 'EXTRA'),
    'SYSTEM_TEXT for Nept\n\nCARD_TEXT\n\nFORMAT_TEXT\n\nEXTRA'
  );
});

test('systemTextOf: a rules file with one rule goes in whole, its preamble included', () => {
  const rules = `${PREAMBLE}\n\n- one rule`;
  assert.equal(
    systemTextOf(withRules(rules), 'Nept', ''),
    `SYSTEM_TEXT for Nept\n\nCARD_TEXT\n\n${rules}\n\nFORMAT_TEXT`
  );
});
