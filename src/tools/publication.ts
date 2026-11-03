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
