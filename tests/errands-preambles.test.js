// Tests for src/errands/preambles.js: the preamble of one errand run, picked from the files of
// prompts.local/preambles/ by agent and model, composed in order (all, agent, model,
// agent+model), prompts.local/agents.md never read, and capped by whole files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelSlugs, preambleNames, composePreamble } from '../src/errands/preambles.js';

test('modelSlugs: lowercased, every character outside [a-z0-9.] a dash, the openrouter/ prefix also dropped', () => {
  assert.deepEqual(modelSlugs('openrouter/moonshotai/kimi-k3'), ['openrouter-moonshotai-kimi-k3', 'moonshotai-kimi-k3']);
  assert.deepEqual(modelSlugs('openrouter/OpenAI/GPT-6.1-Sol:free'), ['openrouter-openai-gpt-6.1-sol-free', 'openai-gpt-6.1-sol-free']);
  assert.deepEqual(modelSlugs('anthropic/claude_x'), ['anthropic-claude-x'], 'no prefix: one form');
  assert.deepEqual(modelSlugs('vendor/modèle'), ['vendor-mod-le'], 'a non-ASCII letter is a dash');
  assert.deepEqual(modelSlugs(''), []);
  assert.deepEqual(modelSlugs(null), []);
  assert.deepEqual(modelSlugs('openrouter/'), ['openrouter-'], 'a bare prefix has no short form');
});

test('preambleNames: all, agent, model forms, agent+model forms, in that order', () => {
  assert.deepEqual(preambleNames('web', 'openrouter/moonshotai/kimi-k3'), [
    'all',
    'web',
    '@openrouter-moonshotai-kimi-k3',
    '@moonshotai-kimi-k3',
    'web@openrouter-moonshotai-kimi-k3',
    'web@moonshotai-kimi-k3',
  ]);
  assert.deepEqual(preambleNames('server', null), ['all', 'server']);
});

test('composePreamble: the matching files in order, joined by a blank line, empty and foreign files skipped', () => {
  const prompts = {
    preambles: {
      all: 'ALL',
      web: 'WEB',
      server: 'SERVER',
      '@openrouter-moonshotai-kimi-k3': 'MODEL-FULL',
      '@moonshotai-kimi-k3': 'MODEL-SHORT',
      'web@moonshotai-kimi-k3': 'WEB-MODEL',
      'server@moonshotai-kimi-k3': 'SERVER-MODEL',
      '@openai-gpt-6.1-sol': 'OTHER-MODEL',
      'web@openrouter-moonshotai-kimi-k3': '',
    },
  };
  const out = composePreamble({ prompts, agent: 'web', model: 'openrouter/moonshotai/kimi-k3', maxChars: 8000 });
  assert.equal(out.text, 'ALL\n\nWEB\n\nMODEL-FULL\n\nMODEL-SHORT\n\nWEB-MODEL');
  assert.deepEqual(out.files, [
    'preambles/all.md',
    'preambles/web.md',
    'preambles/@openrouter-moonshotai-kimi-k3.md',
    'preambles/@moonshotai-kimi-k3.md',
    'preambles/web@moonshotai-kimi-k3.md',
  ]);
  assert.deepEqual(out.dropped, []);
  assert.equal(out.chars, out.text.length);

  const short = composePreamble({ prompts: { preambles: { '@moonshotai-kimi-k3': '  only the short form \n' } }, agent: 'web', model: 'openrouter/moonshotai/kimi-k3' });
  assert.equal(short.text, 'only the short form', 'the id without its provider prefix matches, trimmed');

  const none = composePreamble({ prompts: {}, agent: 'web', model: 'openrouter/x/y' });
  assert.deepEqual(none, { text: '', files: [], dropped: [], chars: 0 });
  assert.deepEqual(composePreamble({ agent: 'web' }), { text: '', files: [], dropped: [], chars: 0 }, 'no prompts at all');
});

test('composePreamble: prompts.local/agents.md (the prompt `agents`) is never a preamble', () => {
  const beside = composePreamble({ prompts: { agents: 'OLD', preambles: { web: 'WEB' } }, agent: 'web', model: null });
  assert.equal(beside.text, 'WEB');
  assert.deepEqual(beside.files, ['preambles/web.md']);

  const emptyAll = composePreamble({ prompts: { agents: 'OLD', preambles: { all: '' } }, agent: 'web' });
  assert.deepEqual(emptyAll, { text: '', files: [], dropped: [], chars: 0 }, 'an empty all.md is nothing');

  assert.equal(composePreamble({ prompts: { agents: 'OLD' }, agent: 'web' }).text, '', 'without the folder');
});

test('composePreamble: over the cap, whole files are taken in order while they fit and the rest named', () => {
  const prompts = { preambles: { all: 'a'.repeat(60), web: 'w'.repeat(30), '@x-y': 'm'.repeat(10) } };
  // all (60) + sep (2) + web (30) = 92 > 80: web dropped; all + sep + model (10) = 72 fits.
  const out = composePreamble({ prompts, agent: 'web', model: 'x/y', maxChars: 80 });
  assert.equal(out.text, `${'a'.repeat(60)}\n\n${'m'.repeat(10)}`);
  assert.deepEqual(out.files, ['preambles/all.md', 'preambles/@x-y.md']);
  assert.deepEqual(out.dropped, ['preambles/web.md']);
  assert.equal(out.chars, 72);
  assert.ok(out.chars <= 80);

  const exact = composePreamble({ prompts, agent: 'web', model: 'x/y', maxChars: 92 });
  assert.deepEqual(exact.files, ['preambles/all.md', 'preambles/web.md'], 'exactly at the cap fits');
  assert.deepEqual(exact.dropped, ['preambles/@x-y.md']);

  const tooBig = composePreamble({ prompts: { preambles: { all: 'a'.repeat(100) } }, agent: 'web', maxChars: 50 });
  assert.deepEqual(tooBig, { text: '', files: [], dropped: ['preambles/all.md'], chars: 0 }, 'never a cut file');
});
