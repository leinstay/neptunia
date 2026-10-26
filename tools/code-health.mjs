// The code-health ratchet and the structure check. Reads the tracked tree (`git ls-files`), parses every .js, .mjs
// and .ts file with the TypeScript compiler API (syntax only, no type checker), and compares two things with
// `code-health-baseline.json` at the repository root:
//
//   size       a file over its line limit (2,000 unless its `structure.json` entry says otherwise) and a function
//              over 300 lines, nesting 6 or cyclomatic complexity 20
//   structure  a tracked file that matches no entry of `structure.json`, a tracked file in the local layer, an
//              import its entry does not allow, a module of a `required` entry without a test
//
// A value above the baseline, or an offender the baseline lacks, fails the run. A value below the baseline fails it
// too, so the improvement is written down and cannot hide a later regression. A waiver comment exempts one function
// (or one file) from one rule until a date:
//
//   // health: allow <rule> until <YYYY-MM-DD> -- <why>
//
//   node tools/code-health.mjs                check the tree (exit 0 or 1)
//   node tools/code-health.mjs --update       rewrite the baseline; refuses while something grew
//   node tools/code-health.mjs --docs         write docs/structure.md from structure.json
//   node tools/code-health.mjs --check-docs   fail when docs/structure.md differs from what --docs writes
//
// `npm run health` and `npm run health:update` call it. The pure functions are exported for
// tests/code-health.test.js.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = path.join(root, 'code-health-baseline.json');
const manifestPath = path.join(root, 'structure.json');
const docPath = path.join(root, 'docs', 'structure.md');

export const LIMITS = { fileLines: 2000, functionLines: 300, nesting: 6, complexity: 20 };
export const RULES = ['file-length', 'function-length', 'nesting', 'complexity'];
const MAX_WAIVER_DAYS = 180;
const CODE_FILE = /\.(?:js|mjs|cjs|ts)$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {{ key: string, startLine: number, anchorLine: number, length: number, nesting: number, complexity: number }} FunctionMeasure
 * @typedef {{ line: number, message: string }} Problem
 * @typedef {{ path: string, purpose: string, layer: string, imports: Array<string>, maxLines?: number, test: string }} Entry
 * @typedef {{
 *   files: Record<string, number>,
 *   functions: Record<string, Record<string, Record<string, number>>>,
 *   structure: { imports: Record<string, Array<string>>, tests: Array<string> },
 * }} Baseline
 * @typedef {{ key: string, was: number, now: number }} Change
 */

/**
 * @param {string} source
 * @param {string} fileName  Its extension picks the script kind.
 * @returns {ts.SourceFile}
 */
function parse(source, fileName) {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
}

/**
 * Counts lines like `wc -l`: a final newline does not start another line.
 * @param {string} source
 * @returns {number}
 */
function countLines(source) {
  if (source === '') return 0;
  const parts = source.split('\n').length;
  return source.endsWith('\n') ? parts - 1 : parts;
}

/**
 * @param {ts.Node} node
 * @returns {node is ts.FunctionLikeDeclaration}
 */
function isMeasuredFunction(node) {
  return (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isConstructorDeclaration(node)) &&
    node.body !== undefined
  );
}

/** @param {ts.PropertyName} name */
function propertyText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name)) {
    return name.text;
  }
  return '[computed]';
}

/**
 * The name an object literal goes by: its variable, or its property in another named object.
 * @param {ts.ObjectLiteralExpression} obj
 * @returns {string | undefined}
 */
function objectName(obj) {
  const parent = obj.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isPropertyAssignment(parent) && ts.isObjectLiteralExpression(parent.parent)) {
    const outer = objectName(parent.parent);
    const own = propertyText(parent.name);
    return outer ? `${outer}.${own}` : own;
  }
  return undefined;
}

/**
 * Prefixes a member name with its class or object name when it has one.
 * @param {ts.Node} container
 * @param {string} name
 */
function qualify(container, name) {
  if ((ts.isClassDeclaration(container) || ts.isClassExpression(container)) && container.name) {
    return `${container.name.text}.${name}`;
  }
  if (ts.isObjectLiteralExpression(container)) {
    const owner = objectName(container);
    return owner ? `${owner}.${name}` : name;
  }
  return name;
}

/**
 * The name a function goes by in its own scope: declared name, variable, property or class member name.
 * @param {ts.FunctionLikeDeclaration} node
 * @returns {string}
 */
function ownName(node) {
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name) return node.name.text;
  if (ts.isConstructorDeclaration(node)) return qualify(node.parent, 'constructor');
  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    return qualify(node.parent, propertyText(node.name));
  }
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
    return qualify(parent.parent, propertyText(parent.name));
  }
  return '<anonymous>';
}

/**
 * The line a waiver has to sit directly above: the start of the statement or member that holds the function.
 * @param {ts.FunctionLikeDeclaration} node
 * @param {ts.SourceFile} sf
 */
function anchorLineOf(node, sf) {
  /** @type {ts.Node} */
  let top = node;
  while (
    ts.isVariableDeclaration(top.parent) ||
    ts.isVariableDeclarationList(top.parent) ||
    ts.isVariableStatement(top.parent) ||
    ts.isPropertyAssignment(top.parent) ||
    ts.isPropertyDeclaration(top.parent) ||
    ts.isExportAssignment(top.parent)
  ) {
    top = top.parent;
  }
  return sf.getLineAndCharacterOfPosition(top.getStart(sf)).line + 1;
}

const LOGICAL_OPERATORS = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

/**
 * Whether a node opens a nesting level: if (but not the `if` of an `else if`), loops, switch and try.
 * A catch or finally block belongs to its try, and a nested function starts its own count.
 * @param {ts.Node} node
 */
function opensLevel(node) {
  if (ts.isIfStatement(node)) return !(ts.isIfStatement(node.parent) && node.parent.elseStatement === node);
  return (
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isSwitchStatement(node) ||
    ts.isTryStatement(node)
  );
}

/** @param {ts.Node} node */
function addsBranch(node) {
  return (
    ts.isIfStatement(node) ||
    ts.isConditionalExpression(node) ||
    ts.isCaseClause(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isCatchClause(node) ||
    (ts.isBinaryExpression(node) && LOGICAL_OPERATORS.has(node.operatorToken.kind))
  );
}

/**
 * Measures a source string. Function length is the lines from the first token of the function to its last. Nesting
 * is the deepest chain of control-flow statements inside the function body, a nested function not counted into its
 * parent. Complexity is 1 plus each if, ternary, case, loop, catch, `&&`, `||` and `??` (and their assignment
 * forms) in the function body, again without nested functions.
 * @param {string} source
 * @param {string} fileName
 * @returns {{ lines: number, functions: Array<FunctionMeasure> }} Functions in source order.
 */
export function measureSource(source, fileName) {
  const sf = parse(source, fileName);
  /** @type {Array<FunctionMeasure>} */
  const functions = [];
  /** @type {Map<string, number>} */
  const seen = new Map();

  /**
   * @param {ts.Node} node
   * @param {FunctionMeasure | null} fn  The function the node sits in.
   * @param {number} depth  The nesting level of the node's parent.
   * @param {string} parentKey
   */
  function visit(node, fn, depth, parentKey) {
    if (isMeasuredFunction(node)) {
      const name = ownName(node);
      const base = parentKey ? `${parentKey}>${name}` : name;
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      const key = count > 1 ? `${base}#${count}` : base;
      const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      /** @type {FunctionMeasure} */
      const own = {
        key,
        startLine: start,
        anchorLine: anchorLineOf(node, sf),
        length: end - start + 1,
        nesting: 0,
        complexity: 1,
      };
      functions.push(own);
      ts.forEachChild(node, (child) => visit(child, own, 0, key));
      return;
    }
    let level = depth;
    if (fn) {
      if (addsBranch(node)) fn.complexity += 1;
      if (opensLevel(node)) {
        level = depth + 1;
        fn.nesting = Math.max(fn.nesting, level);
      }
    }
    ts.forEachChild(node, (child) => visit(child, fn, level, parentKey));
  }

  visit(sf, null, 0, '');
  return { lines: countLines(source), functions };
}

/**
 * @typedef {{ line: number, rule: string }} Waiver
 */

const WAIVER_LINE = /^\s*\/\/\s*health:\s*(.*?)\s*$/;
const WAIVER_BODY = /^allow\s+(\S+)(?:\s+until\s+(\S+))?(?:\s+--\s*(.*))?$/;

/**
 * Reads the waiver comments of a source and judges them against the clock. A waiver needs a known rule, a
 * calendar date that is today or later and at most 180 days ahead, and a reason after `--`.
 * @param {string} source
 * @param {Date} now
 * @returns {{ waivers: Array<Waiver>, problems: Array<Problem> }}
 */
export function judgeWaivers(source, now) {
  /** @type {Array<Waiver>} */
  const waivers = [];
  /** @type {Array<Problem>} */
  const problems = [];
  const today = now.toISOString().slice(0, 10);
  const todayMs = Date.parse(today);
  source.split('\n').forEach((text, index) => {
    const line = index + 1;
    const head = WAIVER_LINE.exec(text);
    if (!head) return;
    const body = WAIVER_BODY.exec(head[1]);
    if (!body) {
      problems.push({ line, message: 'malformed waiver, write: health: allow <rule> until <YYYY-MM-DD> -- <why>' });
      return;
    }
    const [, rule, until, why] = body;
    if (!RULES.includes(rule)) {
      problems.push({ line, message: `unknown rule "${rule}", the rules are ${RULES.join(', ')}` });
      return;
    }
    if (until === undefined) {
      problems.push({ line, message: 'waiver has no "until <YYYY-MM-DD>"' });
      return;
    }
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(until) && new Date(until).toISOString().slice(0, 10) === until;
    if (!valid) {
      problems.push({ line, message: `"${until}" is not a calendar date, write YYYY-MM-DD` });
      return;
    }
    if (why === undefined || why.trim() === '') {
      problems.push({ line, message: 'waiver has no reason after "--"' });
      return;
    }
    if (until < today) {
      problems.push({ line, message: `waiver expired on ${until}` });
      return;
    }
    if ((Date.parse(until) - todayMs) / DAY_MS > MAX_WAIVER_DAYS) {
      problems.push({
        line,
        message: `waiver runs past ${MAX_WAIVER_DAYS} days, pick a date up to ${MAX_WAIVER_DAYS} days ahead`,
      });
      return;
    }
    waivers.push({ line, rule });
  });
  return { waivers, problems };
}

/**
 * Finds what a file offends: its length, and the functions over a limit, minus what a valid waiver exempts.
 * Also returns the waiver problems, including a waiver that sits where it exempts nothing.
 * @param {string} source
 * @param {string} fileName
 * @param {Date} now
 * @param {{ maxLines?: number }} [options]  `maxLines` replaces the default file limit.
 * @returns {{ lines?: number, functions: Record<string, Record<string, number>>, problems: Array<Problem> }}
 */
export function findOffenders(source, fileName, now, options = {}) {
  const measure = measureSource(source, fileName);
  const { waivers, problems } = judgeWaivers(source, now);
  const sf = parse(source, fileName);
  const firstStatement = sf.statements[0];
  const firstLine = firstStatement
    ? sf.getLineAndCharacterOfPosition(firstStatement.getStart(sf)).line + 1
    : Number.POSITIVE_INFINITY;
  const waiverLines = new Set(
    source
      .split('\n')
      .map((text, i) => (WAIVER_LINE.test(text) ? i + 1 : 0))
      .filter((n) => n > 0)
  );

  let fileWaived = false;
  /** @type {Map<string, Set<string>>} */
  const waivedFunctions = new Map();
  for (const waiver of waivers) {
    if (waiver.rule === 'file-length') {
      if (waiver.line < firstLine) fileWaived = true;
      else problems.push({ line: waiver.line, message: 'a file-length waiver belongs at the top of the file' });
      continue;
    }
    let below = waiver.line + 1;
    while (waiverLines.has(below)) below += 1;
    const target = measure.functions.find((f) => f.anchorLine === below);
    if (!target) {
      problems.push({ line: waiver.line, message: 'waiver is not directly above a function' });
      continue;
    }
    const set = waivedFunctions.get(target.key) ?? new Set();
    set.add(waiver.rule);
    waivedFunctions.set(target.key, set);
  }

  /** @type {{ lines?: number, functions: Record<string, Record<string, number>>, problems: Array<Problem> }} */
  const result = { functions: {}, problems: problems.sort((a, b) => a.line - b.line) };
  if (!fileWaived && measure.lines > (options.maxLines ?? LIMITS.fileLines)) result.lines = measure.lines;
  for (const fn of measure.functions) {
    const waived = waivedFunctions.get(fn.key);
    /** @type {Record<string, number>} */
    const over = {};
    if (fn.length > LIMITS.functionLines && !waived?.has('function-length')) over['function-length'] = fn.length;
    if (fn.nesting > LIMITS.nesting && !waived?.has('nesting')) over['nesting'] = fn.nesting;
    if (fn.complexity > LIMITS.complexity && !waived?.has('complexity')) over['complexity'] = fn.complexity;
    if (Object.keys(over).length > 0) result.functions[fn.key] = over;
  }
  return result;
}

/**
 * Flattens a baseline to one number per recorded fact, so two baselines compare by key.
 * @param {Baseline} baseline
 * @returns {Map<string, number>}
 */
function flatten(baseline) {
  /** @type {Map<string, number>} */
  const flat = new Map();
  for (const [file, lines] of Object.entries(baseline.files)) flat.set(`file-length ${file}`, lines);
  for (const [file, fns] of Object.entries(baseline.functions)) {
    for (const [fn, rules] of Object.entries(fns)) {
      for (const [rule, value] of Object.entries(rules)) flat.set(`${rule} ${file} ${fn}`, value);
    }
  }
  for (const [file, targets] of Object.entries(baseline.structure.imports)) {
    for (const target of targets) flat.set(`import ${file} imports ${target}`, 1);
  }
  for (const file of baseline.structure.tests) flat.set(`missing test ${file}`, 1);
  return flat;
}

/**
 * Compares the current findings with the baseline.
 * @param {Baseline} baseline
 * @param {Baseline} current
 * @returns {{ grew: Array<Change>, shrank: Array<Change> }} Both sorted by key. A fact the baseline lacks counts
 *   as growth from 0, a fact gone from the current findings as shrinkage to 0.
 */
export function compareToBaseline(baseline, current) {
  const was = flatten(baseline);
  const now = flatten(current);
  /** @type {Array<Change>} */
  const grew = [];
  /** @type {Array<Change>} */
  const shrank = [];
  for (const key of [...new Set([...was.keys(), ...now.keys()])].sort()) {
    const before = was.get(key) ?? 0;
    const after = now.get(key) ?? 0;
    if (after > before) grew.push({ key, was: before, now: after });
    else if (after < before) shrank.push({ key, was: before, now: after });
  }
  return { grew, shrank };
}

/**
 * The npm package a bare specifier names, or the `node:` form of a built-in.
 * @param {string} specifier
 */
function packageOf(specifier) {
  if (specifier.startsWith('node:')) return specifier;
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  if (builtinModules.includes(name)) return `node:${specifier}`;
  return name;
}

/**
 * The static `import` and `export from` specifiers and the literal `import('x')` calls of a source, resolved: a
 * relative one to a repository path, a bare one to its package name, a built-in to `node:<name>`.
 * @param {string} source
 * @param {string} fromPath  The repository path of the file, with forward slashes.
 * @returns {Array<string>} Sorted and unique.
 */
export function findImports(source, fromPath) {
  const sf = parse(source, fromPath);
  /** @type {Set<string>} */
  const targets = new Set();
  /** @param {string} specifier */
  const add = (specifier) => {
    if (specifier.startsWith('.')) targets.add(path.posix.join(path.posix.dirname(fromPath), specifier));
    else if (!specifier.startsWith('/') && !specifier.startsWith('file:') && !specifier.startsWith('data:')) {
      targets.add(packageOf(specifier));
    }
  };
  /** @param {ts.Node} node */
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      add(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return [...targets].sort();
}

/**
 * Whether a manifest pattern covers a repository path. A pattern ending in `/` is a folder and covers everything
 * under it. Otherwise `*` matches within one path segment, `**` across segments, and the rest is literal.
 * @param {string} pattern
 * @param {string} target
 */
function matchesPattern(pattern, target) {
  if (pattern.endsWith('/')) return target.startsWith(pattern);
  if (!pattern.includes('*')) return pattern === target;
  const source = pattern
    .split('**')
    .map((part) => part.split('*').map(escapeRegExp).join('[^/]*'))
    .join('.*');
  return new RegExp(`^${source}$`).test(target);
}

/** @param {string} text */
function escapeRegExp(text) {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * How specific a pattern is: the count of its literal characters. A folder counts its whole length.
 * @param {string} pattern
 */
function specificity(pattern) {
  return pattern.replaceAll('*', '').length;
}

/**
 * The manifest entry for a repository path: the most specific pattern that covers it, the first on a tie.
 * @param {Array<Entry>} entries
 * @param {string} filePath
 * @returns {Entry | undefined}
 */
export function matchEntry(entries, filePath) {
  /** @type {Entry | undefined} */
  let best;
  for (const entry of entries) {
    if (!matchesPattern(entry.path, filePath)) continue;
    if (!best || specificity(entry.path) > specificity(best.path)) best = entry;
  }
  return best;
}

/**
 * Whether an import target is allowed from an entry: a file of the same entry, a `node:` built-in under the
 * pattern `node:*`, or a target one of the entry's `imports` patterns covers.
 * @param {Entry} entry
 * @param {Array<Entry>} entries
 * @param {string} target
 */
function importAllowed(entry, entries, target) {
  if (matchEntry(entries, target) === entry) return true;
  return entry.imports.some((pattern) =>
    pattern === 'node:*' ? target.startsWith('node:') : matchesPattern(pattern, target)
  );
}

/**
 * The test names that count for a module: the name of the file with any tail of its folder path, joined by hyphens.
 * @param {string} filePath
 * @returns {Array<string>}
 */
function testNamesFor(filePath) {
  const parts = filePath.replace(/\.[^.]+$/, '').split('/');
  return parts.map((_, i) => `tests/${parts.slice(i).join('-')}.test.`);
}

/**
 * Checks the tracked tree against the manifest.
 * @param {Array<Entry>} entries
 * @param {Record<string, { source: string }>} files  Repository path to file content.
 * @returns {{ unmatched: Array<string>, local: Array<string>, imports: Record<string, Array<string>>, missingTests: Array<string> }}
 */
export function checkStructure(entries, files) {
  /** @type {Array<string>} */
  const unmatched = [];
  /** @type {Array<string>} */
  const local = [];
  /** @type {Record<string, Array<string>>} */
  const imports = {};
  /** @type {Array<string>} */
  const missingTests = [];
  const testFiles = Object.keys(files).filter((p) => /^tests\/.+\.test\.(?:js|mjs|ts)$/.test(p));

  for (const filePath of Object.keys(files).sort()) {
    const entry = matchEntry(entries, filePath);
    if (!entry) {
      unmatched.push(filePath);
      continue;
    }
    if (entry.layer === 'local') {
      local.push(filePath);
      continue;
    }
    if (!CODE_FILE.test(filePath)) continue;
    const breaches = findImports(files[filePath].source, filePath).filter((t) => !importAllowed(entry, entries, t));
    if (breaches.length > 0) imports[filePath] = breaches;
    if (entry.test === 'required' && !filePath.startsWith('tests/')) {
      const names = testNamesFor(filePath);
      if (!testFiles.some((t) => names.some((n) => t.startsWith(n)))) missingTests.push(filePath);
    }
  }
  return { unmatched, local, imports, missingTests };
}

/**
 * Renders docs/structure.md from the manifest.
 * @param {Array<Entry>} entries
 * @returns {string}
 */
export function renderStructureDoc(entries) {
  const rows = entries.map((e) => {
    const imports = e.imports.length > 0 ? e.imports.map((i) => `\`${i}\``).join(', ') : 'nothing';
    return `| \`${e.path}\` | ${e.layer} | ${e.purpose} | ${imports} | ${e.test} |`;
  });
  return [
    '<!-- Generated from structure.json by `node tools/code-health.mjs --docs`. Do not edit by hand. -->',
    '',
    '# Repository structure',
    '',
    'Every folder and file pattern of the tracked tree has a purpose, a layer, a list of what its files may import and a rule on whether its modules need a test. Anyone who adds a file or an import checks the row that covers it. `npm run health` fails when a tracked file matches no row, when an import falls outside its row, and when a module in a row marked `required` has no test. When two rows cover a file, the more specific one applies. Files in a `local` row exist only in a deployment and are never tracked.',
    '',
    '| Path | Layer | Purpose | May import | Test |',
    '|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

/**
 * @param {unknown} x
 * @returns {x is Array<unknown>}
 */
function isList(x) {
  return Array.isArray(x);
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function sortKeys(value) {
  if (isList(value)) return value;
  if (value && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const sorted = {};
    for (const key of Object.keys(value).sort())
      sorted[key] = sortKeys(/** @type {Record<string, unknown>} */ (value)[key]);
    return sorted;
  }
  return value;
}

/** @param {Baseline} baseline */
function stringifyBaseline(baseline) {
  return JSON.stringify(sortKeys(baseline), null, 2) + '\n';
}

/** @returns {Array<Entry>} */
function loadManifest() {
  /** @type {unknown} */
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const entries =
    parsed && typeof parsed === 'object' ? /** @type {{ entries?: unknown }} */ (parsed).entries : undefined;
  if (!isList(entries)) throw new Error('structure.json needs an "entries" array');
  for (const raw of /** @type {Array<Record<string, unknown>>} */ (entries)) {
    const ok =
      typeof raw.path === 'string' &&
      typeof raw.purpose === 'string' &&
      (raw.layer === 'public' || raw.layer === 'local') &&
      Array.isArray(raw.imports) &&
      (raw.test === 'required' || raw.test === 'none');
    if (!ok) throw new Error(`structure.json has a malformed entry: ${JSON.stringify(raw)}`);
  }
  return /** @type {Array<Entry>} */ (entries);
}

/** @returns {Array<string>} */
function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\0').filter((p) => p !== '' && fs.existsSync(path.join(root, p)));
}

/** @returns {Baseline | null} */
function loadBaseline() {
  if (!fs.existsSync(baselinePath)) return null;
  /** @type {unknown} */
  const parsed = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  return /** @type {Baseline} */ (parsed);
}

/** @param {Array<Change>} changes */
function listChanges(changes) {
  return changes.map((c) => `  ${c.key}: ${c.was} -> ${c.now}`).join('\n');
}

/**
 * Writes docs/structure.md, or checks that it matches what would be written.
 * @param {boolean} write
 * @param {string} docText
 * @returns {number} The exit code.
 */
function runDocs(write, docText) {
  if (write) {
    fs.writeFileSync(docPath, docText);
    console.log('docs/structure.md written');
    return 0;
  }
  const current = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8') : '';
  if (current === docText) return 0;
  console.error('docs/structure.md differs from structure.json, run: node tools/code-health.mjs --docs');
  return 1;
}

/** @param {Array<string>} args */
function main(args) {
  const entries = loadManifest();
  const docText = renderStructureDoc(entries);
  if (args.includes('--docs') || args.includes('--check-docs')) return runDocs(args.includes('--docs'), docText);

  const now = new Date();
  const paths = trackedFiles();
  /** @type {Record<string, { source: string }>} */
  const files = {};
  for (const p of paths) {
    files[p] = { source: CODE_FILE.test(p) ? fs.readFileSync(path.join(root, p), 'utf8') : '' };
  }

  /** @type {Baseline} */
  const current = { files: {}, functions: {}, structure: { imports: {}, tests: [] } };
  /** @type {Array<string>} */
  const failures = [];
  for (const p of paths.filter((f) => CODE_FILE.test(f))) {
    const entry = matchEntry(entries, p);
    const found = findOffenders(files[p].source, p, now, { maxLines: entry?.maxLines });
    if (found.lines !== undefined) current.files[p] = found.lines;
    if (Object.keys(found.functions).length > 0) current.functions[p] = found.functions;
    for (const problem of found.problems) failures.push(`${p}:${problem.line}: ${problem.message}`);
  }
  const structure = checkStructure(entries, files);
  for (const p of structure.unmatched) failures.push(`${p}: tracked file matches no entry of structure.json`);
  for (const p of structure.local) failures.push(`${p}: tracked file sits in a local-layer entry of structure.json`);
  current.structure = { imports: structure.imports, tests: structure.missingTests };

  if (failures.length > 0) {
    console.error(`code health failed:\n${failures.map((f) => `  ${f}`).join('\n')}`);
    return 1;
  }

  const baseline = loadBaseline();
  const { grew, shrank } = compareToBaseline(
    baseline ?? { files: {}, functions: {}, structure: { imports: {}, tests: [] } },
    current
  );
  if (args.includes('--update')) {
    if (baseline && grew.length > 0) {
      console.error(`The baseline may only shrink, refusing to record growth:\n${listChanges(grew)}`);
      return 1;
    }
    fs.writeFileSync(baselinePath, stringifyBaseline(current));
    console.log(`code-health-baseline.json written: ${summary(current)}`);
    return 0;
  }
  if (!baseline) {
    console.error('code-health-baseline.json is missing, run: npm run health:update');
    return 1;
  }
  if (grew.length > 0) {
    console.error(`Code health got worse (${grew.length} facts):\n${listChanges(grew)}`);
    return 1;
  }
  if (shrank.length > 0) {
    console.error(
      `The baseline shrank (${shrank.length} facts), run \`npm run health:update\` to record it:\n${listChanges(shrank)}`
    );
    return 1;
  }
  console.log(`code health matches the baseline: ${summary(current)}`);
  return 0;
}

/** @param {Baseline} b */
function summary(b) {
  const fns = Object.values(b.functions).reduce((n, f) => n + Object.keys(f).length, 0);
  const imports = Object.values(b.structure.imports).reduce((n, t) => n + t.length, 0);
  return `${Object.keys(b.files).length} long files, ${fns} offending functions, ${imports} import breaches, ${b.structure.tests.length} modules without a test`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
