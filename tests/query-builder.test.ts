// The query builder: the step before a search that plans whether to search, where, and with which forms. One module for
// every caller, a DM, a group on any interface, the selfreflection planner and the heartbeat.
// Contract, plan 2026-11-04-cli-and-memory B4 and B9, module src/behavior/query-builder.ts:
//   `parseQueryPlan(raw, { timezone, now, maxForms, skillNames })` reads the labelled lines `web:`, `history:`, `who:`,
//   `when:`, `recent:`, `when-role:` and `skills:` into `{ web, history, reason, skills? }`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQueryPlan } from '../src/behavior/query-builder.ts';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const OPTIONS = { timezone: 'UTC', now: NOW, maxForms: 8 };

test('an empty answer plans no search', () => {
  // Bug: a reasoning model that spent its cap reads as a query.
  for (const raw of ['', null, undefined, '  \n ']) assert.equal(parseQueryPlan(raw, OPTIONS).reason, 'empty');
});
