// Tests for src/errands/blocks.ts over an errand with no agent: the `<errands>` line and the `<errand_result>` header
// of an errand still waiting for the dispatcher, or one no agent took, take their own labels and never print `null`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errandResultBody, errandsBlockText } from '../src/errands/blocks.ts';
import type { ErrandRecord } from '../src/errands/types.ts';

const LABELS = {
  errands: {
    header: 'H',
    line: '{id} {agent} {state} {error}',
    noAgent: 'NOAGENT',
    states: { queued: 'Q', failed: 'F' },
    result: { header: 'R {id} {agent}', headerNoAgent: 'RN {id}', error: 'E {error}' },
  },
};

const errand = (fields: Partial<ErrandRecord>): ErrandRecord =>
  ({ id: 't1', agent: null, goal: 'g', state: 'queued', createdAt: 0, error: null, ...fields }) as ErrandRecord;

test('an errand waiting for its agent reads with the no-agent label in the errands block', () => {
  assert.equal(errandsBlockText([errand({})], LABELS, { now: 0 }), 'H\nt1 NOAGENT Q ');
});

test('the result of an errand no agent took opens with its own header and its code', () => {
  assert.equal(errandResultBody(errand({ state: 'failed', error: 'no-agent' }), LABELS), 'RN t1\nE no-agent');
  assert.equal(errandResultBody(errand({ state: 'failed', agent: 'scout', error: 'x' }), LABELS), 'R t1 scout\nE x');
});
