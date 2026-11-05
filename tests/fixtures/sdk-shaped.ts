// The Discord adapter's message functions over the tests' stand-ins, which name their channel `placeId`: the adapter reads
// the SDK's own words (`channelId`), so a stand-in is given them before it goes in.
export * from '../../interfaces/discord/collect.ts';
import { normalizeMessage as normalize, toEvent as event } from '../../interfaces/discord/collect.ts';
import { sdkMessage } from './turn-world.ts';

export const toEvent: typeof event = (message, ...rest) => event(sdkMessage(message), ...rest);
export const normalizeMessage: typeof normalize = (message, ...rest) => normalize(sdkMessage(message), ...rest);
