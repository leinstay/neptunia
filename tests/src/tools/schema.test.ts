// Tests for src/tools/schema.ts: the check of a call's arguments against its skill's schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schemaError } from '../../../src/tools/schema.ts';
import { ownedBy } from '../../fixtures/owner-accounts.ts';

const OWNER = '42';

test('skills schema: types, bounds, enums, arrays and anyOf', () => {
  const schema = {
    type: 'object',
    properties: {
      n: { type: 'integer', minimum: 1, maximum: 3 },
      kind: { type: 'string', enum: ['a', 'b'] },
      ids: { type: 'array', maxItems: 2, items: { type: 'string' } },
      on: { type: 'boolean' },
    },
    required: [],
    additionalProperties: false,
  };
  assert.equal(schemaError({ n: 2, kind: 'a', ids: ['x'], on: true }, schema), null);
  assert.equal(schemaError({ n: 1.5 }, schema), 'args.n:type');
  assert.equal(schemaError({ n: 4 }, schema), 'args.n:maximum');
  assert.equal(schemaError({ n: 0 }, schema), 'args.n:minimum');
  assert.equal(schemaError({ kind: 'c' }, schema), 'args.kind:enum');
  assert.equal(schemaError({ ids: ['x', 'y', 'z'] }, schema), 'args.ids:max-items');
  assert.equal(schemaError({ ids: [1] }, schema), 'args.ids.0:type');
  assert.equal(schemaError(JSON.parse('{"__proto__": {"n": 1}}'), schema), 'args.__proto__:unknown');
  assert.equal(schemaError([], schema), 'args:type');
});

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy([OWNER]);
