# Diary

The diary turns selected experience into a dated entry, with an optional illustration and publication. It is part of the persona's memory and travels with its `data/` directory.

An entry records its text and media references in the database. Original diary media lives under `data/media/`. Copying only the database leaves these references without their files. [Backup and restore](persona-migration.md#backup-and-restore) includes both.

The diary's group-memory context excludes DMs and internal material. A mirror is a publication destination, not another copy of the persona's memory.

## Mirrors

The diary is one persona collection (`store.getDiary`, `store.setDiaryPosts`), and an entry needs no server: `createDiary` takes none, and a turn of an entry names none. A mirror is one known place that receives her diary entries, and there may be none or many. The owner manages them with `/mirror` ([commands](cli.md#mirrors)), and `src/behavior/mirror-desk.ts` writes every change through the memory writer (kind `mirror`, `src/memory/db/mirror-config.ts`). Every destination is an interface-qualified place id, or a bare native id that one place alone holds. Two interfaces sharing the native id make it `ambiguous-place`, and a community or a private conversation is `unknown-place`. An interface that is not connected delays delivery and changes no configuration.

Configuration and delivery history live apart. `/mirror remove` marks the `mirrors` row and keeps its `publications` rows, so adding the same destination again reuses the row and sends nothing already delivered. `/mirror disable` keeps everything and holds what is queued until the mirror is enabled again. A repeated add answers the same mirror.

## Delivery

`createMirrors` in `src/behavior/mirror.ts` gives each entry one `publications` row per enabled mirror its [audience](#audience) allows, keyed `diary:<entry id>:<place id>`. The publisher claims the row through the writer before anything reaches the interface, so the timer's drain, the reconnect's drain and the turn's own publish send it once between them. A claim holds a claimant and a time (`src/memory/db/publication-delivery.ts`).

| Status | Meaning |
|---|---|
| `queued` | Waiting for its interface or its turn. |
| `sending` | Claimed by a publisher. |
| `sent` | Delivered, with its receipts, or recorded as published by the owner. |
| `failed` | The interface refused it, with its code and whether a retry can help. |
| `incomplete` | A media file is missing, so nothing was posted (code `media-missing`). |
| `unknown` | Nobody knows what reached the platform. `/mirror status` calls it `uncertain`. |

An entry goes out as segments: the voice message, each of her messages, then each message of pictures. Each segment has its own idempotency key, stable across retries, and its receipt is written as soon as the segment is out. A retry resumes at the segment that stopped, under the same key. Receipts name messages and attachments per entry, destination and segment, and a remote message count never stands in for one, since one entry can be several messages and a post can be deleted.

A drain runs on the scheduler's 30-second tick and when an interface connects. One mirror's failure stops none of the others, and an old failure holds back no new entry.

A retryable failure goes out again at the next drain, while a certain refusal stays `failed` and costs no further sends. A missing file holds the whole entry until the file is back, and the next drain then sends it whole. An entry stored after a mirror's registration with no publication there was lost between its storing and its publish, for instance to a crash, and the next drain queues it as a new entry.

### Uncertain sends

A send that answers `unknown`, throws, or runs past `mirrors.sendTimeoutMs` is uncertain, and so is a claim that outlives `mirrors.claimLeaseMs` with no word from its publisher. The later segments stay pending and nothing is sent again without proof. Three things settle it. A receipt that arrives late is kept. An adapter that declares `capabilities().reconcile` looks the segment up by its key, which either finds it (`sent`) or proves it absent (it goes out once more), and a lookup that fails leaves it uncertain. The owner settles what no adapter can: `/mirror reconcile --entries` records it as published, and `/mirror reconcile --absent --entries` says it never arrived and queues it again, with the owner's name kept on the row.

Exactly-once delivery holds only as far as the platform can prove it. Between a platform's accepting a message and the core's writing its receipt, a crash leaves the send uncertain, and a platform with no lookup leaves that to the owner. A Discord interface finds only the sends of its current process, so a send from before its restart stays uncertain.

## Audience

The persona chooses who may read an entry. The writer request carries a `<publication_places>` block with one `interface:<iface>` token per interface and one `place:<place id>` token per known group place, followed by its name and indented under its parent. `publicationPlaces` in `src/memory/db/diary-audience.ts` reads the block's contents from memory, so they leave out private conversations and stay the same whichever mirrors exist. She answers with at most one `<audience>` tag, and `recordEntry` in `src/behavior/diary-turn.ts` stores the result on the post as `publicationAudience`, in the `extra` column of the `diary` row.

| Stored `publicationAudience` | Reaches |
|---|---|
| `{ kind: 'unrestricted' }` | Every mirror, mirrors added later included. Leaving the tag out records this. |
| `{ kind: 'interface', iface }` | Every mirror on that interface. |
| `{ kind: 'place', placeId }` | The place and its descendants through `parent_id`. |

Places compare by their interface-qualified id, so the same native id on two interfaces stays two places. An unknown or malformed value keeps the entry in memory and publishes it nowhere. The turn's `result.diary.audience` answers `{ ok: false, code }` with `audience-unknown-place`, `audience-unknown-interface` or `audience-malformed`, the post stores `{ kind: 'invalid', code }`, and each mirror's outcome is `failed` with `audience-invalid`. Two different values in one turn are malformed, and the tag counts from every answer of the turn.

A refusal reaches both people concerned. `/mirror status` lists the entry under each mirror as `blocked` with `audience-invalid` and the reason code (`audienceBlocked`) for as long as the post stores that value. Her next diary request carries an `<audience_refused>` block with the post and the reason. `markRefusalsTold` in `src/behavior/diary-turn.ts` marks the post `told` once the model answers that request, so a failed request tells her again and an answered one never does. An entry under a saved `publicationBoundary` shows only in a request whose diary history holds it.

`storedDiaryPublicationRefusal` in `src/memory/db/publish.ts` reads the stored row in four places: when the publisher queues, in the writer's `prepare`, in a backfill scan and right before a send. A mirror the entry leaves out gets no row, and its outcome is `failed` with `audience-excluded`. A row queued before a narrowing ends `failed` with the same code and sends nothing, and a backfill passes over such an entry without blocking the ones after it.

The audience only narrows the trusted restrictions. A saved `publicationBoundary` applies first, and an entry that is neither group material nor under a boundary reaches nothing, whatever it names. A row with no `publicationAudience` predates the choice and stays as it is. An old group entry goes only to its own `scope_iface`. An old entry with no interface, an internal scope or a private scope goes nowhere unless a saved boundary allows its origin.

No edit recalls a copy that already went out. `/mirror status` lists such an entry as delivered outside its audience (`deliveredOutsideAudience`), and `publicationState` answers `outsideAudience: true`, apart from the rows the audience stops.

## Backfill

Enabling backfill on a mirror captures a high-water mark, the newest entry at that moment, and makes the first old entry due at once. Each interval then sends the oldest eligible entry by persisted order (`at_ms`, `position`, `id`). After downtime one due entry goes out and the next is scheduled from the current time, so missed intervals never burst. Entries written later go out at once as new ones and move neither the mark nor the due time. Backfill turns itself off when nothing up to the mark is left, and at once when nothing is eligible.

Receipts, claims in flight and uncertain sends take an entry out of the scan. An old entry that fails or lacks a file blocks the later old entries of that mirror, shown as `blocked` in `/mirror status`, and is retried at the next slot. `/mirror reconcile` unblocks an entry that can never go out. Disabling a mirror or turning backfill off keeps the mark and the progress, and turning it on again continues from there. Before backfilling a channel that already holds old posts, record them with `/mirror reconcile --through <entry id>`: an old post with no entry mapping is no receipt.

The diary prompts supply the writing and drawing instructions. Personal replacements belong in `data/prompts/`; keep the placeholders expected by the [prompt contract](prompt-contract.md). Settings and their readers are listed in [configuration](configuration.md). Start implementation inspection in [src/behavior/diary.ts](../src/behavior/diary.ts) and [src/behavior/mirror.ts](../src/behavior/mirror.ts).
