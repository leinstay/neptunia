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

/** Persisted diary metadata fails closed when its JSON cannot be read. */
export function diaryMetadataOf(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  try {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return objOf(parsed);
  } catch {
    // Unreadable metadata cannot establish the absence of a restriction.
  }
  return { publicationBoundary: null };
}

export function diaryRestricted(post: unknown): boolean {
  return objOf(post).publicationBoundary !== undefined;
}

export function diaryPublicationRefusal(value: unknown, destination: ConversationRef): PublicationRefusal | null {
  if (value === undefined) return null;
  if (isPublicationBoundary(value)) return publicationRefusal(value, destination);
  return { status: 'denied', code: 'not-allowed', reason: 'publication-boundary' };
}
