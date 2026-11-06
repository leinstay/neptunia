// The owner's run that brings the stored media descriptions to the English standard (docs/prompt-contract.md). A current
// description whose letters outside quotes are mostly of another script (src/memory/text-standard.ts) is described again
// in English when its media can still be read, and otherwise translated from its own text, through the describing role
// of its kind. The result is a new version of the same description, written through the one writer as a `media-english`
// update (`applyMediaEnglish`), and the item's text form follows it. Older versions stay as they are, and the run counts
// the off-script ones among them as `superseded`.
//
// A transcript, a text file's opening and a second look's answer are quoted speech or an answer, outside the standard:
// they are counted as `quoted` and left alone. A run is idempotent, because a fixed description is English. A dry run
// lists and counts with no fetch, no model call and no write. Nothing here knows a platform: `mediaEnglishDesk` wires the
// ports over the running core, the interface's history reads and a describer that keeps nothing.

import {
  collectAudio,
  collectEmojiItems,
  collectPictures,
  collectTextFiles,
  collectVideos,
} from '../../media/classify.ts';
import { fillPromptTemplate } from '../../behavior/prompt.ts';
import { roleRequestOptions } from '../../llm/openrouter.ts';
import { roleModel, roleOn } from '../../llm/roles.ts';
import { clampText, oneLine } from '../clamp.ts';
import { DESCRIPTION_CHARS, VIDEO_SUMMARY_CHARS, createDescriber } from '../describe.ts';
import { isOffScript } from '../text-standard.ts';
import { selfreflectionPlanFillDesk } from './selfreflection-plan-fill.ts';
import { projectRow } from './graph.ts';
import { conversationOf, historyReader, isRefusal, mediaBackfillDesk, messageIdOf } from './media-backfill.ts';
import { cacheKeyParts, mediaRowOfCacheKey, tellFromCacheKey } from './media-store.ts';
import { unitById } from './storage-units.ts';
import { asText, dbOf, transactionOf } from './types.ts';
import type { HistoryReads, Pending } from './media-backfill.ts';
import type { Connection, Db, Row } from './types.ts';
import type { MediaItem } from '../describe.ts';

/** One current description the run looks at. */
export type EnglishItem = {
  /** The storage unit of its versions. */
  ownerKey: string;
  descriptionId: string;
  /** The version that is current when the run lists it: a write that finds another one changes nothing. */
  versionId: string;
  /** The item's row, null when no row holds its key. */
  mediaId: string | null;
  kind: string;
  nativeRef: string | null;
  /** The describer's cache key: the item's reference, or one with a prefix such as `video:`. */
  cacheKey: string;
  iface: string | null;
  /** The place whose describer cache holds the key, when its unit names one. */
  placeId: string | null;
  text: string;
};

/** What a fetch of an item's media found: the item as the describer reads it, or that it cannot be read any more. */
export type Fetched = { readable: true; media: unknown } | { readable: false };

/** What a run came to. */
export type EnglishReport = {
  /** Current descriptions off script, the ones a run works on. */
  toFix: number;
  redescribed: number;
  translated: number;
  /** Current descriptions already English. */
  unchanged: number;
  failed: number;
  /** Older versions off script, kept as history. */
  superseded: number;
  /** Transcripts, text files and answers, outside the standard. */
  quoted: number;
};

type Ports = {
  /** Throws for a read that may work later, which counts the item failed for the next run. */
  fetchMedia: (item: EnglishItem) => Promise<Fetched>;
  redescribe: (item: EnglishItem, media: unknown) => Promise<string | null>;
  translate: (item: EnglishItem) => Promise<string | null>;
  write: (update: Row) => Promise<unknown>;
};

/** The kinds whose text form is quoted speech or a file's own words. */
const QUOTED_KINDS = new Set(['voice', 'audio', 'text']);
/** A second look's answer: `<prefix>:<item id>:q:<hash>` (src/memory/describe.ts). */
const ANSWER_KEY = /:q:[a-f0-9]+$/;

/** The place a versions unit belongs to, as the describer named it. */
function placeOfUnit(db: Db, ownerKey: string): string | null {
  const subject = unitById(db, ownerKey)?.key.subject;
  return subject?.type === 'place' ? subject.id : null;
}

/** The current media descriptions, each with its item, oldest first. */
function listItems(db: Db): Array<EnglishItem> {
  const rows = db
    .prepare(
      `SELECT d.id AS description_id, d.owner_key AS owner_key, d.subject_id AS subject_id, d.scope_iface AS iface,
         d.current_version AS version_id, v.text AS text
       FROM descriptions d JOIN description_versions v ON v.id = d.current_version
       WHERE d.subject_kind = 'media' AND d.retired_at IS NULL AND v.retired_at IS NULL
       ORDER BY d.rowid`
    )
    .all();
  return rows.map((row) => {
    const cacheKey = asText(row.subject_id ?? '');
    const iface = typeof row.iface === 'string' ? row.iface : null;
    const media = cacheKey ? mediaRowOfCacheKey(db, iface, cacheKey) : undefined;
    const ownerKey = asText(row.owner_key ?? '');
    return {
      ownerKey,
      descriptionId: asText(row.description_id),
      versionId: asText(row.version_id),
      mediaId: media ? asText(media.id) : null,
      kind: asText(media?.kind ?? cacheKeyParts(cacheKey).kinds?.[0] ?? 'image'),
      nativeRef: typeof media?.native_ref === 'string' ? media.native_ref : null,
      cacheKey,
      iface,
      placeId: ownerKey ? placeOfUnit(db, ownerKey) : null,
      text: asText(row.text ?? ''),
    };
  });
}

/** The older versions off script, by description. */
function supersededCounts(db: Db): Map<string, number> {
  const counts = new Map<string, number>();
  const rows = db
    .prepare(
      `SELECT v.description_id AS description_id, v.text AS text
       FROM description_versions v JOIN descriptions d ON d.id = v.description_id
       WHERE d.subject_kind = 'media' AND d.retired_at IS NULL AND v.retired_at IS NULL AND v.id <> d.current_version`
    )
    .all();
  for (const row of rows) {
    if (!isOffScript(asText(row.text ?? ''))) continue;
    const id = asText(row.description_id);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/** The new English text of one item, and how it came: `null` text when nothing usable came back. */
async function englishOf(
  item: EnglishItem,
  ports: Ports
): Promise<{ text: string | null; how: 'redescribed' | 'translated' }> {
  const fetched = await ports.fetchMedia(item);
  if (fetched.readable) return { text: await ports.redescribe(item, fetched.media), how: 'redescribed' };
  return { text: await ports.translate(item), how: 'translated' };
}

/** The run: see the head of this file. */
export async function bringMediaToEnglish({
  db,
  now,
  dryRun = false,
  ...ports
}: Ports & { db: Db; now: number; dryRun?: boolean }): Promise<EnglishReport> {
  const report: EnglishReport = {
    toFix: 0,
    redescribed: 0,
    translated: 0,
    unchanged: 0,
    failed: 0,
    superseded: 0,
    quoted: 0,
  };
  const older = supersededCounts(db);
  const toFix: Array<EnglishItem> = [];
  for (const item of listItems(db)) {
    if (QUOTED_KINDS.has(item.kind) || ANSWER_KEY.test(item.cacheKey)) {
      report.quoted += 1;
      continue;
    }
    report.superseded += older.get(item.descriptionId) ?? 0;
    if (isOffScript(item.text)) toFix.push(item);
    else report.unchanged += 1;
  }
  report.toFix = toFix.length;
  if (dryRun) return report;
  for (const item of toFix) {
    try {
      const { text, how } = await englishOf(item, ports);
      if (!text || isOffScript(text)) {
        report.failed += 1;
        continue;
      }
      const update = {
        descriptionId: item.descriptionId,
        replaces: item.versionId,
        text,
        how,
        at: now,
        placeId: item.placeId,
        cacheKey: item.cacheKey,
      };
      const done = (await ports.write(update)) as { written?: number } | undefined;
      if (done?.written === 0) report.failed += 1;
      else report[how] += 1;
    } catch {
      report.failed += 1;
    }
  }
  return report;
}

/**
 * One English text on the writer's connection: a new `media` version of the description, made current, and the item's text
 * form, whose old vector goes. A description whose current version is no longer the one the run read changes nothing.
 */
export function applyMediaEnglish(connection: Connection, update: Row): { written: number } {
  const db = dbOf(connection);
  return transactionOf(connection)(() => {
    const description = db
      .prepare(
        'SELECT id, owner_key, subject_id, scope_iface, current_version FROM descriptions WHERE id = ? AND retired_at IS NULL'
      )
      .get(update.descriptionId);
    if (!description || description.current_version !== update.replaces) return { written: 0 };
    const text = asText(update.text);
    const at = Number(update.at);
    const written = new Date(at).toISOString();
    const position = Number(
      db
        .prepare('SELECT COALESCE(MAX(position), 0) + 1 AS position FROM description_versions WHERE owner_key = ?')
        .get(description.owner_key)?.position
    );
    const id = `${asText(description.id)}:english-${position}`;
    const entry = { text, ts: at, describedAt: at, english: update.how };
    db.prepare(
      `INSERT INTO description_versions (id, description_id, text, written_at, chars, origin, extra, owner_key, position)
       VALUES (?, ?, ?, ?, ?, 'media', ?, ?, ?)`
    ).run(
      id,
      description.id,
      text,
      written,
      [...text].length,
      JSON.stringify({ entry }),
      description.owner_key,
      position
    );
    db.prepare('UPDATE descriptions SET current_version = ? WHERE id = ?').run(id, description.id);
    projectRow(db, 'description_versions', { description_id: description.id }, { at: written });
    const iface = typeof description.scope_iface === 'string' ? description.scope_iface : null;
    tellFromCacheKey(db, { iface, key: asText(description.subject_id), text, at });
    return { written: 1 };
  });
}

/** What a run looks like from the owner's command. */
export type EnglishDeskState = {
  state: 'idle' | 'running' | 'done' | 'failed';
  report: EnglishReport | null;
  code?: string;
};

/**
 * The owner's command over a run: one at a time, in the background, its last counts held for `status`. A dry run answers at
 * once. A run asked while one goes answers that one's state.
 */
export function createEnglishDesk({
  database,
  now,
  log,
  ...ports
}: Ports & {
  database: () => Db | null;
  now: () => number;
  log: { warn(message: string, fields?: Row): void };
}): { start(options: { dryRun: boolean }): Promise<EnglishDeskState>; status(): EnglishDeskState } {
  let current: EnglishDeskState = { state: 'idle', report: null };
  return {
    status: () => current,
    async start({ dryRun }) {
      const db = database();
      if (db === null) return { state: 'failed', report: null, code: 'DB_CLOSED' };
      const run = (dry: boolean): Promise<EnglishReport> =>
        bringMediaToEnglish({
          db,
          ...ports,
          write: (update) => ports.write({ kind: 'media-english', ...update }),
          now: now(),
          dryRun: dry,
        });
      if (dryRun) return { state: 'done', report: await run(true) };
      if (current.state === 'running') return current;
      current = { state: 'running', report: null };
      run(false)
        .then((report) => {
          current = { state: 'done', report };
        })
        .catch((error: unknown) => {
          const code = (error as { code?: string } | null)?.code ?? 'FAILED';
          log.warn('memory db: media english failed', { code });
          current = { state: 'failed', report: null, code };
        });
      return current;
    },
  };
}

// ---------- the ports over the running core ----------

/** A describer cache entry, as the store holds it. */
type CacheEntry = Record<string, unknown>;

/** A store for a describer that keeps nothing: every lookup misses and nothing is written, so only the run writes. */
function detachedMediaStore<TState>(state: TState): {
  getMediaCache(): CacheEntry;
  markMediaCacheDirty(): void;
  state: TState;
} {
  return { getMediaCache: () => ({}), markMediaCacheDirty: () => undefined, state };
}

/** A video summary's key: `video:<item id>`, where a video-site link's thumbnail is `video:url:<hash>`. */
const isSummaryKey = (key: string): boolean => key.startsWith('video:') && !key.startsWith('video:url:');

/** The describing role of an item's kind, as src/memory/describe.ts picks it. */
const roleOf = (item: EnglishItem): 'video' | 'vision' =>
  item.kind === 'gif' || item.kind === 'video' || isSummaryKey(item.cacheKey) ? 'video' : 'vision';

/** The lines that link a media row, newest first, with what a read of their message needs. */
function linesOf(db: Db, mediaId: string): Array<Pending> {
  return db
    .prepare(
      `SELECT s.id AS id, s.native_id AS native_id, s.place_id AS place_id, s.extra AS extra, s.scope_kind AS scope_kind,
         p.extra AS place_extra
       FROM media_links l JOIN sources s ON s.id = l.owner_id LEFT JOIN places p ON p.id = s.place_id
       WHERE l.owner_kind = 'source' AND l.media_id = ? AND s.retired_at IS NULL
       ORDER BY s.occurred_at DESC, s.rowid DESC`
    )
    .all(mediaId) as Array<Pending>;
}

/** The item of a message that a cache key names: a picture, an emoji, a sound, a text file or a video. */
function itemIn(message: Row, cacheKey: string, videoSites: ReadonlyArray<string>): Row | null {
  const pictures = [
    ...collectPictures(message),
    ...collectEmojiItems(message),
    ...collectAudio(message),
    ...collectTextFiles(message),
  ] as Array<Row>;
  const picture = pictures.find((item) => item.itemId === cacheKey);
  if (picture) return picture;
  return (
    (collectVideos(message, { videoSites }) as Array<Row>).find(
      (item) => `video:${asText(item.itemId)}` === cacheKey
    ) ?? null
  );
}

type Llm = { complete(messages: Array<Row>, options: Row): Promise<unknown> };

/**
 * The run over the running core. `fetchMedia` reads a linking line's message through the interface's history, as the
 * media backfill reads it, and finds the item there by its cache key. `redescribe` asks a describer built from the core's
 * `describerDeps` over `detachedMediaStore`, so the core's cache and versions are never touched. `translate` asks the same
 * role through `describe-translate`. After a write the core's cache of the place takes the new text, so a later flush of
 * that cache keeps it.
 */
function mediaEnglishDesk({
  memoryDb,
  reads,
  iface,
  describerDeps,
  now,
  log,
}: {
  memoryDb: { database(): unknown; memoryWrite(update: unknown): Promise<unknown> };
  reads: HistoryReads;
  iface: () => string;
  describerDeps: Parameters<typeof createDescriber>[0];
  now: () => number;
  log: { warn(message: string, fields?: Row): void };
}): ReturnType<typeof createEnglishDesk> {
  const { store } = describerDeps;
  const describer = createDescriber({ ...describerDeps, store: detachedMediaStore(store.state) });
  // The settings and prompts in force, read at each use.
  const config = (): Row => describerDeps.hot.config as Row;
  const media = (): Row => (config().media ?? {}) as Row;
  const llm = describerDeps.llm as Llm;
  const read = historyReader(reads, iface);
  const videoSites = (): ReadonlyArray<string> => {
    const sites: unknown = media().video;
    const list = (sites as Row | undefined)?.sites;
    return Array.isArray(list) ? (list as Array<string>) : [];
  };
  const fetchMedia = async (item: EnglishItem): Promise<Fetched> => {
    const db = memoryDb.database() as Db | null;
    if (db === null || item.mediaId === null) return { readable: false };
    for (const line of linesOf(db, item.mediaId)) {
      const conversationId = conversationOf(line);
      if (conversationId === null) continue;
      const messageId = messageIdOf(line);
      const page = await read(conversationId, { around: messageId, limit: 1 });
      if (page.status !== 'ok') {
        if (isRefusal(page)) continue;
        throw Object.assign(new Error('history read failed'), { code: page.code ?? 'READ_FAILED' });
      }
      const event = (page.events ?? []).find((one) => asText((one.message as Row).id) === messageId);
      const found = event ? itemIn(event.message as Row, item.cacheKey, videoSites()) : null;
      if (found) return { readable: true, media: found };
    }
    return { readable: false };
  };
  const redescribe = async (item: EnglishItem, media: unknown): Promise<string | null> => {
    const placeId = item.placeId ?? item.ownerKey;
    if (isSummaryKey(item.cacheKey)) {
      const watched = await describer.describeVideo(placeId, media as MediaItem, { force: true });
      return watched?.state === 'watched' ? watched.text : null;
    }
    return (await describer.describe(placeId, media as MediaItem))?.text ?? null;
  };
  const translate = async (item: EnglishItem): Promise<string | null> => {
    const prompt: unknown = (describerDeps.hot.prompts as Row | null | undefined)?.['describe-translate'];
    const role = roleOf(item);
    if (typeof prompt !== 'string' || prompt === '' || !roleOn(config(), role)) return null;
    const maxChars = isSummaryKey(item.cacheKey) ? VIDEO_SUMMARY_CHARS : DESCRIPTION_CHARS;
    const answer = (await llm.complete(
      [
        { role: 'system', content: fillPromptTemplate(prompt, { maxChars }) },
        { role: 'user', content: item.text },
      ],
      {
        model: roleModel(config(), role, 'describe-translate'),
        ...roleRequestOptions(config(), {
          role,
          maxOutputTokens: media().maxOutputTokens as number | undefined,
          purpose: 'describe-translate',
        }),
      }
    )) as { text?: unknown } | null;
    const text = clampText(oneLine(answer?.text ?? ''), maxChars, { tolerance: 1 });
    return text === '' ? null : text;
  };
  const write = async (update: Row): Promise<unknown> => {
    const done = await memoryDb.memoryWrite(update);
    const { placeId, cacheKey } = update;
    if ((done as { written?: number } | null)?.written === 1 && typeof placeId === 'string') {
      const cache = store.getMediaCache(placeId);
      const entry: unknown = cache[asText(cacheKey)];
      if (entry && typeof entry === 'object') cache[asText(cacheKey)] = { ...(entry as Row), text: update.text };
    }
    return done;
  };
  return createEnglishDesk({
    database: () => memoryDb.database() as Db | null,
    fetchMedia,
    redescribe,
    translate,
    write,
    now,
    log,
  });
}

/**
 * The owner's runs over the running core: the media backfill on the core's describer, the English run, and the plan fill
 * of old selfreflection entries (selfreflection-plan-fill.ts) on the describer's client and settings.
 */
export function ownerMemoryRuns({
  describer,
  ...core
}: Parameters<typeof mediaEnglishDesk>[0] & Pick<Parameters<typeof mediaBackfillDesk>[0], 'describer'>): {
  mediaBackfill: ReturnType<typeof mediaBackfillDesk>;
  mediaEnglish: ReturnType<typeof mediaEnglishDesk>;
  planFill: ReturnType<typeof selfreflectionPlanFillDesk>;
} {
  const { memoryDb, reads, iface, describerDeps, now, log } = core;
  const { llm, hot } = describerDeps as Pick<Parameters<typeof selfreflectionPlanFillDesk>[0], 'llm' | 'hot'>;
  return {
    mediaBackfill: mediaBackfillDesk({ memoryDb, reads, iface, describer, now, log }),
    mediaEnglish: mediaEnglishDesk(core),
    planFill: selfreflectionPlanFillDesk({ memoryDb, llm, hot, now, log }),
  };
}
