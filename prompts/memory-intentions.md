## Intentions

Also return a top-level `intentions` array when the self-marked lines of this batch contain a real commitment to do something later: a promise, a question for someone not around, something to come back to. Each item: `{ "span": "", "purpose": "" }`. `span` copies the exact words from one self-marked line, nothing added or reworded. `purpose` says in one line what the persona committed to do.

Only self-marked lines; never another person's line, and never a self-marked line that repeats what someone else asked. A vague wish or an offhand conditional does not count. At most {{maxCandidates}} items; most batches have none. Leave the key out or return an empty array when nothing qualifies.
