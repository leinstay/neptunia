# Diary

The persona keeps a diary on its own, at random times, without anyone asking. The entries look like a personal feed: drawings, memes, reflections, retold news, curious facts, one-line moods. Before each entry the persona reviews its own recent history and picks something it has not done yet. Each entry is written into memory first and then posted to the diary's mirrors, the places the owner set up for it. The owner tunes the schedule and kinds through config.

Behind `features.diary` (default `true`, a missing key counts as on).

## Setup

1. Create a channel on your server. The bot needs View Channel, Send Messages, Read Message History and Attach Files there.
2. Set `diary.channelId` to the channel's id (`/nep set diary.channelId <id>`, or in `config.local.json`). The key is the seed of the diary's first mirror: the memory database's schema step v15 makes the channel's place a `diary` mirror the first time it opens with the key set and the place stored.
3. Once the mirror exists, `node tools/config-migrate.mjs --dry-run --db data/memory.db` and then `--apply --db data/memory.db` take the key out of `config.local.json`. Without the mirror the tool keeps the key and says so in one line.
4. The diary runs with or without a mirror. With none, its entries stay in memory and nothing is posted. Posting starts on the next tick (every 30 seconds), and the first entry may take a few minutes, depending on when the next planned slot falls.

## Windows

Posting times are drawn from windows, each a range of hours in `bot.timezone` with a `[min, max]` post count. A window whose `to` is not after its `from` wraps past midnight (18 to 1 runs 18:00 to 01:00). For each window the scheduler draws an integer between `min` and `max` and places that many slots at random times inside the window. Slots closer than `diary.minGapMinutes` (default 90) to each other are dropped. While more than `diary.maxPerDay` (default 12) remain, one is dropped at random.

The four default windows, all times in `bot.timezone`:

| Window | Hours | Posts |
|---|---|---|
| Morning | 07 to 11 | `[0, 0]` (off) |
| Day | 12 to 16 | `[0, 1]` |
| Evening | 18 to 01 | `[0, 2]` |
| Night | 01 to 05 | `[0, 1]` |

With `diary.quietDayChance` (default 0.3) the whole day gets no slots. A plan is created once per local day and stored in `data/state.json`. A new local day replans; a restart keeps the existing plan.

### Hunger

Days are not independent. Each window keeps a hunger count. A quiet day makes every window one point hungrier, and each quiet day in a row multiplies the next day's quiet chance by `diary.quietCarry` (default 0.25): a second quiet day in a row has a 7.5% chance instead of 30%. A window that posted resets to 0; one that posted nothing gains a point. When a hungry window draws zero posts, it rolls again once per hunger point, and each extra roll redraws with chance `1 - diary.hungerBoost` (default 0.5). Within one day, every window that came up empty adds a point to the windows after it, so a silent afternoon makes the evening more likely to post. A window set to `[0, 0]` never posts and never gets hungry.

A slot missed by more than `diary.slotGraceMinutes` (default 30) while the bot was down is dropped, not fired late in a burst. A slot blocked by a busy attention is retried on the next tick within the grace.

## What a post costs

Each diary post is two model requests:

1. A plan request on the `analyzer` role: picks the kind, a one-line brief, whether to search, and whether to draw.
2. A compose request on the `core` role (the persona's model) with the character card and full memory blocks.

When the plan asks for a web search (only for `diary.searchKinds`, by default `news` and `facts`), a Brave search runs first and adds a third request (the condenser on the `analyzer` role). The search counts against `web.maxPerDay`.

When the post includes a picture, the image model generates it at its own price. Diary pictures count against both `image.maxPerDay` and `diary.maxPicturesPerDay` (default 8).

A set post (`photoset`, `randomSet`) costs one picture per `draw.create` call, four to six by default, all counted against both caps. The caps are checked before the post starts, so one set can take the day past `diary.maxPicturesPerDay`. A set that comes out short is not posted, but the pictures it generated are paid for and counted.

Every model request counts against `llm.maxRequestsPerDay`. With the defaults (0 to 3 posts a day, 2 to 3 requests each, up to 8 pictures), a day costs roughly 0 to 9 chat requests plus picture generation.

## Kinds and seeds

`diary.kinds` maps each kind key to a weight. The planner sees the weights and how many of the last `diary.historyPosts` (default 150) posts used each kind, so it favours kinds that have been underused. A kind with weight 0 is never chosen.

| Kind | Default weight | What it is |
|---|---|---|
| `selfPicture` | 3 | The persona in a scene, a new setting every time |
| `picture` | 2 | A drawing without the persona: a place, an animal, something about a person |
| `meme` | 1 | A meme the persona drew |
| `thought` | 2 | A longer reflection, a review, an opinion |
| `people` | 2 | A post about one person on the server: what they did or said, how the persona feels |
| `news` | 2 | Something found on the internet that the people here care about |
| `facts` | 1 | A curious fact, an iceberg entry, a conspiracy theory told as such |
| `status` | 3 | One short line: mood, a plan, boredom |
| `photoset` | 1 | A set: the persona's own outing, one message plus four to six pictures |
| `randomSet` | 1 | A set: a gallery dump of anything the persona likes, one message plus four to six pictures |

`diary.searchKinds` (default `["news", "facts"]`) are the kinds that may trigger a search. `diary.pictureKinds` (default `["selfPicture", "picture", "meme", "photoset", "randomSet"]`) always get a picture when the day's caps allow it, whatever the planner answered. Other kinds draw only when the planner asks for one. When a post cannot carry a picture (the caps are spent, drawing is off, no image model, or the bot lacks Attach Files), the planner sees only the text kinds.

### Sets

The kinds in `diary.setKinds` (default `["photoset", "randomSet"]`) post a set: one message plus four to six pictures (`diary.set.pictures`), each from its own `draw.create` call. Every picture is generated before anything is sent. The messages go out first, then the pictures. A failed picture comes back to her before anything is posted, and she may draw again or post with what she has. With fewer than `diary.set.minPosted` (default 2) pictures, nothing is posted.

`photoset` is one place or occasion: the same outfit, the same light and hour, different moments and angles. Each call repeats the outfit and time because the image model sees one call at a time. `randomSet` is a gallery dump: unrelated pictures, the persona may be in some or none.

### Seeds

`prompts/diary-seeds.md` holds random seeds grouped by `# family` headers (place, setting, detail, activity, subject, twist). Code draws one line per family and composes `diary.seedSets` (default 2) combinations, handed to the planner in a `<seeds>` block. The planner builds something absent from the diary history out of them, or ignores them.

To customise, copy `prompts/diary-seeds.md` to `prompts.local/diary-seeds.md` and edit. Each line under a header is one seed; blank lines are ignored.

## The persona's world

`prompts/world.md` describes the persona's virtual world: the places and routines it lives in outside the chat. The tracked file is a neutral example. To write your own, create `prompts.local/world.md`.

The world block appears only in the diary's plan and compose requests. Turn it on with `/nep set diary.world true` (default `false`). Without it, the persona has no fixed home and does not claim one.

The world file never appears in an ordinary chat turn.

## Forced posts

`/nep diary post` runs one post now, outside the plan and the quiet day, under the same daily caps. An optional `topic` (one line, at most 1000 characters) reaches the compose request. While another turn holds the lease, the command waits up to `diary.forceWaitMs` (default 120000 ms).

## How an entry is written and posted

A due slot runs the diary turn as the `selfreflection` wake (`src/behavior/diary.js`, then `src/behavior/turn.js` in mode `diary`). The wake has no conversation. It writes from the place the diary is posted to: the first enabled mirror, or, with none, the place the last entry was published to. The turn takes that place as its conversation, and its history is her diary as memory holds it (`src/behavior/diary-turn.ts`): the newest `context.channelMessages` messages her entries posted, each built by the same line builder as a live message. A message's text, time and reply come from her line in the record, the newest revision, marked edited from the second revision on. Its pictures and voice come from the entry's `media` rows, with the description the media cache holds for the attachment. Nobody else's line is in it, and a message she deleted is left out. An entry with no line in the record is its text as one message.

The turn sends nothing. Her messages, the pictures she drew and her voice message are held, and the entry is recorded in memory before anything else happens: a `diary` row in `data/memory.db` with its full text, kind, gist (at most `diary.gistChars`, default 200, characters), search query and the first picture's scene. The daily post count counts the recorded entry. With no interface connected the entry is written all the same.

`src/behavior/mirror.ts` then publishes the entry once to every enabled mirror. Each mirror gets one `publications` row (`src/memory/db/publish.js`) with the key `diary:<entry id>:<place id>`. The row is prepared `queued` under the mirror's standing grant and sent through the interface: the voice message first, then her messages one by one, then the pictures in messages of files split by `diary.set.maxMessageBytes` and the interface's file limit. The row ends `sent` with the message ids and the attachment ids (kind `attachment`) as its receipts, `failed` with the interface's code, or `unknown` when the interface could not say. A second publication of the same entry to the same place reuses the row and sends nothing. Before any send, the entry's pictures and voice file are kept as files under `data/media/diary/` with their `media` rows, and the entry's post keeps her messages as sent. After the send each `media` row takes the message id and the attachment id the interface gave its file. A row still `queued` (no interface was connected) is sent when the interface connects and on each diary tick, after a restart too, rebuilt whole from memory: voice, messages, pictures.

The posts made before the mirrors existed stay as they were: `data/guilds/<id>/diary.json` names their message ids, and the diary media job (`memoryDb.diaryMedia`) fetches their text, pictures and audio from the place their publication names into `diary.text` and `media` rows (`data/media/diary/`). Each row keeps the file's `url`, `messageId` and `attachmentId` in `native_ref`, the attachment id as the platform's read gives it, and the description the media cache holds under `media:attachment:<attachmentId>`. A row written before it kept the attachment id is fetched once more; after that the job asks nothing.

## Mirrors

A mirror is one row of the `mirrors` table (schema v15): a place, whether it is enabled, and who set it up. There may be none or many. An enabled mirror is the owner's standing permission to post every entry there. A disabled row is kept and grants nothing.

A mirror place is written only by the diary. A message there opens no turn of hers (its line is still recorded in memory), and the core's outbound port (`guardMirrorPort`) refuses every send there from a turn, a wake or a tool with the code `diary-mirror`, which her tool result names. Reactions are not refused. Every mirror place carries the `labels.server.diary` mark in `<server>`, and the `<senses>` line names the first.

## Config reference

Every key is listed in [Configuration: diary](configuration.md#diary).
