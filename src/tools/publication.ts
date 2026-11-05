// Trusted publication restrictions for a turn's adapter and publishing operations.
import type { ConversationRef, Delivery } from '../protocol/adapter.ts';
import { isIssuedInternalContext } from '../memory/db/scope.ts';
import { locatorText } from '../memory/db/message-locator.ts';
import { objOf } from './types.ts';

export type PublicationBoundary = Readonly<{
  kind: 'internal-turn';
  origin: Readonly<ConversationRef>;
}>;
export type PublicationRefusal = Readonly<{
  status: 'denied';
  code: 'not-allowed';
  reason: 'publication-boundary';
}>;

/** Who may read a selfreflection entry, as she chose it: a post's `publicationAudience`. */
export type PublicationAudience = Readonly<
  { kind: 'unrestricted' } | { kind: 'interface'; iface: string } | { kind: 'place'; placeId: string }
>;
/** What a post's audience comes to when she named no valid one. */
export type AudienceProblem = 'audience-unknown-place' | 'audience-unknown-interface' | 'audience-malformed';
/** What her `<audience>` tags come to: an audience, or the concrete reason none could be read. */
export type AudienceChoice = { ok: true; audience: PublicationAudience } | { ok: false; code: AudienceProblem };
/** The places she can name in `<audience>` (src/memory/db/selfreflection-audience.ts#publicationPlaces). */
export type KnownPlaces = Readonly<{
  interfaces: ReadonlyArray<string>;
  places: ReadonlyArray<Readonly<{ id: string; name: string | null; parentId: string | null }>>;
}>;

export const UNRESTRICTED: PublicationAudience = { kind: 'unrestricted' };

/** A stored `publicationAudience` that can be acted on. Anything else, a recorded failure included, publishes nowhere. */
export function isPublicationAudience(value: unknown): value is PublicationAudience {
  const audience = objOf(value);
  if (audience.kind === 'unrestricted') return true;
  if (audience.kind === 'interface') return typeof audience.iface === 'string' && audience.iface !== '';
  return audience.kind === 'place' && typeof audience.placeId === 'string' && audience.placeId !== '';
}

/**
 * The audience the bodies of her `<audience>` tags name, over the places she can name. No tag is an unrestricted entry;
 * two different values are malformed, since either could be the narrower thing she meant. Pure.
 */
export function audienceChoice(words: ReadonlyArray<string>, known: KnownPlaces): AudienceChoice {
  const said = [...new Set(words.map((word) => word.trim()))];
  const [word] = said;
  if (word === undefined) return { ok: true, audience: UNRESTRICTED };
  if (said.length > 1) return { ok: false, code: 'audience-malformed' };
  if (word === 'unrestricted') return { ok: true, audience: UNRESTRICTED };
  const named = /^(interface|place):(\S+)$/.exec(word);
  const value = named?.[2];
  if (value === undefined) return { ok: false, code: 'audience-malformed' };
  if (named?.[1] === 'interface')
    return known.interfaces.includes(value)
      ? { ok: true, audience: { kind: 'interface', iface: value } }
      : { ok: false, code: 'audience-unknown-interface' };
  return known.places.some((place) => place.id === value)
    ? { ok: true, audience: { kind: 'place', placeId: value } }
    : { ok: false, code: 'audience-unknown-place' };
}

/**
 * Why a stored `publicationAudience` publishes nowhere and whether she has heard of it, or null when it stands: no
 * audience at all (an old row) or a readable one.
 */
export function refusedAudience(stored: unknown): { reason: string; told: boolean } | null {
  if (stored === undefined || isPublicationAudience(stored)) return null;
  const value = objOf(stored);
  return { reason: typeof value.code === 'string' ? value.code : 'audience-malformed', told: value.told === true };
}

export function isPublicationBoundary(value: unknown): value is PublicationBoundary {
  const boundary = objOf(value);
  const origin = objOf(boundary.origin);
  return boundary.kind === 'internal-turn' && locatorText(origin.iface) && locatorText(origin.conversationId);
}

export function publicationBoundaryOf(context: unknown, origin: ConversationRef): PublicationBoundary | undefined {
  if (!isIssuedInternalContext(context) || !locatorText(objOf(context).id)) return undefined;
  return { kind: 'internal-turn', origin: { ...origin } };
}

/**
 * The restriction of a turn: the one it inherited from deferred work (a finished errand, a due intention), else the one
 * its own internal context gives. An inherited label is a restriction, never a grant of memory authority.
 */
export function turnBoundary(
  draft: { publicationBoundary?: unknown; memoryContext?: unknown } | null | undefined,
  origin: ConversationRef
): PublicationBoundary | undefined {
  if (isPublicationBoundary(draft?.publicationBoundary)) return draft.publicationBoundary;
  return publicationBoundaryOf(draft?.memoryContext, origin);
}

export function publicationRefusal(
  boundary: PublicationBoundary | null | undefined,
  destination: ConversationRef
): PublicationRefusal | null {
  if (boundary == null) return null;
  if (
    isPublicationBoundary(boundary) &&
    boundary.origin.iface === destination.iface &&
    boundary.origin.conversationId === destination.conversationId
  )
    return null;
  return { status: 'denied', code: 'not-allowed', reason: 'publication-boundary' };
}

export function refusedPublication(idempotencyKey = ''): Delivery {
  return {
    status: 'failed',
    ref: null,
    parts: [],
    at: null,
    idempotencyKey,
    error: { code: 'not-allowed', retryable: false, retryAfterMs: null },
  };
}

export function bindPublicationPort<TPort extends object>(
  port: TPort,
  boundary: PublicationBoundary | null | undefined
): TPort {
  if (boundary == null) return port;
  return new Proxy(port, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      return (...args: Array<unknown>): unknown => {
        if (property === 'send' || property === 'edit' || property === 'react') {
          const ref = objOf(args[0]);
          if (
            publicationRefusal(boundary, {
              iface: typeof ref.iface === 'string' ? ref.iface : '',
              conversationId: typeof ref.conversationId === 'string' ? ref.conversationId : '',
            })
          )
            return Promise.resolve(refusedPublication());
        }
        // The callable guard permits invocation while its result remains unknown.
        return Reflect.apply(value, target, args) as unknown;
      };
    },
  });
}

/** Persisted selfreflection metadata fails closed when its JSON cannot be read. */
export function selfreflectionMetadataOf(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  try {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return objOf(parsed);
  } catch {
    // Unreadable metadata cannot establish the absence of a restriction.
  }
  return { publicationBoundary: null };
}

export function selfreflectionRestricted(post: unknown): boolean {
  return objOf(post).publicationBoundary !== undefined;
}

export function selfreflectionPublicationRefusal(
  value: unknown,
  destination: ConversationRef
): PublicationRefusal | null {
  if (value === undefined) return null;
  if (isPublicationBoundary(value)) return publicationRefusal(value, destination);
  return { status: 'denied', code: 'not-allowed', reason: 'publication-boundary' };
}
