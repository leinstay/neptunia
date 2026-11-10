// src/subharness/place.ts: where a subharness backend lives inside the private layer (spec 2026-11-02, PR 5, "Where a
// subharness lives"): `<private>/subharness/<backend>/` holds its binary and its home, and every run and the login get
// that home in their environment. The paths are computed; one test makes a file to check the installed state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isInstalled, loginCommand, subharnessPlace } from '../src/subharness/place.ts';
import { tempDir } from './fixtures/tmp.ts';

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
  // Changed: the claude run also carries the control that keeps the pinned version from updating itself.
  // Stage Z: and CURL_HOME, so curl reads the home's .curlrc.
  assert.deepEqual(Object.keys(place.env), ['CLAUDE_CONFIG_DIR', 'DISABLE_AUTOUPDATER', 'CURL_HOME']);
  assert.ok(inside(place.env.CLAUDE_CONFIG_DIR ?? '', place.dir));
});

test('codex lives in <private>/subharness/codex with the npm binary and CODEX_HOME inside that folder', () => {
  // Catches: codex falls back to ~/.codex because CODEX_HOME is not set, or the binary is looked up on PATH.
  const place = subharnessPlace(PRIVATE, 'codex');
  assert.equal(place.dir, path.join(PRIVATE, 'subharness', 'codex'));
  assert.equal(place.binary, path.join(place.dir, 'node_modules', '.bin', 'codex'));
  // Stage Z: CURL_HOME too, so curl reads the home's .curlrc.
  assert.deepEqual(Object.keys(place.env), ['CODEX_HOME', 'CURL_HOME']);
  assert.ok(inside(place.env.CODEX_HOME ?? '', place.dir));
});

test('opencode lives in <private>/subharness/opencode with its config and data homes apart inside that folder', () => {
  // Catches: OpenCode reads the user's ~/.config/opencode or ~/.local/share/opencode, or config and data share a folder.
  const place = subharnessPlace(PRIVATE, 'opencode');
  assert.equal(place.dir, path.join(PRIVATE, 'subharness', 'opencode'));
  assert.ok(inside(place.binary, place.dir));
  // Changed: the opencode run also carries the control that keeps the pinned version from updating itself.
  // Changed again: the cache and state homes are set too, because under a read-only home opencode fails on ~/.cache.
  // Stage Z: CURL_HOME too, so curl reads the home's .curlrc.
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

test('the codex login is her binary with login --device-auth and CODEX_HOME in its environment', () => {
  // Catches: the owner logs in the user's own codex, so the token lands in ~/.codex and her runs are logged out.
  const place = subharnessPlace(PRIVATE, 'codex');
  const login = loginCommand(PRIVATE, 'codex');
  assert.equal(login?.command, place.binary);
  assert.deepEqual(login?.args, ['login', '--device-auth']);
  assert.deepEqual(login?.env, place.env);
});

test('the claude login is her binary with its login subcommand and CLAUDE_CONFIG_DIR in its environment', () => {
  // Catches: the claude login runs without CLAUDE_CONFIG_DIR and writes its credentials to the user's ~/.claude.
  const place = subharnessPlace(PRIVATE, 'claude');
  const login = loginCommand(PRIVATE, 'claude');
  assert.equal(login?.command, place.binary);
  assert.ok(login?.args.includes('login'));
  assert.deepEqual(login?.env, place.env);
});

test('the line shown to the owner sets the home before her binary, so a copied line logs in the right place', () => {
  // Catches: setup prints a bare "codex login", and the owner pasting it logs in the codex on his own PATH.
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

// `loginCommand` (src/subharness/place.ts) against the `--help` of an installed claude. The help of a release lists its
// commands at one column and wraps their descriptions at a deeper one, and a wrapped line may start with anything. The
// login is read from the commands alone, and a help that names no login is said out loud: `claude login` on a release
// without that command is a conversational prompt, so a guess spends a model turn and logs nobody in.

/** The shape of `claude --help` of 2.1.317: the description of `attach` wraps onto a line starting with `<id>`. */
const CLAUDE_HELP = `Usage: claude [options] [command] [prompt]

Claude Code - starts an interactive session by default, use -p/--print for
non-interactive output

Options:
  -d, --debug [filter]                  Enable debug mode
  -h, --help                            Display help for command

Commands:
  agents [options]                      Manage background agents
  attach <id|name>                      Open a background session in this
                                        terminal. <id> is the short id that
                                        \`claude --bg\` prints and \`claude agents\`
                                        lists. Part of the session name works
                                        too
  auth                                  Manage authentication
  auto-mode                             Inspect or reset auto mode configuration
  doctor                                Check the health of your Claude Code
                                        installation.
  plugin|plugins                        Manage Claude Code plugins
  setup-token                           Set up a long-lived authentication token
                                        (requires Claude subscription)
  update|upgrade                        Check for updates and install if
                                        available
`;

const UNKNOWN_HELPS: ReadonlyArray<[string, string]> = [
  ['has no commands heading', 'Usage: claude [options] [prompt]\n\nOptions:\n  -h, --help  Display help\n'],
  ['lists neither auth nor login', 'Commands:\n  mcp   Configure servers\n  doctor   Check the installation\n'],
  ['is empty, as from a binary that did not run', ''],
];

test('the installed help with a wrapped description before auth gives auth login', () => {
  // Catches: the list stops at the wrapped line starting with `<`, auth is never seen, and the owner is shown `claude login`.
  const login = loginCommand(PRIVATE, 'claude', CLAUDE_HELP);
  assert.deepEqual(login?.args, ['auth', 'login']);
  assert.ok(login?.text.endsWith('auth login'), login?.text);
});

test('a wrapped description starting with the word login is no login command', () => {
  // Catches: any indented line counts as a command, so a description's first word hides auth login behind `claude login`.
  const help = `Commands:
  auth                                  Manage authentication
  mcp                                   Configure servers after the first
                                        login to this account
`;
  assert.deepEqual(loginCommand(PRIVATE, 'claude', help)?.args, ['auth', 'login']);
});

test('a release that lists login past a wrapped description logs in with login', () => {
  // Catches: the fix hardcodes auth login, so a release with its own login command is sent a command it does not have.
  const help = `Commands:
  attach <id>                           Open a session. The short id is
                                        <id> as printed by the list
  login                                 Sign in
  auth                                  Manage authentication
`;
  assert.deepEqual(loginCommand(PRIVATE, 'claude', help)?.args, ['login']);
});

for (const [what, help] of UNKNOWN_HELPS) {
  test(`a help that ${what} throws a diagnostic naming the backend and its help`, () => {
    // Catches: an unknown release is answered `claude login`, which it reads as a prompt to the model.
    assert.throws(
      () => loginCommand(PRIVATE, 'claude', help),
      (err: unknown) => err instanceof Error && err.message.includes('claude') && err.message.includes('--help')
    );
  });
}
