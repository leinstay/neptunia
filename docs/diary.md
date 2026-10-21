# Diary

The persona posts in one channel on its own, at random times, without anyone asking. The posts look like a personal feed: drawings of scenes from the persona's world, memes, reflections, retold news, curious facts, one-line moods. Before each post the persona reviews its own recent history and picks something it has not done yet. The owner points the diary at a channel and tunes the schedule and kinds through config.

## Setup

1. Create a channel on your server. The bot needs View Channel, Send Messages, Read Message History and Attach Files there.
2. Set `diary.channelId` to the channel's id (`/nep set diary.channelId <id>`, or in `config.local.json`). It is read at every tick; an empty value means no diary, and clearing it stops the diary while the history file stays, so setting it again keeps the persona's memory of what it posted.
3. The first tick with a channel fills an empty diary history from the persona's past posts in that channel. The diary starts posting on the next tick (every 30 seconds). The first post may take a few minutes, depending on when the next planned slot falls.

There is no command that shows the plan or forces a post; the plan and the posts are in the journal (`diary: plan`) and the diary's own file.

## Windows

Posting times are drawn from windows, each a range of hours in `bot.timezone` with a `[min, max]` post count. A window whose `to` is not after its `from` wraps past midnight. For each window the scheduler draws an integer between `min` and `max` and places that many slots at random times inside the window. Slots closer than `diary.minGapMinutes` (90) to each other are dropped, and while more than `diary.maxPerDay` (3) remain, one is dropped at random.

The four default windows, with all times in `bot.timezone`:

| Window | Hours | Posts |
|---|---|---|
| Morning | 07–11 | `[0, 0]` (off) |
| Day | 12–16 | `[0, 1]` |
| Evening | 18–01 | `[0, 2]` |
| Night | 01–05 | `[0, 1]` |

With `diary.quietDayChance` (0.3) the whole day gets no slots at all. A plan is created once per local day (the date in `bot.timezone`) and stored in `data/state.json`. A new local day replans; a restart keeps the existing plan.

Days are not independent: the diary gets hungry. Each window keeps a hunger count that the journal logs with every `diary: plan`, one number per window in config order. A quiet day makes every window one point hungrier, and each quiet day in a row multiplies the next day's quiet chance by `diary.quietCarry` (0.25): with the defaults a second quiet day in a row has a 7.5% chance instead of 30%. A window whose planned post went out resets to 0; a window that posted nothing (no slot, a slot missed while the bot was down, or a refused one) gains a point. When a hungry window draws zero posts, it rolls again once per hunger point, and each extra roll redraws the count with chance 1 minus `diary.hungerBoost` (0.5). Within one day, every window that came up empty also adds a point to the windows after it, so a silent afternoon makes the evening more likely to post. A window set to `[0, 0]` never posts and never gets hungry.

A slot missed by more than `diary.slotGraceMinutes` (30) while the bot was down is dropped, not fired late in a burst. A slot blocked by a busy attention is retried on the next tick within the grace.

## What a post costs

Each diary post is two model requests:

1. A plan request on the `analyzer` role: picks the kind, a one-line brief, whether to search, and whether to draw.
2. A compose request on the `core` role (the persona's model) with the character card and the full set of memory blocks.

When the plan asks for a web search (only for `diary.searchKinds`, by default `news` and `facts`), a Brave search runs first and adds a third request (the condenser on the `analyzer` role). The search counts against `web.maxPerDay`.

When the post includes a picture, the image model generates it at its own price. Diary pictures count against both `image.maxPerDay` and `diary.maxPicturesPerDay` (2).

A set post (`photoset`, `randomSet`) costs one picture per `draw.create` call it makes, four to six by default, all counted against both caps. The caps are checked before the post starts, so one set can take the day past `diary.maxPicturesPerDay`. A set that comes out short is not posted, yet the pictures it generated are paid for and counted.

Every model request in a diary post counts against `llm.maxRequestsPerDay`. With the defaults (1–3 posts a day, 2–3 requests each, up to 2 pictures), a day costs roughly 3–9 chat requests plus picture generation.

## Kinds and seeds

`diary.kinds` maps each kind key to a weight. The planner sees the weights and how many of the last `diary.historyPosts` posts used each kind, so it favours kinds that have been underused. A kind with weight 0 is never chosen. The keys and their defaults:

| Kind | Weight | What it is |
|---|---|---|
| `selfPicture` | 3 | The persona in a scene, a new setting every time |
| `picture` | 2 | A drawing without the persona: a place, an animal, something about a person here |
| `meme` | 1 | A meme the persona drew |
| `thought` | 2 | A longer reflection, a review, an opinion |
| `people` | 2 | A post about one person on the server: what they did or said lately, how the persona feels about them |
| `news` | 2 | Something found on the internet that the server's people care about |
| `facts` | 1 | A curious fact, an iceberg entry, a conspiracy theory told as such |
| `status` | 3 | One short line: mood, a plan, boredom |
| `photoset` | 1 | A set: the persona's own outing, one message plus four to six pictures of it |
| `randomSet` | 1 | A set: a gallery dump of anything the persona likes, not only itself, one message plus four to six pictures |

`diary.searchKinds` (default `["news", "facts"]`) are the kinds that may trigger a search. `diary.pictureKinds` (default `["selfPicture", "picture", "meme", "photoset", "randomSet"]`) always get a picture when the day's picture caps allow it, whatever the planner answered. Other kinds draw only when the planner asks for one. When a post cannot carry a picture (the day's picture caps are spent, drawing is off, no image model, or the bot lacks Attach Files in the diary channel), the planner sees only the text kinds.

The kinds in `diary.setKinds` (default `["photoset", "randomSet"]`) post a set: one message plus four to six pictures (`diary.set.pictures`), each from its own `draw.create` call (several calls in one answer), with more seed combinations to draw from (`diary.set.seedSets`, 6, in the compose request). Every picture is generated (staged) before anything is sent, and the messages go out first, then the staged pictures; a failed picture comes back to her as a result before anything is posted, and she may draw again or post with the pictures she has. With fewer than two pictures (`diary.set.minPosted`) nothing is posted at all.

`prompts/diary-seeds.md` holds random seeds grouped by `# family` headers (place, setting, detail, activity, subject, twist). Code draws one line per family and composes `diary.seedSets` (2) combinations, handed to the planner in a `<seeds>` block. The combinations are near-infinite; the planner builds something absent from the diary history out of them, or ignores them when a better idea comes from the server's life.

To customise the seeds, copy `prompts/diary-seeds.md` to `prompts.local/diary-seeds.md` and edit the lines. Each line under a header is one seed; blank lines are ignored.

## The persona's world

`prompts/world.md` describes the persona's virtual world: the places and routines it lives in outside the chat. The tracked file is a neutral example. To write your own, create `prompts.local/world.md` (it replaces the tracked file whole, like `appearance.md`).

The world block appears only in the diary's two requests (plan and compose) and only when `diary.world` is `true` (default `false`). Turn it on with `/nep set diary.world true`. Without it, the persona has no fixed home and does not claim one.

The world file never appears in an ordinary chat turn. The scene text the persona writes in a `draw.create` call carries what the image model needs to see.

## Config reference

Every key is listed in [Configuration: diary](configuration.md#diary).
