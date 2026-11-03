// src/turn/request/senses.ts: what she is told about looking things up in each search configuration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSenses, sensesWhole } from '../src/turn/request/senses.ts';
import { labels } from './fixtures/labels.ts';

function linesOf(enabled: boolean, searchAvailable: boolean, toolsGranted: Array<string>): Array<string> {
  const config = { web: { search: { enabled } } } as Parameters<typeof renderSenses>[0];
  return sensesWhole(renderSenses(config, labels.senses, { searchAvailable, toolsGranted })).split('\n');
}

test('she is told the way she has: quick alone, deep alone, both, or neither, and a known page stays readable', () => {
  // Bug: with quick search off she is told nothing, or told she can search when no way exists.
  const { searchTool, deepSearchTool, readTool } = labels.senses;
  const quick = linesOf(true, true, ['web.search']);
  assert.ok(quick.includes(searchTool) && !quick.includes(deepSearchTool));
  const deep = linesOf(false, true, ['web.search', 'errand.run']);
  assert.ok(deep.includes(deepSearchTool) && !deep.includes(searchTool));
  const both = linesOf(true, true, ['web.search', 'errand.run']);
  assert.ok(both.includes(searchTool) && !both.includes(deepSearchTool));
  const neither = linesOf(false, false, ['web.read']);
  assert.ok(!neither.includes(searchTool) && !neither.includes(deepSearchTool));
  assert.ok(neither.includes(readTool));
});
