// Recall and the family catalog share verified native routes retained by protocol and record observations.

import { fromRows as recordFromRows } from './map/record.ts';
import { locatorText, messageLocator } from './message-locator.ts';
import type { NativeMessageLocator } from './recall.ts';
import type { Row } from './types.ts';

/** Catalog record routes and historic provenance require the mapper's retained version and actual channel. */
export function nativeLocatorOf(row: Row, extra: Row): NativeMessageLocator | undefined {
  const marker = messageLocator(extra.$messageLocator, row.iface);
  if (marker) return { iface: marker.iface, chatId: marker.chatId, messageId: marker.messageId };
  if (Object.hasOwn(extra, '$messageLocator')) return undefined;
  if (
    (row.storage_kind !== 'record' &&
      !/^(?:[^/]+\/[^/]+\/)?(?:private\/[^/]+\/)?record\/\d{4}-\d{2}\/\d{4}-\d{2}-\d{2}\.jsonl$/.test(
        typeof row.owner_file === 'string' ? row.owner_file : ''
      )) ||
    extra.v !== 1 ||
    !locatorText(extra.id) ||
    (row.kind !== 'seen' && row.kind !== 'said') ||
    !locatorText(row.iface) ||
    row.iface.includes('/') ||
    !locatorText(row.native_id)
  )
    return undefined;
  const line = recordFromRows({ sources: [{ ...row }] });
  const scope = line.scope;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return undefined;
  const channel = (scope as Row).channel;
  return locatorText(channel) ? { iface: row.iface, chatId: channel, messageId: row.native_id } : undefined;
}
