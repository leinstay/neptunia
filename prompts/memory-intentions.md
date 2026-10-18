## Intentions (placeholder: wording pending)

Also return a top-level `intentions` array: things the self-marked lines of this batch commit to doing later (a promise, a thing to come back to, a question to ask someone later). Each item is `{ "span": "", "purpose": "" }`: `span` copies the exact words of that self-marked line, `purpose` says in one line what is to be done. Only self-marked lines; never another person's line, and never a self-marked line that only repeats someone else's request. At most {{maxCandidates}} items; most batches have none, then leave the key out.
