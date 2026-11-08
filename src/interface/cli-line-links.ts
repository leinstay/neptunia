// The link items of a line the owner types in the command line. The Discord interface makes a link item of every URL
// and a message reference of every message link before a line reaches the core. The command line sends its lines
// bare, so the core fills them in here: a message link becomes the reference the served interface reads it as
// (`parseLinks`), and every other URL becomes a link item. The media prefill and the turn then watch a video, read a
// page and number a linked message from them as they do for a Discord line. The core knows no address grammar: only
// the interface's read says which URL names a message.

import { siteOf } from '../media/classify.ts';
import { videoSiteFor, videoUrlCacheKey } from '../media/video-sites.ts';
import { URL_PATTERN } from '../memory/mentions.ts';
import type { MessageRef } from '../protocol/adapter.ts';
import type { Message, MessageReference } from '../protocol/events.ts';

/** The most URLs of one line that become items, as many as the embeds Discord shows under one message. */
const MAX_LINE_URLS = 10;
// A full stop, comma or closing bracket after a URL ends the sentence, not the address (src/media/video-sites.ts).
const TRAILING_PUNCTUATION = /[).,]+$/;

/** A line of the owner's chat as the command line sends it. */
export type LineMessage = Message;

/** What the link items need: the video sites (`media.video.sites`) and the served interface's read of message links. */
export type LineLinkDeps = {
  videoSites: ReadonlyArray<string>;
  parseLinks(texts: ReadonlyArray<string>): Promise<{ refs: Array<MessageRef | null> } | null>;
};

/** One link item, in the shape the Discord interface gives a URL typed in a message's text. */
type LinkItem = {
  id: string;
  kind: 'link';
  site: string;
  title: string;
  text: string;
  thumbnailUrl: null;
  url: string;
};

/** A URL of the text, and the span that writes it: with its angle brackets when both enclose it. */
type Written = { url: string; text: string };

/** The video sites of the settings (`media.video.sites`), the strings of the list alone. */
export function videoSitesOf(config: unknown): Array<string> {
  const media = (config as { media?: { video?: { sites?: unknown } } } | null)?.media;
  const sites = media?.video?.sites;
  return Array.isArray(sites) ? sites.filter((site): site is string => typeof site === 'string') : [];
}

/** The distinct URLs of `text` in the order they are written, at most MAX_LINE_URLS. */
function urlsOf(text: string): Array<Written> {
  const found: Array<Written> = [];
  for (const match of text.matchAll(new RegExp(URL_PATTERN, 'g'))) {
    const url = match[0].replace(TRAILING_PUNCTUATION, '');
    if (found.some((one) => one.url === url)) continue;
    const at = match.index;
    const bracketed = text[at - 1] === '<' && text[at + url.length] === '>';
    found.push({ url, text: bracketed ? `<${url}>` : url });
    if (found.length === MAX_LINE_URLS) break;
  }
  return found;
}

/** The link item of `url`: a video site's URL keyed by its video cache key, as the Discord interface keys it. */
function linkItem(messageId: string, url: string, index: number, videoSites: ReadonlyArray<string>): LinkItem {
  const id = videoSiteFor(url, videoSites) === null ? `${messageId}#l${index}` : videoUrlCacheKey(url);
  return { id, kind: 'link', site: siteOf(url), title: '', text: '', thumbnailUrl: null, url };
}

/** The interface's reading of `urls`, one entry each, all null when it reads no link or the read failed. */
async function refsOf(urls: ReadonlyArray<string>, deps: LineLinkDeps): Promise<Array<MessageRef | null>> {
  try {
    const parsed = await deps.parseLinks(urls);
    return urls.map((_url, index) => parsed?.refs[index] ?? null);
  } catch {
    return urls.map(() => null);
  }
}

/**
 * `message` with the link items and message references of the URLs in its text: a URL the interface reads as a
 * message becomes a `messageRefs` entry, every other URL a link item after the ones it already has. A line without a
 * URL comes back as it is, and the interface is not asked.
 */
export async function withLineLinks(message: LineMessage, deps: LineLinkDeps): Promise<LineMessage> {
  const written = urlsOf(message.content);
  if (written.length === 0) return message;
  const refs = await refsOf(
    written.map((one) => one.url),
    deps
  );
  const messageRefs: Array<MessageReference> = [];
  const links: Array<LinkItem> = [];
  written.forEach((one, index) => {
    const ref = refs[index] ?? null;
    if (ref === null) links.push(linkItem(message.id, one.url, links.length, deps.videoSites));
    else
      messageRefs.push({
        iface: ref.iface,
        chatId: ref.chatId,
        messageId: ref.messageId,
        url: one.url,
        text: one.text,
      });
  });
  return {
    ...message,
    links: [...message.links, ...links],
    ...(messageRefs.length === 0 ? {} : { messageRefs: [...(message.messageRefs ?? []), ...messageRefs] }),
  };
}
