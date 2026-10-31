#!/usr/bin/env node
// The scout agent's search command: one web search through OpenRouter's web
// plugin, the results printed as numbered plain lines (title, URL, snippet).
// The agent's shell runs it as `web-search <query> [--count N]` through the
// wrapper agents/scout/bin/web-search, which the runner puts on the OpenCode
// child's PATH (src/agent-runner/opencode.js); the logic is
// src/web/web-search.js.
//
//   node agents/scout/web-search.mjs <query words...> [--count N]
//
// Needs OPENROUTER_API_KEY (the task's key in the child's environment);
// NEPTUNIA_WEB_SEARCH_MODEL picks the model. Exit 0 with results, 1 when the
// search failed or found nothing, 2 for a wrong command line or no key.

import { runWebSearch } from '../../src/web/web-search.js';

const { code, stdout, stderr } = await runWebSearch({ argv: process.argv.slice(2) });
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);
process.exitCode = code;
