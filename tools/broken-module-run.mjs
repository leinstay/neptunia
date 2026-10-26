// Finds the tests that exercise no engine code. Two modes, both on a copy of the tracked tree under TMPDIR, so the
// real tree is never edited, and both run one test file at a time with the tap reporter.
//
// `--by-imports` (the one to trust): the unit is a test file. It collects the `src/` and `interfaces/` modules the
// file imports directly, plus the ones its fixtures under `tests/` import (one level) and the files a workspace package import such as `@neptunia/interface-discord` resolves to through that package's `exports`, replaces the body of every
// exported function of all of them with `throw new Error('broken-module-run')`, runs the file once and reads which
// tests still passed. A test that passes while every engine module it reaches throws exercises no engine code: it is
// a candidate for deletion.
//
// Without the flag: the unit is a module. For each `src/**/*.js` module that has a test file by the naming rule of
// tools/code-health.mjs (the file name with any tail of its folder path, joined by hyphens) it breaks that module
// only and runs the files the rule matches. The rule pairs unrelated files of the same base name (`store`,
// `access`), so this mode over-reports.
//
// Stryker (tools/mutation-diff.mjs) judges per test file, so it cannot name the single test that kills nothing.
// This run can. The tool deletes nothing. It is an occasional tool: no npm script.
//
//   node tools/broken-module-run.mjs [--by-imports] [--out <report.json>] [--max-minutes <n>] [<name> ...]
//
// The names are modules, or with `--by-imports` test files. Without names it takes every tracked `src/**/*.js`
// module, or every `tests/**/*.test.js` file. The report is JSON, one entry per unit and file pair: the test file,
// the count of tests, the full names of the tests that stayed green, the run time in milliseconds, a status (`ran`,
// `skipped: <why>`, `timeout`, `import-failed`) and with `--by-imports` the modules broken and the ones reached but
// not breakable. After twenty runs the tool projects its total time and stops with exit code 3 when the projection
// passes `--max-minutes` (default 90). The pure parts are exported for tests/broken-module-run.test.js.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

import { findImports } from './code-health.mjs';
import { selectTestFiles } from './mutation-diff.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BROKEN_BODY = "{ throw new Error('broken-module-run'); }";
const TEST_TIMEOUT_MS = 120_000;
const PROJECTION_AFTER = 20;

/**
 * @typedef {{ start: number, end: number, name: string }} Edit  A body to replace, as text offsets.
 * @typedef {{ source: string | null, broken: Array<string>, reason?: string }} Broken
 * @typedef {{ name: string, status: 'passed' | 'failed' | 'skipped' | 'todo' }} TapTest
 * @typedef {{ module: string, status: string, tests: number, green: Array<string>, testFile?: string, ms?: number, broken?: Array<string>, unbreakable?: Array<string> }} Entry
 */

/**
 * @param {ts.Node} node
 * @returns {node is ts.ArrowFunction | ts.FunctionExpression}
 */
function isFunctionValue(node) {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

/**
 * @param {ts.Node | undefined} body
 * @param {string} name
 * @param {ts.SourceFile} file
 * @returns {Array<Edit>}
 */
function editOf(body, name, file) {
  return body ? [{ start: body.getStart(file), end: body.end, name }] : [];
}

/**
 * The edits for a value that is exported under a name: a function, or an object literal of simple functions.
 * @param {ts.Expression | undefined} value
 * @param {string} name
 * @param {ts.SourceFile} file
 * @returns {Array<Edit>}
 */
function editsForValue(value, name, file) {
  if (!value) return [];
  if (isFunctionValue(value)) return editOf(value.body, name, file);
  if (!ts.isObjectLiteralExpression(value)) return [];
  return value.properties.flatMap((prop) => {
    if (!prop.name || !ts.isIdentifier(prop.name)) return [];
    const label = `${name}.${prop.name.text}`;
    if (ts.isMethodDeclaration(prop)) return editOf(prop.body, label, file);
    if (ts.isPropertyAssignment(prop) && isFunctionValue(prop.initializer))
      return editOf(prop.initializer.body, label, file);
    return [];
  });
}

/**
 * Local names an `export { a, b as c }` list exports, mapped to the exported name.
 * @param {ts.SourceFile} file
 * @returns {Map<string, string>}
 */
function exportListNames(file) {
  /** @type {Map<string, string>} */
  const names = new Map();
  for (const stmt of file.statements) {
    if (!ts.isExportDeclaration(stmt) || stmt.moduleSpecifier || !stmt.exportClause) continue;
    if (!ts.isNamedExports(stmt.exportClause)) continue;
    for (const spec of stmt.exportClause.elements) names.set((spec.propertyName ?? spec.name).text, spec.name.text);
  }
  return names;
}

/**
 * @param {ts.Statement} stmt
 * @returns {boolean}
 */
function hasExportModifier(stmt) {
  return ts.canHaveModifiers(stmt) && (ts.getModifiers(stmt) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/**
 * The edits of one top-level statement, given the names an export list exports.
 * @param {ts.Statement} stmt
 * @param {Map<string, string>} listed
 * @param {ts.SourceFile} file
 * @returns {Array<Edit>}
 */
function editsForStatement(stmt, listed, file) {
  const exported = hasExportModifier(stmt);
  if (ts.isFunctionDeclaration(stmt)) {
    const isDefault = ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
    const local = stmt.name?.text;
    const name = isDefault ? 'default' : exported ? local : local ? listed.get(local) : undefined;
    return name ? editOf(stmt.body, name, file) : [];
  }
  if (ts.isExportAssignment(stmt)) return editsForValue(stmt.expression, 'default', file);
  if (!ts.isVariableStatement(stmt)) return [];
  return stmt.declarationList.declarations.flatMap((decl) => {
    if (!ts.isIdentifier(decl.name)) return [];
    const name = exported ? decl.name.text : listed.get(decl.name.text);
    return name ? editsForValue(decl.initializer, name, file) : [];
  });
}

/**
 * The bodies of the exported functions of a module: function declarations, exported arrow and function consts, the
 * simple functions of an exported object literal, a default export and the local functions an export list names.
 * Exported classes and other values are left out.
 * @param {string} source
 * @returns {Array<Edit>} Sorted by position.
 */
export function findBreakEdits(source) {
  const file = ts.createSourceFile('module.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const listed = exportListNames(file);
  const edits = file.statements.flatMap((stmt) => editsForStatement(stmt, listed, file));
  return edits.sort((a, b) => a.start - b.start);
}

/**
 * The module source with every exported function body replaced by a throw. A module with nothing to break gives
 * `source: null` and the reason.
 * @param {string} source
 * @returns {Broken}
 */
export function breakSource(source) {
  const edits = findBreakEdits(source);
  if (edits.length === 0) return { source: null, broken: [], reason: 'no exported function to break' };
  let broken = source;
  for (const edit of [...edits].reverse()) broken = broken.slice(0, edit.start) + BROKEN_BODY + broken.slice(edit.end);
  return { source: broken, broken: edits.map((e) => e.name) };
}

const OK_LINE = /^(\s*)(not )?ok \d+ - (.*)$/;
const SUBTEST_LINE = /^(\s*)# Subtest: /;
const DIRECTIVE = /\s+# (SKIP|TODO)\b.*$/i;

/**
 * @typedef {{ name: string, status: TapTest['status'], children: Array<Node> }} Node
 */

/**
 * One test per leaf of the tap output, named by its path of suites joined with " > ". A suite line is not a test of
 * its own. A skip or todo directive marks the test and keeps it out of the passed ones. The node test runner prints a
 * parent's `ok` line after its children, one indent level (four spaces) deeper.
 * @param {string} output
 * @returns {Array<TapTest>}
 */
export function parseTap(output) {
  /** @type {Map<number, Array<Node>>} */
  const pending = new Map();
  for (const line of output.split('\n')) {
    const match = OK_LINE.exec(line);
    if (!match || SUBTEST_LINE.test(line)) continue;
    const level = Math.floor((match[1] ?? '').length / 4);
    const text = match[3] ?? '';
    const directive = DIRECTIVE.exec(text)?.[1]?.toLowerCase();
    const status = directive === 'skip' ? 'skipped' : directive === 'todo' ? 'todo' : match[2] ? 'failed' : 'passed';
    const children = pending.get(level + 1) ?? [];
    pending.delete(level + 1);
    pending.set(level, [...(pending.get(level) ?? []), { name: text.replace(DIRECTIVE, ''), status, children }]);
  }
  return (pending.get(0) ?? []).flatMap((node) => leaves(node, []));
}

/**
 * @param {Node} node
 * @param {Array<string>} parents
 * @returns {Array<TapTest>}
 */
function leaves(node, parents) {
  if (node.children.length === 0) return [{ name: [...parents, node.name].join(' > '), status: node.status }];
  return node.children.flatMap((child) => leaves(child, [...parents, node.name]));
}

const ENGINE = /^(?:src|interfaces)\/.+\.(?:js|mjs|ts)$/;
const FIXTURE = /^tests\/.+\.(?:js|mjs|ts)$/;

/**
 * @typedef {{ name: string, dir: string, exports?: unknown, main?: string }} Workspace  A workspace package: its
 *   `package.json` name, its folder and the fields that say which file an import reaches.
 */

/**
 * The bare specifiers of a source, subpaths kept: static imports, `export from` and literal `import('x')` calls.
 * @param {string} source
 * @returns {Array<string>}
 */
function bareSpecifiers(source) {
  const file = ts.createSourceFile('file.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  /** @type {Array<string>} */
  const found = [];
  /** @param {ts.Node} node */
  const visit = (node) => {
    const spec =
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
        ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? node.arguments[0]
          : undefined;
    if (spec && ts.isStringLiteralLike(spec) && !/^[./]|^(?:node|file|data):/.test(spec.text)) found.push(spec.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/**
 * The target of an `exports` entry: a string, or the first string among the conditions.
 * @param {unknown} target
 * @returns {string | undefined}
 */
function exportTarget(target) {
  if (typeof target === 'string') return target;
  if (!target || typeof target !== 'object') return undefined;
  for (const value of Object.values(target)) {
    const found = exportTarget(value);
    if (found) return found;
  }
  return undefined;
}

/**
 * The repository path a workspace import reaches through the package's `exports` (or `main`), or undefined.
 * @param {string} specifier
 * @param {Array<Workspace>} packages
 * @returns {string | undefined}
 */
function resolveWorkspace(specifier, packages) {
  const pkg = packages.find((p) => specifier === p.name || specifier.startsWith(`${p.name}/`));
  if (!pkg) return undefined;
  const sub = specifier === pkg.name ? '.' : `.${specifier.slice(pkg.name.length)}`;
  const map = pkg.exports;
  const isMap = map && typeof map === 'object' && Object.keys(map).some((k) => k.startsWith('.'));
  /** @type {string | undefined} */
  let target;
  if (isMap) target = exportTarget(/** @type {Record<string, unknown>} */ (map)[sub]);
  else if (sub === '.') target = exportTarget(map) ?? pkg.main;
  else target = exportTarget(map) ? undefined : sub;
  return target ? path.posix.join(pkg.dir, target) : undefined;
}

/**
 * The files of a workspace package that an entry file reaches through relative imports, the entry included.
 * @param {string} entry
 * @param {(filePath: string) => string | undefined} read
 * @param {Array<Workspace>} packages
 * @returns {Set<string>}
 */
function packageGraph(entry, read, packages) {
  const dir = packages.find((p) => entry.startsWith(`${p.dir}/`))?.dir ?? path.posix.dirname(entry);
  const seen = new Set([entry]);
  const queue = [entry];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    for (const p of findImports(read(file) ?? '', file)) {
      if (p.startsWith(`${dir}/`) && ENGINE.test(p) && !seen.has(p)) {
        seen.add(p);
        queue.push(p);
      }
    }
  }
  return seen;
}

/**
 * The engine modules a test file reaches: the `src/` and `interfaces/` files it imports directly, the ones the
 * files it imports under `tests/` (fixtures) import, one level down, and the files a workspace package import
 * resolves to. Built-ins, other packages and template-string imports are not followed.
 * @param {string} testPath  Repository path of the test file.
 * @param {(filePath: string) => string | undefined} read  The source of a repository path, if it exists.
 * @param {Array<Workspace>} [packages]  The workspace packages.
 * @returns {Array<string>} Sorted and unique.
 */
export function reachedModules(testPath, read, packages = []) {
  /** @type {Set<string>} */
  const reached = new Set();
  /** @param {string} filePath  @param {boolean} followSrc  Whether the src files it imports count. */
  const collect = (filePath, followSrc) => {
    const source = read(filePath) ?? '';
    if (followSrc) for (const p of findImports(source, filePath)) if (ENGINE.test(p)) reached.add(p);
    for (const spec of bareSpecifiers(source)) {
      const entry = resolveWorkspace(spec, packages);
      if (entry) for (const p of packageGraph(entry, read, packages)) reached.add(p);
    }
  };
  collect(testPath, true);
  const fixtures = findImports(read(testPath) ?? '', testPath).filter((p) => FIXTURE.test(p));
  for (const fixture of fixtures) collect(fixture, true);
  // A src file that only re-exports a workspace package (the engine's one door to the interface) reaches the package.
  for (const module of [...reached].filter((p) => p.startsWith('src/'))) collect(module, false);
  return [...reached].sort();
}

/**
 * @param {Entry} entry
 * @returns {number}
 */
function greenShare(entry) {
  return entry.tests === 0 ? 0 : entry.green.length / entry.tests;
}

/**
 * The entries that ran, by the share of green tests, the largest first (then by green count and name), followed by
 * the ones that did not run, by name.
 * @param {Array<Entry>} entries
 * @returns {Array<Entry>}
 */
export function sortSummary(entries) {
  const ran = entries.filter((e) => e.status === 'ran');
  const rest = entries.filter((e) => e.status !== 'ran');
  ran.sort(
    (a, b) => greenShare(b) - greenShare(a) || b.green.length - a.green.length || a.module.localeCompare(b.module)
  );
  rest.sort((a, b) => a.module.localeCompare(b.module));
  return [...ran, ...rest];
}

/**
 * @param {string} cwd
 * @param {Array<string>} args
 * @returns {string}
 */
function git(cwd, args) {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr || run.error?.message || ''}`);
  return run.stdout;
}

/**
 * Fills a `node_modules` folder of the copy with one link per package. A workspace link (a symlink in the real
 * folder) is copied as the same relative link, so it resolves to the copy's package folder, where the broken modules
 * are, and not to the real tree. A scope folder is rebuilt the same way.
 * @param {string} from  The real `node_modules`.
 * @param {string} to  The copy's.
 * @returns {void}
 */
function linkModules(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(source), target);
    else if (entry.isDirectory() && entry.name.startsWith('@')) linkModules(source, target);
    else fs.symlinkSync(source, target);
  }
}

/**
 * Copies the tracked tree to a folder and links the dependency folders in.
 * @param {string} dest
 * @returns {void}
 */
function copyTree(dest) {
  for (const rel of git(root, ['ls-files', '-z']).split('\0').filter(Boolean)) {
    const from = path.join(root, rel);
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
    fs.copyFileSync(from, path.join(dest, rel));
  }
  linkModules(path.join(root, 'node_modules'), path.join(dest, 'node_modules'));
  for (const d of fs.readdirSync(path.join(root, 'interfaces'))) {
    const rel = `interfaces/${d}/node_modules`;
    if (fs.existsSync(path.join(root, rel))) linkModules(path.join(root, rel), path.join(dest, rel));
  }
}

/**
 * Runs one test file in a folder with a timeout and kills its process group on timeout.
 * @param {string} cwd
 * @param {string} testFile
 * @param {string} tmp
 * @returns {Promise<{ output: string, code: number | null, timedOut: boolean }>}
 */
function runTestFile(cwd, testFile, tmp) {
  return new Promise((resolve) => {
    const args = ['--test', '--test-reporter=tap', '--test-concurrency=1', testFile];
    const child = spawn(process.execPath, args, { cwd, env: { ...process.env, TMPDIR: tmp }, detached: true });
    let output = '';
    let timedOut = false;
    child.stdout.on('data', (d) => (output += String(d)));
    child.stderr.on('data', (d) => (output += String(d)));
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    }, TEST_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ output, code, timedOut });
    });
  });
}

/**
 * Breaks the given modules in the copy, runs one test file, restores the modules.
 * @param {string} copy
 * @param {string} label  The entry's `module` field.
 * @param {string} testFile
 * @param {Array<string>} modules
 * @param {boolean} requireBroken  Skip the run when no module could be broken (the module mode).
 * @returns {Promise<Entry>}
 */
async function runBroken(copy, label, testFile, modules, requireBroken) {
  /** @type {Map<string, string>} */
  const originals = new Map();
  /** @type {Array<string>} */
  const broken = [];
  const unbreakable = [];
  for (const module of modules) {
    const target = path.join(copy, module);
    if (!fs.existsSync(target)) continue;
    const original = fs.readFileSync(target, 'utf8');
    const result = breakSource(original);
    if (result.source === null) {
      unbreakable.push(module);
      continue;
    }
    originals.set(target, original);
    fs.writeFileSync(target, result.source);
    broken.push(module);
  }
  const base = { module: label, testFile, broken, unbreakable };
  if (requireBroken && broken.length === 0) {
    return { ...base, status: 'skipped: no exported function to break', tests: 0, green: [] };
  }
  const started = Date.now();
  try {
    const tmp = fs.mkdtempSync(path.join(copy, '.tmp-'));
    const run = await runTestFile(copy, testFile, tmp);
    const ms = Date.now() - started;
    if (run.timedOut) return { ...base, status: 'timeout', tests: 0, green: [], ms };
    const tests = parseTap(run.output);
    const loadFailure = tests.length === 1 && tests[0]?.status === 'failed' && tests[0].name.endsWith(testFile);
    if (tests.length === 0 || loadFailure) return { ...base, status: 'import-failed', tests: 0, green: [], ms };
    const green = tests.filter((t) => t.status === 'passed').map((t) => t.name);
    return { ...base, status: 'ran', tests: tests.length, green, ms };
  } finally {
    for (const [target, original] of originals) fs.writeFileSync(target, original);
  }
}

/**
 * @param {Array<Entry>} entries
 * @returns {string}
 */
function summaryText(entries) {
  const lines = sortSummary(entries).map((e) => {
    const share = e.status === 'ran' ? `${e.green.length}/${e.tests} green` : e.status;
    return `${e.module}  ${e.testFile ?? '-'}  ${share}`;
  });
  return lines.join('\n');
}

/**
 * @param {Array<string>} argv
 * @returns {{ out: string | null, maxMinutes: number, byImports: boolean, modules: Array<string> }}
 */
function parseArgs(argv) {
  let out = null;
  let maxMinutes = 90;
  let byImports = false;
  /** @type {Array<string>} */
  const modules = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--out') out = argv[++i] ?? null;
    else if (arg === '--by-imports') byImports = true;
    else if (arg === '--max-minutes') maxMinutes = Number(argv[++i]);
    else modules.push(arg);
  }
  return { out, maxMinutes, byImports, modules };
}

/**
 * @typedef {{ label: string, testFile: string | null, modules: Array<string> }} Job
 */

/**
 * The jobs of the module mode: each module with each test file the naming rule matches to it.
 * @param {Array<string>} modules
 * @param {Array<string>} testFiles
 * @returns {Array<Job>}
 */
function moduleJobs(modules, testFiles) {
  return modules.flatMap((module) => {
    /** @type {Array<string | null>} */
    const matches = selectTestFiles([module], [], testFiles);
    if (matches.length === 0) matches.push(null);
    return matches.map((testFile) => ({ label: module, testFile, modules: [module] }));
  });
}

/**
 * @param {string} text  The content of a `package.json`.
 * @returns {{ name: string, exports?: unknown, main?: string }}
 */
function parsePackage(text) {
  /** @type {unknown} */
  const raw = JSON.parse(text);
  return /** @type {{ name: string, exports?: unknown, main?: string }} */ (raw);
}

/**
 * The jobs of the import mode: each test file with the engine modules it reaches.
 * @param {Array<string>} files
 * @param {Set<string>} tracked
 * @returns {Array<Job>}
 */
function importJobs(files, tracked) {
  const read = (/** @type {string} */ p) => (tracked.has(p) ? fs.readFileSync(path.join(root, p), 'utf8') : undefined);
  const packages = [...tracked]
    .filter((p) => /^interfaces\/[^/]+\/package\.json$/.test(p))
    .map((p) => {
      const json = parsePackage(read(p) ?? '{}');
      return { name: json.name, dir: path.posix.dirname(p), exports: json.exports, main: json.main };
    });
  return files.map((testFile) => ({
    label: testFile,
    testFile,
    modules: reachedModules(testFile, read, packages).filter((m) => tracked.has(m)),
  }));
}

/**
 * @param {Array<string>} argv
 * @returns {Promise<number>}
 */
async function main(argv) {
  const args = parseArgs(argv);
  const trackedList = git(root, ['ls-files']).split('\n').filter(Boolean);
  const tracked = new Set(trackedList);
  const testFiles = trackedList.filter((f) => /^tests\/.+\.test\.(?:js|mjs|ts)$/.test(f));
  const names =
    args.modules.length > 0
      ? args.modules
      : args.byImports
        ? testFiles
        : trackedList.filter((f) => /^src\/.+\.js$/.test(f));
  const jobs = args.byImports ? importJobs(names, tracked) : moduleJobs(names, testFiles);
  const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'broken-module-'));
  const outPath = args.out ?? path.join(scratch, 'report.json');
  const copy = path.join(scratch, 'tree');
  copyTree(copy);
  /** @type {Array<Entry>} */
  const entries = [];
  const started = Date.now();
  let code = 0;
  try {
    for (const { label, testFile, modules } of jobs) {
      if (!testFile) {
        entries.push({ module: label, status: 'skipped: no test file', tests: 0, green: [] });
        continue;
      }
      const entry = await runBroken(copy, label, testFile, modules, !args.byImports);
      entries.push(entry);
      console.error(`${entries.length}/${jobs.length} ${label} ${entry.status} ${entry.ms ?? 0} ms`);
      if (entries.length === PROJECTION_AFTER) {
        const projected = ((Date.now() - started) / PROJECTION_AFTER) * jobs.length;
        console.error(`projection: ${(projected / 60_000).toFixed(1)} minutes`);
        if (projected / 60_000 > args.maxMinutes) {
          console.error(`projection passes ${args.maxMinutes} minutes, stopping`);
          code = 3;
          break;
        }
      }
    }
  } finally {
    fs.writeFileSync(outPath, JSON.stringify({ wallMs: Date.now() - started, entries: sortSummary(entries) }, null, 2));
    fs.rmSync(copy, { recursive: true, force: true });
  }
  console.log(summaryText(entries));
  console.error(`report: ${outPath}`);
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`broken-module-run: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 2;
    }
  );
}
