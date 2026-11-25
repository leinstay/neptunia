// Tests for scripts/lib/errand-answers.ts: the file of answers a replayed heartbeat gives its errands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseErrandAnswers } from '../../../scripts/lib/errand-answers.ts';

test('parseErrandAnswers: takes an ordered list and stops on the first fault with one line naming it', () => {
  assert.deepEqual(
    parseErrandAnswers([
      { agent: 'scout', status: 'done', text: 'found it' },
      { agent: 'any', status: 'failed', text: '', error: 'agent-crashed' },
    ]),
    [
      { agent: 'scout', status: 'done', text: 'found it', error: null },
      { agent: 'any', status: 'failed', text: '', error: 'agent-crashed' },
    ]
  );
  assert.throws(() => parseErrandAnswers({}), /a list/);
  assert.throws(() => parseErrandAnswers([{ agent: 'scout', status: 'later', text: '' }]), /answer 1: status/);
  assert.throws(() => parseErrandAnswers([{ agent: 'cook', status: 'done', text: '' }]), /answer 1: agent/);
  assert.throws(() => parseErrandAnswers([{ agent: 'code', status: 'done' }]), /answer 1: text/);
});
