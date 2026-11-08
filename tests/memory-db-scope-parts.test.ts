// How the scope columns of a stored line become the old scope a unit value carries (src/memory/db/map/scope-parts.ts).
// A line of a direct chat stored outside that chat's own unit names its partner by the person in `scope_dm`; once that
// person is a meta-person (`person:<uuid>`), the partner is still the one the chat's audience names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeFrom } from '../src/memory/db/map/scope-parts.ts';

test('a direct-chat line under a meta-person keeps the partner its audience names', () => {
  // Bug: the partner is parsed from the person id alone, so a meta-person gives none and the line turns internal on its next write.
  const scope = scopeFrom(
    {
      place_id: null,
      scope_kind: 'dm',
      scope_iface: 'chat',
      scope_dm: 'person:00000000-0000-4000-8000-000000000001',
      audience_id: 'aud:dm:chat:dm:d1',
    },
    {},
    null,
    'chat'
  );
  assert.deepEqual(scope, { user: 'd1' });
});

test('a direct-chat line under a spelled person keeps the partner its person names', () => {
  // Bug: the fallback to the audience replaces the partner the person id names.
  const scope = scopeFrom(
    { place_id: null, scope_kind: 'dm', scope_iface: 'chat', scope_dm: 'person:chat:d1', audience_id: 'aud:internal' },
    {},
    null,
    'chat'
  );
  assert.deepEqual(scope, { user: 'd1' });
});
