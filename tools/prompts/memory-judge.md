PLACEHOLDER (NEEDS REVIEW: nep-writer writes this file; until then tools/memory-sim.mjs sends no judge request)

The judge of tools/memory-sim.mjs. It is sent as the system message; the user message is two blocks, `<before>` and
`<after>`, each one member's stored profile prose as JSON (`{ "<field>": "<text>" }`) before and after a replayed
window. The tool reads one JSON object from the answer:

{"lostFacts": ["<a fact present before and missing after>"], "lostRelations": ["<a relation present before and missing after>"]}
