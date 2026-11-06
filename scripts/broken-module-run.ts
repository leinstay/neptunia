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
// scripts/code-health.ts (the file name with any tail of its folder path, joined by hyphens) it breaks that module
// only and runs the files the rule matches. The rule pairs unrelated files of the same base name (`store`,
// `access`), so this mode over-reports.
//
// Stryker (scripts/mutation-diff.ts) judges per test file, so it cannot name the single test that kills nothing.
// This run can. The tool deletes nothing. It is an occasional tool: no npm script.
//
//   node scripts/broken-module-run.ts [--by-imports] [--out <report.json>] [--max-minutes <n>] [<name> ...]
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

import { findImports } from './code-health.ts';
import { selectTestFiles } from './mutation-diff.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BROKEN_BODY = "{ throw new Error('broken-module-run'); }";
const TEST_TIMEOUT_MS = 120_000;
const PROJECTION_AFTER = 20;

/** A body to replace, as text offsets. */
type Edit = { start: number; end: number; name: string };
type Broken = { source: string | null; broken: Array<string>; reason?: string };
type TapTest = { name: string; status: 'passed' | 'failed' | 'skipped' | 'todo' };
type Entry = {
  module: string;
  status: string;
  tests: number;
  green: Array<string>;
  testFile?: string;
  ms?: number;
  broken?: Array<string>;
  unbreakable?: Array<string>;
};

function isFunctionValue(node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function editOf(body: ts.Node | undefined, name: string, file: ts.SourceFile): Array<Edit> {
  return body ? [{ start: body.getStart(file), end: body.end, name }] : [];
}

/** The edits for a value that is exported under a name: a function, or an object literal of simple functions. */
function editsForValue(value: ts.Expression | undefined, name: string, file: ts.SourceFile): Array<Edit> {
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

/** Local names an `export { a, b as c }` list exports, mapped to the exported name. */
function exportListNames(file: ts.SourceFile): Map<string, string> {
  const names: Map<string, string> = new Map();
  for (const stmt of file.statements) {
    if (!ts.isExportDeclaration(stmt) || stmt.moduleSpecifier || !stmt.exportClause) continue;
    if (!ts.isNamedExports(stmt.exportClause)) continue;
    for (const spec of stmt.exportClause.elements) names.set((spec.propertyName ?? spec.name).text, spec.name.text);
  }
  return names;
}

function hasExportModifier(stmt: ts.Statement): boolean {
  return ts.canHaveModifiers(stmt) && (ts.getModifiers(stmt) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/** The edits of one top-level statement, given the names an export list exports. */
function editsForStatement(stmt: ts.Statement, listed: Map<string, string>, file: ts.SourceFile): Array<Edit> {
  const exported = hasExportModifier(stmt);
  if (ts.isFunctionDeclaration(stmt)) {
    const isDefault = ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
    const local = stmt.name?.text;
    const name = isDefault ? 'default' : exported ? local : local ? listed.get(local) : undefined;
    return name ? editOf(stmt.body, name, file) : [];
  }
  if (ts.isExportAssignment(stmt)) return editsForValue(stmt.expression, 'default', file);
  if (!ts.isVariableStatement(stmt)) return [];
  const { declarations } = stmt.declarationList;
  return declarations.flatMap((decl) => {
    if (!ts.isIdentifier(decl.name)) return [];
    const name = exported ? decl.name.text : listed.get(decl.name.text);
    return name ? editsForValue(decl.initializer, name, file) : [];
  });
}

/**
 * The bodies of the exported functions of a module: function declarations, exported arrow and function consts, the
 * simple functions of an exported object literal, a default export and the local functions an export list names.
 * Exported classes and other values are left out.
 * @returns Sorted by position.
 */
export function findBreakEdits(source: string): Array<Edit> {
  const file = ts.createSourceFile('module.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const listed = exportListNames(file);
  const edits = file.statements.flatMap((stmt) => editsForStatement(stmt, listed, file));
  return edits.sort((a, b) => a.start - b.start);
}

/**
 * The module source with every exported function body replaced by a throw. A module with nothing to break gives
 * `source: null` and the reason.
 */
export function breakSource(source: string): Broken {
  const edits = findBreakEdits(source);
  if (edits.length === 0) return { source: null, broken: [], reason: 'no exported function to break' };
  let broken = source;
  for (const edit of [...edits].reverse()) broken = broken.slice(0, edit.start) + BROKEN_BODY + broken.slice(edit.end);
  return { source: broken, broken: edits.map((e) => e.name) };
}

const OK_LINE = /^(\s*)(not )?ok \d+ - (.*)$/;
const SUBTEST_LINE = /^(\s*)# Subtest: /;
const DIRECTIVE = /\s+# (SKIP|TODO)\b.*$/i;

type Node = { name: string; status: TapTest['status']; children: Array<Node> };

/**
 * One test per leaf of the tap output, named by its path of suites joined with " > ". A suite line is not a test of
 * its own. A skip or todo directive marks the test and keeps it out of the passed ones. The node test runner prints a
 * parent's `ok` line after its children, one indent level (four spaces) deeper.
 */
export function parseTap(output: string): Array<TapTest> {
  const pending: Map<number, Array<Node>> = new Map();
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

function leaves(node: Node, parents: Array<string>): Array<TapTest> {
  if (node.children.length === 0) return [{ name: [...parents, node.name].join(' > '), status: node.status }];
  return node.children.flatMap((child) => leaves(child, [...parents, node.name]));
}

const ENGINE = /^(?:src|interfaces)\/.+\.(?:js|mjs|ts)$/;
const FIXTURE = /^tests\/.+\.(?:js|mjs|ts)$/;

/** A workspace package: its `package.json` name, its folder and the fields that say which file an import reaches. */
type Workspace = { name: string; dir: string; exports?: unknown; main?: string };

/** The bare specifiers of a source, subpaths kept: static imports, `export from` and literal `import('x')` calls. */
function bareSpecifiers(source: string): Array<string> {
  const file = ts.createSourceFile('file.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found: Array<string> = [];
  const visit = (node: ts.Node) => {
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

/** The target of an `exports` entry: a string, or the first string among the conditions. */
function exportTarget(target: unknown): string | undefined {
  if (typeof target === 'string') return target;
  if (!target || typeof target !== 'object') return undefined;
  for (const value of Object.values(target)) {
    const found = exportTarget(value);
    if (found) return found;
  }
  return undefined;
}

/** The repository path a workspace import reaches through the package's `exports` (or `main`), or undefined. */
function resolveWorkspace(specifier: string, packages: Array<Workspace>): string | undefined {
  const pkg = packages.find((p) => specifier === p.name || specifier.startsWith(`${p.name}/`));
  if (!pkg) return undefined;
  const sub = specifier === pkg.name ? '.' : `.${specifier.slice(pkg.name.length)}`;
  const map = pkg.exports;
  const isMap = map && typeof map === 'object' && Object.keys(map).some((k) => k.startsWith('.'));
  let target: string | undefined;
  if (isMap) target = exportTarget((map as Record<string, unknown>)[sub]);
  else if (sub === '.') target = exportTarget(map) ?? pkg.main;
  else target = exportTarget(map) ? undefined : sub;
  return target ? path.posix.join(pkg.dir, target) : undefined;
}

/** The files of a workspace package that an entry file reaches through relative imports, the entry included. */
function packageGraph(
  entry: string,
  read: (filePath: string) => string | undefined,
  packages: Array<Workspace>
): Set<string> {
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
 * @param testPath Repository path of the test file.
 * @param read The source of a repository path, if it exists.
 * @param packages The workspace packages.
 * @returns Sorted and unique.
 */
export function reachedModules(
  testPath: string,
  read: (filePath: string) => string | undefined,
  packages: Array<Workspace> = []
): Array<string> {
  const reached: Set<string> = new Set();
  /** `followSrc`: whether the src files `filePath` imports count. */
  const collect = (filePath: string, followSrc: boolean) => {
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

function greenShare(entry: Entry): number {
  return entry.tests === 0 ? 0 : entry.green.length / entry.tests;
}

/**
 * The entries that ran, by the share of green tests, the largest first (then by green count and name), followed by
 * the ones that did not run, by name.
 */
export function sortSummary(entries: Array<Entry>): Array<Entry> {
  const ran = entries.filter((e) => e.status === 'ran');
  const rest = entries.filter((e) => e.status !== 'ran');
  ran.sort(
    (a, b) => greenShare(b) - greenShare(a) || b.green.length - a.green.length || a.module.localeCompare(b.module)
  );
  rest.sort((a, b) => a.module.localeCompare(b.module));
  return [...ran, ...rest];
}

function git(cwd: string, args: Array<string>): string {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr || run.error?.message || ''}`);
  return run.stdout;
}

/**
 * Fills a `node_modules` folder of the copy with one link per package. A workspace link (a symlink in the real
 * folder) is copied as the same relative link, so it resolves to the copy's package folder, where the broken modules
 * are, and not to the real tree. A scope folder is rebuilt the same way.
 * @param from The real `node_modules`.
 * @param to The copy's.
 */
function linkModules(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(source), target);
    else if (entry.isDirectory() && entry.name.startsWith('@')) linkModules(source, target);
    else fs.symlinkSync(source, target);
  }
}

/** Copies the tracked tree to a folder and links the dependency folders in. */
function copyTree(dest: string): void {
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

/** Runs one test file in a folder with a timeout and kills its process group on timeout. */
function runTestFile(
  cwd: string,
  testFile: string,
  tmp: string
): Promise<{ output: string; code: number | null; timedOut: boolean }> {
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
 * @param label The entry's `module` field.
 * @param requireBroken Skip the run when no module could be broken (the module mode).
 */
async function runBroken(
  copy: string,
  label: string,
  testFile: string,
  modules: Array<string>,
  requireBroken: boolean
): Promise<Entry> {
  const originals: Map<string, string> = new Map();
  const broken: Array<string> = [];
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
    const [only] = tests;
    const loadFailure = tests.length === 1 && only?.status === 'failed' && only.name.endsWith(testFile);
    if (tests.length === 0 || loadFailure) return { ...base, status: 'import-failed', tests: 0, green: [], ms };
    const green = tests.filter((t) => t.status === 'passed').map((t) => t.name);
    return { ...base, status: 'ran', tests: tests.length, green, ms };
  } finally {
    for (const [target, original] of originals) fs.writeFileSync(target, original);
  }
}

function summaryText(entries: Array<Entry>): string {
  const lines = sortSummary(entries).map((e) => {
    const share = e.status === 'ran' ? `${e.green.length}/${e.tests} green` : e.status;
    return `${e.module}  ${e.testFile ?? '-'}  ${share}`;
  });
  return lines.join('\n');
}

function parseArgs(argv: Array<string>): {
  out: string | null;
  maxMinutes: number;
  byImports: boolean;
  modules: Array<string>;
} {
  let out = null;
  let maxMinutes = 90;
  let byImports = false;
  const modules: Array<string> = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--out') out = argv[++i] ?? null;
    else if (arg === '--by-imports') byImports = true;
    else if (arg === '--max-minutes') maxMinutes = Number(argv[++i]);
    else modules.push(arg);
  }
  return { out, maxMinutes, byImports, modules };
}

type Job = { label: string; testFile: string | null; modules: Array<string> };

/** The jobs of the module mode: each module with each test file the naming rule matches to it. */
function moduleJobs(modules: Array<string>, testFiles: Array<string>): Array<Job> {
  return modules.flatMap((module) => {
    const matches: Array<string | null> = selectTestFiles([module], [], testFiles);
    if (matches.length === 0) matches.push(null);
    return matches.map((testFile) => ({ label: module, testFile, modules: [module] }));
  });
}

/** @param text The content of a `package.json`. */
function parsePackage(text: string): { name: string; exports?: unknown; main?: string } {
  const raw: unknown = JSON.parse(text);
  return raw as { name: string; exports?: unknown; main?: string };
}

/** The jobs of the import mode: each test file with the engine modules it reaches. */
function importJobs(files: Array<string>, tracked: Set<string>): Array<Job> {
  const read = (p: string) => (tracked.has(p) ? fs.readFileSync(path.join(root, p), 'utf8') : undefined);
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

async function main(argv: Array<string>): Promise<number> {
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
  const entries: Array<Entry> = [];
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
