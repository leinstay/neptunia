// src/protocol/identity.ts: the native authority an interface issues ids under.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORE_AUTHORITY, nativeAuthorityOf } from '../../../src/protocol/identity.ts';

test('answers the local authority for cli and core and the global one for any other interface', () => {
  // Bug: a Discord id and a command-line id sharing one authority would merge two people's accounts.
  assert.equal(nativeAuthorityOf('cli'), 'cli/local');
  assert.equal(nativeAuthorityOf('core'), 'core/local');
  assert.equal(nativeAuthorityOf('discord'), 'discord/global');
});

test('answers the core authority when the interface is no string or is empty', () => {
  // Bug: a row with no interface would get an authority like "undefined/global" and escape the core's namespace.
  assert.equal(nativeAuthorityOf(undefined), CORE_AUTHORITY);
  assert.equal(nativeAuthorityOf(42), CORE_AUTHORITY);
  assert.equal(nativeAuthorityOf(''), CORE_AUTHORITY);
});
