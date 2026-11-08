#!/usr/bin/env node
// The `neptunia` command's entry (package.json `bin`): it turns on Node's compile cache (src/compile-cache.ts) and then
// loads bin/neptunia.ts, which does the work. The engine's modules are compiled when they are loaded, so the cache has
// to be on before the first of them, and an import of bin/neptunia.ts at the top of this file would load them first.

import os from 'node:os';
import { useCompileCache } from '../src/compile-cache.ts';

useCompileCache(process.env, os.homedir());
await import('./neptunia.ts');
