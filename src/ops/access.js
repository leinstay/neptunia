// Operations: `/nep access`: who besides the owners may run which command (bot.access, src/discord/access.js). Owner-only.
// The handler bodies moved here from src/admin.js unchanged; each `run` calls one of them with
// the operation's `ctx` as the command context.

import { commandKeys } from '../discord/commands.js';
import { isOwnerOnly, isMemberCommand, grant as accessGrant, revoke as accessRevoke, hasGrant } from '../discord/access.js';
import { READ_ONLY_ACCESS_KEYS, SPENDS_BALANCE_KEYS, OWNER_ONLY_NAMES, NONE, reloadNote } from './shared.js';
import { defineOp, perEnv, invalid } from './registry.js';

const handlers = perEnv((env) => {
  const { writeLocalPath, localOrLive } = env;

  /** `key` is grantable when it is `*`, a known subcommand-group name, or a known
   * `<group>.<name>`/bare top-level command key (src/discord/commands.js#commandKeys). */
  function isKnownAccessKey(key) {
    if (key === '*') return true;
    const { keys, groups } = commandKeys();
    return keys.has(key) || groups.has(key);
  }

  /** The command keys a grant of `key` opens: every one for `*`, a group's commands for a group,
   * else the key itself -- owner-only ones never (src/discord/access.js#isOwnerOnly), nor the
   * member commands, open without a grant (src/discord/access.js#isMemberCommand). */
  function keysOpenedBy(key) {
    const { keys, groups } = commandKeys();
    let opened = [key];
    if (key === '*') opened = [...keys];
    else if (groups.has(key)) opened = [...keys].filter((full) => full.startsWith(`${key}.`));
    return opened.filter((full) => !isOwnerOnly(full) && !isMemberCommand(full));
  }

  /** `bot.access` as of the last write (`localOrLive`): config.local.json already holds the whole
   * merged object the moment one grant/revoke writes it (see `writeAccess`), so reading it back
   * first keeps repeated grant/revoke/list calls consistent even a moment before the next reload
   * lands. Falls back to `hot.config.bot.access` (the base config.json default, `{}`) before
   * anything has ever been written locally. */
  function effectiveAccess() {
    return localOrLive('bot.access') ?? {};
  }

  /** Writes `nextAccess` to `bot.access` in config.local.json and reloads config -- the same
   * mechanism cmdSet uses; the reload's outcome. */
  function writeAccess(nextAccess) {
    return writeLocalPath('bot.access', nextAccess);
  }

  /** `{ what, label }` for whichever one target option (or neither) was given: `what` is the
   * argument of src/discord/access.js#grant/#revoke/#hasGrant, `label` reads `role id:<id>`,
   * `user id:<id>` or `everyone` (plain text: a multi-line reply is code-fenced, where a mention
   * would show as raw markup). */
  function accessTargetArgs(args) {
    const roleId = args?.roleId;
    const userId = args?.userId;
    if (roleId && userId) throw invalid('give a role or a user, not both');
    if (roleId) return { what: { roleId: String(roleId) }, label: `role id:${roleId}` };
    if (userId) return { what: { userId: String(userId) }, label: `user id:${userId}` };
    return { what: { everyone: true }, label: 'everyone' };
  }

  function cmdAccessGrant(args) {
    const key = String(args?.command ?? '').trim();
    if (!key) throw invalid('a command key is required');
    if (isMemberCommand(key)) throw invalid(`${key} is open to every member and cannot be granted`);
    if (!isKnownAccessKey(key)) throw invalid(`unknown command key: ${key}`);
    if (isOwnerOnly(key)) {
      const group = key.split('.')[0];
      throw invalid(`${OWNER_ONLY_NAMES[key] ?? OWNER_ONLY_NAMES[group] ?? group} is owner-only and cannot be granted: ${key}`);
    }

    const target = accessTargetArgs(args);
    const ok = writeAccess(accessGrant(effectiveAccess(), key, target.what));

    const opened = keysOpenedBy(key);
    const notes = [];
    if (opened.some((full) => !READ_ONLY_ACCESS_KEYS.has(full))) notes.push('Note: this opens commands that change memory or config.');
    if (opened.some((full) => SPENDS_BALANCE_KEYS.has(full))) {
      notes.push('Note: this opens ping, whose every call spends OpenRouter balance outside llm.maxRequestsPerDay.');
    }
    return [`Granted ${key} to ${target.label} ${reloadNote(ok)}`, ...notes].join('\n');
  }

  function cmdAccessRevoke(args) {
    const key = String(args?.command ?? '').trim();
    if (!key) throw invalid('a command key is required');
    if (!isKnownAccessKey(key)) throw invalid(`unknown command key: ${key}`);

    const target = accessTargetArgs(args);
    const currentAccess = effectiveAccess();
    if (!hasGrant(currentAccess, key, target.what)) return 'Nothing to revoke';

    const ok = writeAccess(accessRevoke(currentAccess, key, target.what));
    return `Revoked ${key} from ${target.label} ${reloadNote(ok)}`;
  }

  /** Every grant, one line each (`everyone`, `role id:<id>`, `user id:<id>`); a stale grant on an
   * owner-only command (it opens nothing, see src/discord/access.js#isOwnerOnly) is left out. */
  function cmdAccessList() {
    const access = effectiveAccess();
    const keys = Object.keys(access).filter((key) => !isOwnerOnly(key));
    if (keys.length === 0) return NONE;

    return keys
      .map((key) => {
        const entry = access[key];
        const parts = [];
        if (entry?.everyone === true) parts.push('everyone');
        if (Array.isArray(entry?.roles)) parts.push(...entry.roles.map((id) => `role id:${id}`));
        if (Array.isArray(entry?.users)) parts.push(...entry.users.map((id) => `user id:${id}`));
        return `${key}: ${parts.join(', ')}`;
      })
      .join('\n');
  }

  return { isKnownAccessKey, keysOpenedBy, effectiveAccess, writeAccess, accessTargetArgs, cmdAccessGrant, cmdAccessRevoke, cmdAccessList };
});

defineOp({
  name: 'access.grant',
  rights: { kind: 'write', ownerOnly: true },
  run: (args, ctx) => handlers(ctx.env).cmdAccessGrant(args),
});
defineOp({
  name: 'access.revoke',
  rights: { kind: 'write', ownerOnly: true },
  run: (args, ctx) => handlers(ctx.env).cmdAccessRevoke(args),
});
defineOp({
  name: 'access.list',
  rights: { kind: 'read', ownerOnly: true },
  run: (args, ctx) => handlers(ctx.env).cmdAccessList(),
});
