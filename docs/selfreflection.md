# Selfreflection

Selfreflection turns selected experience into a dated entry, with an optional illustration and publication. It is part of the persona's memory and travels with its `data/` directory. The engine calls the mechanism `selfreflection` in its modules, settings, tables, purposes and request blocks. The text of its prompts and labels says she keeps a diary, the persona's own word for it.

An entry records its text and media references in the database. Original media lives under `data/media/selfreflection/`. Copying only the database leaves these references without their files, so a backup copies the whole `data/` folder.

The group-memory context of an entry excludes DMs and internal material. A mirror is a publication destination, not another copy of the persona's memory.

## Planner and writer

An entry takes two requests, both built on the [turn frame](prompt-contract.md#selfreflection-on-the-frame) and both nowhere. `postEntry` in `src/behavior/selfreflection.ts` starts a turn of the mode `selfreflection` with no chat, so the turn reads no chat history and journals its turn under herself. `turnContextOf` in `src/turn/inputs.ts` issues it the interface's `group` context, the audience of the mirrors the entry is copied to, so neither request reads an internal or private entry or memory. A turn issued an `internal` context instead stores its entry with scope `internal` and a `publicationBoundary`, and no mirror publishes it.

The planner goes first, on the `analyzer` role with the purpose `selfreflection-planner`, and writes the brief for the kind the code gives it. `prepareSelfreflection` in `src/turn/selfreflection.ts` draws the kind and the seeds. `plannerRequest` in `src/turn/phases/request/build.ts` then builds the request of the kind `selfreflection_plan`, with the persona as its system message and `prompts/selfreflection-planner.md` as its `<task>`. Its `<inner>` holds her past entries and what it chooses from: `<kinds>`, `<seeds>`, the owner's `<topic>` and the `<stored_facts>` of the days since her last entry. Its answer stays the JSON object the [prompt contract](prompt-contract.md) describes. The planner's `models.byPurpose` pin is `selfreflection-planner`.

The writer is the turn's own request, of the kind `selfreflection`, with `prompts/selfreflection.md` as its `<task>`. Its `<inner>` holds her past entries, then the `<plan>` as lines: the kind, the brief, the picture, the owner's topic and what the plan's search found. A set kind adds its `<seeds>`, two or more mirrors add the list to choose among, and `<feedback>` names the audiences she has not heard were refused.

Both requests carry what a turn with no place reads. Her last `context.memory.serviceMessages` (100) lines over the rooms of every group fill `<meanwhile>` with the lines around them, and no direct chat does. The people, places and lore those lines raise fill `<memory>`, people by name with no mention handle, since an entry mentions nobody. The world is `prompts/world.md` in `<virtual_world>` whenever the file is not empty. Her newest `selfreflection.entries` (150) entries make `<selfreflection>`, oldest first, read from the `selfreflection` table by `readSelfreflection` in `src/memory/db/selfreflection-past.ts`. No mirror place and no message is read for it.

## How a kind is chosen

The code draws the kind of an entry before the plan request. `drawWeights` in `src/behavior/selfreflection.ts` scales the weight of each kind in `SELFREFLECTION_KINDS` by the kind's share of all the weights over its use among the newest 150 entries (`DEFAULT_HISTORY_POSTS`), where its use is its count over the entries in that window. The factor stays between 0.25 and 4, so a kind no entry in the window used gets 4. The kind of the newest entry then counts a quarter, which keeps the same kind twice in a row possible and rare. `pickKind` draws one kind from these weights with the turn's `rng`. While a post may carry no picture, the picture kinds (`DEFAULT_PICTURE_KINDS`) stay out of the draw. A kind the owner forces for one post replaces the draw.

The plan request offers that one kind in `<kinds>` and in the `kind` enum of its schema, `selfreflectionPlanFormat`. When the plan request fails or its answer is not that object, the entry is written in the same kind with an empty brief. The journal line `selfreflection: planned` carries `drawn: true` for a drawn kind.

## Seeds and the stored plan

The plan request carries `<seeds>`, two combinations (`SEED_SETS`) that `pickSeeds` in `src/behavior/selfreflection.ts` draws with one line of each family of `prompts/selfreflection-seeds.md`. `usedSeedLines` collects the lines of the combinations the newest 150 entries built on, and the draw leaves them out. A family whose every line is taken is drawn from whole. The planner answers `seed`, the 1-based number of the combination its brief builds on, and `planSeed` reads a missing, fractional or out-of-range value as 0, which means none.

An entry the planner planned keeps `plan` in its `extra`: the `brief`, the `seeds` offered and the `seed` taken. `recordEntry` in `src/behavior/selfreflection-turn.ts` puts it on the post, and the one writer stores it with the entry. An entry whose planner did not answer has no `plan`. `/memory selfreflection show <id>` prints it with the rest of `extra`.

An entry also keeps `turnId` in its `extra`, the id of the selfreflection turn that wrote it. `recordEntry` takes it from the turn runner. An entry recorded before the field has no `turnId`.

`<selfreflection>` shows a past picture post by its scene. `sceneOf` takes the scene from the stored `plan.brief`, else from the description of the entry's first linked picture, else from its drawing prompt. `readSelfreflection` reads that description from the entry's `media_links` on every read and never stores it, and `<selfreflection>` cuts it to one line of at most `selfreflection.sceneChars` (400) characters at a word boundary.

## Mirrors

The selfreflection is one persona collection (`store.getSelfreflection`, `store.setSelfreflectionPosts`), and an entry needs no server: `createSelfreflection` takes none, and a turn of an entry names none. A mirror is one known place that receives her selfreflection entries, and there may be none or many. The owner manages them with `/mirror` ([commands](cli.md#mirrors)), and `src/behavior/mirror-desk.ts` writes every change through the memory writer (kind `mirror`, `src/memory/db/mirror-config.ts`). Every destination is an interface-qualified place id, or a bare native id that one place alone holds. Two interfaces sharing the native id make it `ambiguous-place`, and a root or a private chat is `unknown-place`. An interface that is not connected delays delivery and changes no configuration.

Configuration and delivery history live apart. `/mirror remove` marks the `mirrors` row and keeps its `publications` rows, so adding the same destination again reuses the row and sends nothing already delivered. `/mirror configure <mirror> --enabled false` keeps everything and holds what is queued until the mirror is enabled again. A repeated add answers the same mirror.

## Delivery

`createMirrors` in `src/behavior/mirror.ts` gives each entry one `publications` row per enabled mirror its [audience](#audience) allows, keyed `selfreflection:<entry id>:<place id>`. The publisher claims the row through the writer before anything reaches the interface, so the timer's drain, the reconnect's drain and the turn's own publish send it once between them. A claim holds a claimant and a time (`src/memory/db/publication-delivery.ts`).

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

The persona chooses which mirrors get an entry. With two or more mirrors enabled, the writer's `<inner>` carries `<publication_places>`, one line per mirror with its `place:<place id>` token, its name and its `interface:<iface>` token. `publicationPlaces` in `src/memory/db/selfreflection-audience.ts` reads the mirrors from memory, and her `<audience>` is checked against the same list, so a place that is no mirror is `audience-unknown-place`. With one mirror or none the block is absent. She answers with at most one `<audience>` tag, and `recordEntry` in `src/behavior/selfreflection-turn.ts` stores the result on the post as `publicationAudience`, in the `extra` column of the `selfreflection` row.

| Stored `publicationAudience` | Reaches |
|---|---|
| `{ kind: 'unrestricted' }` | Every mirror, mirrors added later included. Leaving the tag out records this. |
| `{ kind: 'interface', iface }` | Every mirror on that interface. |
| `{ kind: 'place', placeId }` | The place and its descendants through `parent_id`. |

Places compare by their interface-qualified id, so the same native id on two interfaces stays two places. An unknown or malformed value keeps the entry in memory and publishes it nowhere. The turn's `result.selfreflection.audience` answers `{ ok: false, code }` with `audience-unknown-place`, `audience-unknown-interface` or `audience-malformed`, the post stores `{ kind: 'invalid', code }`, and each mirror's outcome is `failed` with `audience-invalid`. Two different values in one turn are malformed, and the tag counts from every answer of the turn.

A refusal reaches both people concerned. `/mirror status` lists the entry under each mirror as `blocked` with `audience-invalid` and the reason code (`audienceBlocked`) for as long as the post stores that value. Her next selfreflection request names the post and the reason in `<feedback>`. `markRefusalsTold` in `src/behavior/selfreflection-turn.ts` marks the post `told` once the model answers that request, so a failed request tells her again and an answered one never does. An entry under a saved `publicationBoundary` shows only in a request whose past posts hold it.

`storedSelfreflectionPublicationRefusal` in `src/memory/db/publish.ts` reads the stored row in four places: when the publisher queues, in the writer's `prepare`, in a backfill scan and right before a send. A mirror the entry leaves out gets no row, and its outcome is `failed` with `audience-excluded`. A row queued before a narrowing ends `failed` with the same code and sends nothing, and a backfill passes over such an entry without blocking the ones after it.

The audience only narrows the trusted restrictions. A saved `publicationBoundary` applies first, and an entry that is neither group material nor under a boundary reaches nothing, whatever it names. A row with no `publicationAudience` predates the choice and stays as it is. An old group entry goes only to its own `scope_iface`. An old entry with no interface, an internal scope or a private scope goes nowhere unless a saved boundary allows its origin.

No edit recalls a copy that already went out. `/mirror status` lists such an entry as delivered outside its audience (`deliveredOutsideAudience`), and `publicationState` answers `outsideAudience: true`, apart from the rows the audience stops.

## Backfill

Enabling backfill on a mirror captures a high-water mark, the newest entry at that moment, and makes the first old entry due at once. Each interval then sends the oldest eligible entry by persisted order (`at_ms`, `position`, `id`). After downtime one due entry goes out and the next is scheduled from the current time, so missed intervals never burst. Entries written later go out at once as new ones and move neither the mark nor the due time. Backfill turns itself off when nothing up to the mark is left, and at once when nothing is eligible.

Receipts, claims in flight and uncertain sends take an entry out of the scan. An old entry that fails or lacks a file blocks the later old entries of that mirror, shown as `blocked` in `/mirror status`, and is retried at the next slot. `/mirror reconcile` unblocks an entry that can never go out. Disabling a mirror or turning backfill off keeps the mark and the progress, and turning it on again continues from there. Before backfilling a channel that already holds old posts, record them with `/mirror reconcile --through <entry id>`: an old post with no entry mapping is no receipt.

The selfreflection prompts supply the writing and drawing instructions. Personal replacements belong in `data/prompts/`; keep the placeholders expected by the [prompt contract](prompt-contract.md). Settings and their readers are listed in [configuration](configuration.md). Start implementation inspection in [src/behavior/selfreflection.ts](../src/behavior/selfreflection.ts) and [src/behavior/mirror.ts](../src/behavior/mirror.ts).
