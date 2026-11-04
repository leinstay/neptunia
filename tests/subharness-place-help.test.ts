// `loginCommand` (src/subharness/place.ts) against the `--help` of an installed claude. The help of a release lists its
// commands at one column and wraps their descriptions at a deeper one, and a wrapped line may start with anything. The
// login is read from the commands alone, and a help that names no login is said out loud: `claude login` on a release
// without that command is a conversational prompt, so a guess spends a model turn and logs nobody in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loginCommand } from '../src/subharness/place.ts';

const PRIVATE = '/srv/engine-private';

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

const UNKNOWN_HELPS: ReadonlyArray<[string, string]> = [
  ['has no commands heading', 'Usage: claude [options] [prompt]\n\nOptions:\n  -h, --help  Display help\n'],
  ['lists neither auth nor login', 'Commands:\n  mcp   Configure servers\n  doctor   Check the installation\n'],
  ['is empty, as from a binary that did not run', ''],
];

for (const [what, help] of UNKNOWN_HELPS) {
  test(`a help that ${what} throws a diagnostic naming the backend and its help`, () => {
    // Catches: an unknown release is answered `claude login`, which it reads as a prompt to the model.
    assert.throws(
      () => loginCommand(PRIVATE, 'claude', help),
      (err: unknown) => err instanceof Error && err.message.includes('claude') && err.message.includes('--help')
    );
  });
}
