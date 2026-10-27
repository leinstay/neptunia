# Diary

The persona posts in one channel on its own, at random times, without anyone asking. The posts look like a personal feed: drawings, memes, reflections, retold news, curious facts, one-line moods. Before each post the persona reviews its own recent history and picks something it has not done yet. The owner points the diary at a channel and tunes the schedule and kinds through config.

Behind `features.diary` (default `true`, a missing key counts as on).

## Setup

1. Create a channel on your server. The bot needs View Channel, Send Messages, Read Message History and Attach Files there.
2. Set `diary.channelId` to the channel's id (`/nep set diary.channelId <id>`, or in `config.local.json`). Read at every tick; an empty value means no diary.
3. Clearing `diary.channelId` stops the diary while the history file stays, so setting it again keeps the persona's memory of what it posted.
4. The first tick with a channel fills an empty diary history from the persona's past posts in that channel. Posting starts on the next tick (every 30 seconds). The first post may take a few minutes, depending on when the next planned slot falls.

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

`/nep diary post` runs one post now, outside the plan and the quiet day, under the same rails (daily caps, channel permissions). An optional `topic` (one line, at most 1000 characters) reaches the compose request. While another turn holds the lease, the command waits up to `diary.forceWaitMs` (default 120000 ms).

## Where entries are stored

Each diary post is recorded in `data/guilds/<id>/diary.json`: its timestamp, kind, a one-line gist (at most `diary.gistChars`, default 200, characters), the Discord message ids it was sent as, the search query (when one ran) and the picture's scene text (when one was drawn).

The memory database (`data/memory.db`) stores each entry as a `diary` row with its full text, and each picture as a `media` row (kind `diary`, the diary entry as owner) with the image file saved to `data/media/diary/`. Audio attachments (voice messages) are saved alongside the pictures.

The diary channel is a mirror of the database rows. The publication system (`src/memory/db/publish.js`) tracks each send with an idempotency key and a content hash, so a crash between queuing and sending never sends twice.

## Config reference

Every key is listed in [Configuration: diary](configuration.md#diary).
