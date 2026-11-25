// src/subharness/place.ts: where a subharness backend lives inside the private layer: `<private>/subharness/<backend>/` holds its binary and its home, and every run and the login get
// that home in their environment. The paths are computed; one test makes a file to check the installed state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isInstalled, loginCommand, subharnessPlace, writeHarnessCurlrc } from '../../../src/subharness/place.ts';
import { tempDir } from '../../fixtures/tmp.ts';

const PRIVATE = '/srv/engine-private';

/** Whether `child` lies strictly inside `parent`. */
const inside = (child: string, parent: string): boolean => {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

test('claude lives in <private>/subharness/claude with the npm binary and CLAUDE_CONFIG_DIR inside that folder', () => {
  // Catches: claude keeps its login in the installing user's ~/.claude, or the binary path misses where npm --prefix puts it.
  const place = subharnessPlace(PRIVATE, 'claude');
  assert.equal(place.dir, path.join(PRIVATE, 'subharness', 'claude'));
  assert.equal(place.binary, path.join(place.dir, 'node_modules', '.bin', 'claude'));
  // The claude run also carries the control that keeps the pinned version from updating itself, and CURL_HOME, so curl
  // reads the home's .curlrc.
  assert.deepEqual(Object.keys(place.env), ['CLAUDE_CONFIG_DIR', 'DISABLE_AUTOUPDATER', 'CURL_HOME']);
  assert.ok(inside(place.env.CLAUDE_CONFIG_DIR ?? '', place.dir));
});

test('codex lives in <private>/subharness/codex with the npm binary and CODEX_HOME inside that folder', () => {
  // Catches: codex falls back to ~/.codex because CODEX_HOME is not set, or the binary is looked up on PATH.
  const place = subharnessPlace(PRIVATE, 'codex');
  assert.equal(place.dir, path.join(PRIVATE, 'subharness', 'codex'));
  assert.equal(place.binary, path.join(place.dir, 'node_modules', '.bin', 'codex'));
  // CURL_HOME too, so curl reads the home's .curlrc.
  assert.deepEqual(Object.keys(place.env), ['CODEX_HOME', 'CURL_HOME']);
  assert.ok(inside(place.env.CODEX_HOME ?? '', place.dir));
});

test('opencode lives in <private>/subharness/opencode with its config and data homes apart inside that folder', () => {
  // Catches: OpenCode reads the user's ~/.config/opencode or ~/.local/share/opencode, or config and data share a folder.
  const place = subharnessPlace(PRIVATE, 'opencode');
  assert.equal(place.dir, path.join(PRIVATE, 'subharness', 'opencode'));
  assert.ok(inside(place.binary, place.dir));
  // The opencode run also carries the control that keeps the pinned version from updating itself. The cache and state
  // homes are set too, because under a read-only home opencode fails on ~/.cache, and CURL_HOME, so curl reads the
  // home's .curlrc.
  assert.deepEqual(Object.keys(place.env).sort(), [
    'CURL_HOME',
    'OPENCODE_DISABLE_AUTOUPDATE',
    'XDG_CACHE_HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
  ]);
  assert.ok(inside(place.env.XDG_CACHE_HOME ?? '', place.dir));
  assert.ok(inside(place.env.XDG_STATE_HOME ?? '', place.dir));
  assert.ok(inside(place.env.XDG_CONFIG_HOME ?? '', place.dir));
  assert.ok(inside(place.env.XDG_DATA_HOME ?? '', place.dir));
  assert.notEqual(place.env.XDG_CONFIG_HOME, place.env.XDG_DATA_HOME);
});

test('a backend whose folder is empty is not installed', () => {
  // Catches: an empty or missing folder reads as installed and the run spawns a binary that is not there.
  const privateDir = tempDir('nep-place-');
  assert.equal(isInstalled(privateDir, 'codex'), false);
});

test('a binary that is not executable is not installed', () => {
  // Catches: a copy that lost its mode bit reads as installed and every run fails with EACCES instead of a clear refusal.
  const privateDir = tempDir('nep-place-');
  const { binary } = subharnessPlace(privateDir, 'opencode');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
  fs.chmodSync(binary, 0o644);
  assert.equal(isInstalled(privateDir, 'opencode'), false);
});

test("the codex login is the persona's binary with login --device-auth and CODEX_HOME in its environment", () => {
  // Catches: the owner logs in the user's own codex, so the token lands in ~/.codex and the persona's runs are logged out.
  const place = subharnessPlace(PRIVATE, 'codex');
  const login = loginCommand(PRIVATE, 'codex');
  assert.equal(login?.command, place.binary);
  assert.deepEqual(login?.args, ['login', '--device-auth']);
  assert.deepEqual(login?.env, place.env);
});

test("the claude login is the persona's binary with auth login and CLAUDE_CONFIG_DIR in its environment", () => {
  // Catches: the claude login runs without CLAUDE_CONFIG_DIR and writes its credentials to the user's ~/.claude, or
  // runs `claude login`, which claude 2.1.317 reads as a prompt to the model and logs nobody in.
  // The login is `auth login` as read from claude 2.1.317, not chosen from a help text.
  const place = subharnessPlace(PRIVATE, 'claude');
  const login = loginCommand(PRIVATE, 'claude');
  assert.equal(login?.command, place.binary);
  assert.deepEqual(login?.args, ['auth', 'login']);
  assert.ok(login?.text.endsWith('auth login'), login?.text);
  assert.deepEqual(login?.env, place.env);
});

test("the line shown to the owner sets the home before the persona's binary, so a copied line logs in the right place", () => {
  // Catches: setup prints a bare "codex login", and the owner pasting it logs in the codex on the owner's own PATH.
  const place = subharnessPlace(PRIVATE, 'codex');
  const text = loginCommand(PRIVATE, 'codex')?.text ?? '';
  const assignment = text.indexOf(`CODEX_HOME=${place.env.CODEX_HOME ?? ''}`);
  assert.ok(assignment >= 0, text);
  assert.ok(text.indexOf(place.binary) > assignment, text);
  assert.ok(text.endsWith('login --device-auth'), text);
});

test('opencode has no login: it takes a key', () => {
  // Catches: setup offers a login command for opencode that does not exist and the owner is stuck at the terminal.
  assert.equal(loginCommand(PRIVATE, 'opencode'), null);
});

// The `.curlrc` of a harness home (src/subharness/place.ts): the user agent is escaped, the file is private, and every
// harness reads it from its own home. Temp dirs only.

// Interfaces are never proxied, so `proxy set` writes no interface file and
// the test that required one is removed.

test('a .curlrc escapes the quotes and backslashes of the user agent and is private to the user', () => {
  // Catches: a quote in the agent ends curl's string early, and curl then refuses its whole config in every harness.
  const dataDir = tempDir('nep-proxy-curlrc-');
  fs.mkdirSync(subharnessPlace(dataDir, 'codex').dir, { recursive: true });
  assert.deepEqual(writeHarnessCurlrc(dataDir, 'Agent "quoted" \\ back'), ['codex']);
  const file = path.join(subharnessPlace(dataDir, 'codex').dir, 'home', '.curlrc');
  assert.equal(fs.readFileSync(file, 'utf8'), 'user-agent = "Agent \\"quoted\\" \\\\ back"\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('every harness reads its .curlrc from its own home', () => {
  // Catches: curl looks in the host user's home, since none of the CLIs sets HOME to the harness home.
  const dataDir = tempDir('nep-proxy-curlrc-');
  for (const backend of ['claude', 'codex', 'opencode'] as const) {
    const place = subharnessPlace(dataDir, backend);
    assert.equal(place.env.CURL_HOME, path.join(place.dir, 'home'), backend);
  }
});
