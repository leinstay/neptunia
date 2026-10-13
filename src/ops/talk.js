// Operations: `/nep interject|initiate`: one spontaneous turn now.
// The handler bodies moved here from src/admin.js unchanged; each `run` calls one of them with
// the operation's `ctx` as the command context.

import { defineOp, perEnv, invalid } from './registry.js';

const handlers = perEnv((env) => {
  const { client, spontaneous, assertNotPaused } = env;

  /**
   * Shared handler for `/nep interject` and `/nep initiate`: force a
   * spontaneous turn right now, in `context.channelId` unless a channel
   * argument overrides it, bypassing the schedule.
   */
  async function cmdForce(mode, args, context) {
    assertNotPaused();
    const channelId = args?.channelId || context?.channelId;
    if (!channelId) throw invalid('a channel is required');

    const channel = await client.channels.fetch(channelId);
    if (!channel) throw invalid(`no channel ${channelId}`, 'not-found');

    const result = await spontaneous.force(channel, mode);
    return `${mode} on ${channel.id}: ${JSON.stringify(result) ?? 'ok'}`;
  }

  return { cmdForce };
});

defineOp({
  name: 'talk.interject',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdForce('interject', args, ctx),
});
defineOp({
  name: 'talk.initiate',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdForce('initiate', args, ctx),
});
