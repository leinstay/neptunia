// Tests for src/errands/preambles.ts: the preamble of one errand run, picked from the files of
// prompts.local/preambles/ by agent and model, composed in order (all, agent, model,
// agent+model), prompts.local/agents.md never read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelSlugs, preambleNames, composePreamble } from '../src/errands/preambles.ts';

test('modelSlugs: lowercased, every character outside [a-z0-9.] a dash, the openrouter/ prefix also dropped', () => {
  assert.deepEqual(modelSlugs('openrouter/moonshotai/kimi-k3'), [
    'openrouter-moonshotai-kimi-k3',
    'moonshotai-kimi-k3',
  ]);
  assert.deepEqual(modelSlugs('openrouter/OpenAI/GPT-6.1-Sol:free'), [
    'openrouter-openai-gpt-6.1-sol-free',
    'openai-gpt-6.1-sol-free',
  ]);
  assert.deepEqual(modelSlugs('anthropic/claude_x'), ['anthropic-claude-x'], 'no prefix: one form');
  assert.deepEqual(modelSlugs('vendor/modèle'), ['vendor-mod-le'], 'a non-ASCII letter is a dash');
  assert.deepEqual(modelSlugs(''), []);
  assert.deepEqual(modelSlugs(null), []);
  assert.deepEqual(modelSlugs('openrouter/'), ['openrouter-'], 'a bare prefix has no short form');
});

test('preambleNames: all, agent, model forms, agent+model forms, in that order', () => {
  assert.deepEqual(preambleNames('scout', 'openrouter/moonshotai/kimi-k3'), [
    'all',
    'scout',
    '@openrouter-moonshotai-kimi-k3',
    '@moonshotai-kimi-k3',
    'scout@openrouter-moonshotai-kimi-k3',
    'scout@moonshotai-kimi-k3',
  ]);
  assert.deepEqual(preambleNames('server', null), ['all', 'server']);
});

test('composePreamble: the matching files in order, joined by a blank line, empty and foreign files skipped', () => {
  const prompts = {
    preambles: {
      all: 'ALL',
      scout: 'SCOUT',
      server: 'SERVER',
      '@openrouter-moonshotai-kimi-k3': 'MODEL-FULL',
      '@moonshotai-kimi-k3': 'MODEL-SHORT',
      'scout@moonshotai-kimi-k3': 'SCOUT-MODEL',
      'server@moonshotai-kimi-k3': 'SERVER-MODEL',
      '@openai-gpt-6.1-sol': 'OTHER-MODEL',
      'scout@openrouter-moonshotai-kimi-k3': '',
    },
  };
  // Stage X: the preamble has no cap, so `maxChars` and the result's `dropped` are gone from these expectations.
  const out = composePreamble({ prompts, agent: 'scout', model: 'openrouter/moonshotai/kimi-k3' });
  assert.equal(out.text, 'ALL\n\nSCOUT\n\nMODEL-FULL\n\nMODEL-SHORT\n\nSCOUT-MODEL');
  assert.deepEqual(out.files, [
    'preambles/all.md',
    'preambles/scout.md',
    'preambles/@openrouter-moonshotai-kimi-k3.md',
    'preambles/@moonshotai-kimi-k3.md',
    'preambles/scout@moonshotai-kimi-k3.md',
  ]);
  assert.equal(out.chars, out.text.length);

  const short = composePreamble({
    prompts: { preambles: { '@moonshotai-kimi-k3': '  only the short form \n' } },
    agent: 'scout',
    model: 'openrouter/moonshotai/kimi-k3',
  });
  assert.equal(short.text, 'only the short form', 'the id without its provider prefix matches, trimmed');

  const none = composePreamble({ prompts: {}, agent: 'scout', model: 'openrouter/x/y' });
  assert.deepEqual(none, { text: '', files: [], chars: 0 });
  assert.deepEqual(composePreamble({ agent: 'scout' }), { text: '', files: [], chars: 0 }, 'no prompts at all');
});

test('composePreamble: prompts.local/agents.md (the prompt `agents`) is never a preamble', () => {
  const beside = composePreamble({
    // @ts-expect-error: the retired agents key is passed on purpose, to check that it is ignored
    prompts: { agents: 'OLD', preambles: { scout: 'SCOUT' } },
    agent: 'scout',
    model: null,
  });
  assert.equal(beside.text, 'SCOUT');
  assert.deepEqual(beside.files, ['preambles/scout.md']);

  // @ts-expect-error: the retired agents key is passed on purpose, to check that it is ignored
  const emptyAll = composePreamble({ prompts: { agents: 'OLD', preambles: { all: '' } }, agent: 'scout' });
  assert.deepEqual(emptyAll, { text: '', files: [], chars: 0 }, 'an empty all.md is nothing');

  // @ts-expect-error: the retired agents key is passed on purpose, to check that it is ignored
  assert.equal(composePreamble({ prompts: { agents: 'OLD' }, agent: 'scout' }).text, '', 'without the folder');
});

// Stage X: the cap test that stood here is gone with the cap; tests/preamble-no-cap.test.ts checks every file goes in.
