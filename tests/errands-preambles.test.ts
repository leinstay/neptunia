// Tests for src/errands/preambles.ts: the preamble of one errand run, picked from the files of
// data/prompts/preambles/ by agent and by the last path segment of the run's model, composed in order
// (all, agent, model, agent+model).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelSlug, preambleNames, composePreamble } from '../src/errands/preambles.ts';

// Changed: the slug is the last path segment of the id, literally, replacing the dashed slugs of the whole id
// (owner, 2026-11-17), so `@claude-sonnet-4.6.md` matches the model on every provider.
test('modelSlug: the last path segment of the id, lowercased, null for a blank or non-string id', () => {
  assert.equal(modelSlug('openrouter/anthropic/claude-sonnet-4.6'), 'claude-sonnet-4.6');
  assert.equal(modelSlug('google/Claude-Sonnet-4.6'), 'claude-sonnet-4.6');
  assert.equal(modelSlug('claude-opus-5-5'), 'claude-opus-5-5', 'an id with no slash is its own segment');
  assert.equal(modelSlug('openrouter/openai/gpt-6.1-sol:free'), 'gpt-6.1-sol:free', 'no character is replaced');
  assert.equal(modelSlug('  vendor/model  '), 'model', 'trimmed');
  assert.equal(modelSlug('vendor/'), null, 'an id that ends in a slash has no segment');
  assert.equal(modelSlug(''), null);
  assert.equal(modelSlug('   '), null);
  assert.equal(modelSlug(null), null);
  assert.equal(modelSlug(42), null);
});

// Changed: one model form per run, the last path segment, in place of the whole-id and short forms.
test('preambleNames: all, agent, @model, agent@model, in that order', () => {
  assert.deepEqual(preambleNames('scout', 'openrouter/moonshotai/kimi-k3'), [
    'all',
    'scout',
    '@kimi-k3',
    'scout@kimi-k3',
  ]);
  assert.deepEqual(preambleNames('server', null), ['all', 'server']);
  assert.deepEqual(preambleNames('', 'vendor/model'), ['all', '@model'], 'no agent: no agent forms');
});

test('composePreamble: @claude-sonnet-4.6 matches openrouter/anthropic/claude-sonnet-4.6', () => {
  // Catches: the model files are still keyed by the whole id, so an OpenRouter run misses the file named by the model.
  const preambles = { '@claude-sonnet-4.6': 'SONNET', 'scout@claude-sonnet-4.6': 'SCOUT-SONNET' };
  const out = composePreamble({ preambles, agent: 'scout', model: 'openrouter/anthropic/claude-sonnet-4.6' });
  assert.equal(out.text, 'SONNET\n\nSCOUT-SONNET');
  assert.deepEqual(out.files, ['preambles/@claude-sonnet-4.6.md', 'preambles/scout@claude-sonnet-4.6.md']);
});

test('composePreamble: @claude-sonnet-4.6 matches google/claude-sonnet-4.6', () => {
  // Catches: only the `openrouter/` prefix is stripped, so the same model from another provider misses its file.
  const preambles = { '@claude-sonnet-4.6': 'SONNET' };
  const out = composePreamble({ preambles, agent: 'scout', model: 'google/claude-sonnet-4.6' });
  assert.equal(out.text, 'SONNET');
  assert.deepEqual(out.files, ['preambles/@claude-sonnet-4.6.md']);
});

test('composePreamble: @claude-sonnet-4.6 does not match claude-sonnet-4-6', () => {
  // Catches: dots and dashes are normalised, so a file written for one model id reaches a different one.
  const preambles = { '@claude-sonnet-4.6': 'SONNET', 'scout@claude-sonnet-4.6': 'SCOUT-SONNET' };
  const out = composePreamble({ preambles, agent: 'scout', model: 'claude-sonnet-4-6' });
  assert.deepEqual(out, { text: '', files: [], chars: 0 });
});

test('composePreamble: all, agent, @model, agent@model in that order, joined by a blank line, an empty file skipped', () => {
  // Catches: the files go in another order, or an empty file adds a blank part, or another agent's file is read.
  const preambles = {
    'scout@kimi-k3': 'SCOUT-MODEL',
    '@kimi-k3': 'MODEL',
    scout: '   ',
    all: 'ALL',
    server: 'SERVER',
    'server@kimi-k3': 'SERVER-MODEL',
    '@other': 'OTHER-MODEL',
  };
  const out = composePreamble({ preambles, agent: 'scout', model: 'openrouter/moonshotai/kimi-k3' });
  assert.equal(out.text, 'ALL\n\nMODEL\n\nSCOUT-MODEL');
  assert.deepEqual(out.files, ['preambles/all.md', 'preambles/@kimi-k3.md', 'preambles/scout@kimi-k3.md']);
  assert.equal(out.chars, out.text.length);

  const withAgent = composePreamble({
    preambles: { ...preambles, scout: ' SCOUT \n' },
    agent: 'scout',
    model: 'openrouter/moonshotai/kimi-k3',
  });
  assert.equal(withAgent.text, 'ALL\n\nSCOUT\n\nMODEL\n\nSCOUT-MODEL', 'the agent file second, trimmed');

  assert.deepEqual(composePreamble({ preambles: {}, agent: 'scout', model: 'x/y' }), { text: '', files: [], chars: 0 });
  assert.deepEqual(composePreamble({ agent: 'scout' }), { text: '', files: [], chars: 0 }, 'no preambles at all');
});

// Stage X: the cap test that stood here is gone with the cap; tests/preamble-no-cap.test.ts checks every file goes in.
