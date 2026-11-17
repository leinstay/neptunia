// The comparison of a rebuilt first request with an archived one (scripts/lib/turn-compare.ts): each part equal or
// with its sizes and the offset of its first difference, and a chat block whose lines repeat folded before it is
// compared.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { archivedRequest, compareRequests, foldRepeats } from '../scripts/lib/turn-compare.ts';
import { freshMemoryDb } from './fixtures/memory-db-copy.ts';

const tool = (name: string, description: string) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties: {} } },
});

const user = (chat: string) => `<self>\nΕίμαι εδώ\n</self>\n\n<chat>\n${chat}\n</chat>\n\n<task>\nΑπάντησε\n</task>`;

test('reports every part equal when the two requests are the same', () => {
  const request = { system: 'Σύστημα', user: user('#1 Ελένη: Γεια'), tools: [tool('memory_search', 'Ψάξε')] };
  const rows = compareRequests(request, structuredClone(request));
  assert.equal(
    rows.every((one) => one.equal),
    true
  );
});

test('gives the sizes and the first differing offset of a block that differs', () => {
  const rebuilt = { system: 'Σ', user: user('#1 Ελένη: Γεια'), tools: [] };
  const archived = { system: 'Σ', user: user('#1 Ελένη: Γεια σου'), tools: [] };
  const chat = compareRequests(rebuilt, archived).find((one) => one.part === '<chat>');
  assert.equal(chat?.equal, false);
  assert.equal(chat?.rebuilt, '<chat>\n#1 Ελένη: Γεια\n</chat>'.length);
  assert.equal(chat?.archived, '<chat>\n#1 Ελένη: Γεια σου\n</chat>'.length);
  assert.equal(chat?.offset, '<chat>\n#1 Ελένη: Γεια'.length);
});

test('tells a tool one request lacks from one whose schema differs', () => {
  const rebuilt = { system: 'Σ', user: user(''), tools: [tool('memory_search', 'Ψάξε')] };
  const archived = {
    system: 'Σ',
    user: user(''),
    tools: [tool('memory_search', 'Ψάξε τώρα'), tool('web_read', 'Διάβασε')],
  };
  const rows = compareRequests(rebuilt, archived);
  const search = rows.find((one) => one.part === 'tool memory_search');
  const read = rows.find((one) => one.part === 'tool web_read');
  assert.equal(search?.equal, false);
  assert.equal(search?.rebuilt, JSON.stringify(tool('memory_search', 'Ψάξε').function).length);
  assert.equal(read?.rebuilt, null);
});

test('folds a line repeated right after itself and counts the numbers again', () => {
  const doubled = ['#1 Ελένη: Γεια', '#2 Ελένη: Γεια', '#3 Νίκος: Καλησπέρα', '#4 Νίκος: Καλησπέρα'].join('\n');
  assert.equal(foldRepeats(doubled), ['#1 Ελένη: Γεια', '#2 Νίκος: Καλησπέρα'].join('\n'));
});

test('keeps a line said twice with another line between them', () => {
  const lines = ['#1 Ελένη: Γεια', '#2 Νίκος: Καλησπέρα', '#3 Ελένη: Γεια'].join('\n');
  assert.equal(foldRepeats(lines), lines);
});

test('reads the archived request of the purpose asked, the first step of it', () => {
  const handle = freshMemoryDb();
  const db = handle.db as InstanceType<typeof DatabaseSync>;
  const row = db.prepare(
    `INSERT INTO model_requests (id, schema_version, turn_id, step, purpose, status, started_at, messages, tools, response_text)
     VALUES (?, 1, 't-1', ?, ?, 'ok', ?, ?, NULL, ?)`
  );
  const messages = (text: string) => JSON.stringify([{ role: 'user', content: text }]);
  row.run('r1', 0, 'diary-planner', '2026-03-04T10:00:00.000Z', messages('Σχέδιο'), '{"kind":"status"}');
  row.run('r2', 1, 'reply', '2026-03-04T10:00:05.000Z', messages('Γράψε'), '<msg>Γεια</msg>');
  row.run('r3', 2, 'reply', '2026-03-04T10:00:09.000Z', messages('Ξανά'), '<msg>Αντίο</msg>');
  const planner = archivedRequest(db, 't-1', 'diary-planner');
  const writer = archivedRequest(db, 't-1', 'reply');
  assert.deepEqual(
    [planner?.parts.user, planner?.text, writer?.parts.user, archivedRequest(db, 't-1', 'summarize')],
    ['Σχέδιο', '{"kind":"status"}', 'Γράψε', null]
  );
  handle.close();
});
