// agentSettings (src/agent-runner/profiles.ts) in a user unit: the profile's socket and out defaults, which are system
// paths, become the unit's own runtime and state folders, so a user install needs no `agents.<name>.socket` override.
// A value the config names still wins. The scope is the variable `neptunia setup` puts in every user unit it renders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UNIT_SCOPE_ENV, agentSettings } from '../src/agent-runner/profiles.ts';

/** Runs `body` with the environment variables of `values` set, and restores them. */
function withEnv(values: Record<string, string | undefined>, body: () => void): void {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    body();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const USER_UNIT = {
  [UNIT_SCOPE_ENV]: 'user',
  XDG_RUNTIME_DIR: '/run/user/1000',
  XDG_STATE_HOME: '/home/a/.local/state',
};

test('in a user unit the scout socket and out folder lie in the unit folders of the user', () => {
  // Bug: the user unit starts a runner that tries to create /run/neptunia-agent-scout and fails.
  withEnv(USER_UNIT, () => {
    const settings = agentSettings('scout', {});
    assert.equal(settings?.socket, '/run/user/1000/neptunia-agent-scout/sock');
    assert.equal(settings?.out, '/home/a/.local/state/neptunia-agent-scout/out');
  });
});

test('the state folder falls back to HOME/.local/state when XDG_STATE_HOME is unset', () => {
  // Bug: the out folder becomes a relative path when the user manager sets no XDG_STATE_HOME.
  withEnv({ ...USER_UNIT, XDG_STATE_HOME: undefined, HOME: '/home/b' }, () => {
    assert.equal(agentSettings('server', {})?.out, '/home/b/.local/state/neptunia-agent-server/out');
  });
});

test('a socket named in the config wins over the unit folder', () => {
  // Bug: the unit default overrides what the owner set.
  withEnv(USER_UNIT, () => {
    const settings = agentSettings('scout', { agents: { scout: { socket: '/srv/own/sock' } } });
    assert.equal(settings?.socket, '/srv/own/sock');
  });
});

test('outside a user unit the profile defaults stand', () => {
  // Bug: the system layout loses its /run and /var/lib paths.
  withEnv({ [UNIT_SCOPE_ENV]: undefined }, () => {
    assert.equal(agentSettings('scout', {})?.socket, '/run/neptunia-agent-scout/sock');
  });
});
