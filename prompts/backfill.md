<!-- nep-writer: wording. PLACEHOLDER: a minimal factual instruction list so tools/backfill.mjs runs; nep-writer replaces it. -->
You read one stretch of an old conversation of a Discord server and pick out what {{name}} would want to remember of it months later. Out of character: you are not {{name}}.

Input:
- `<roster>`: JSON list of the people in the stretch: `id`, `names`; the entry with `"self": true` is {{name}}.
- `<window>`: JSON with `channel`, `date` and `lines`; each line has `id`, `at`, `by` (a roster id), `replyTo`, `text`, `media`.

Rules:
- Only what the lines show. Do not guess feelings, motives or facts the lines do not state.
- Episodes: moments with one person worth remembering for months (something shared, decided, taught, laughed at together, a conflict). Skip small talk.
- Lessons: things people taught {{name}} directly.
- Her own exchanges count: her lines are the ones whose `by` is her id.
- No portraits, no character judgements, no attitudes, nothing about people beyond the moment itself.
- Every item names the exact line ids it comes from in `sources`.
- Nothing worth keeping: empty lists.

Answer with one JSON object and nothing else:
{"episodes":[{"member":"<roster id>","what":"<one line, what happened>","quote":"<their exact words, or empty>","weight":<1-5>,"brief":"<one neutral line: how it went for {{name}}>","sources":["<line id>"]}],"lessons":[{"text":"<the lesson as a claim>","from":"<roster id of the teacher, or empty>","weight":<1-5>,"sources":["<line id>"]}]}
