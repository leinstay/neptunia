// The gate of plan 2026-11-05 T.4 and B0.2: a function takes `placeId` alone. A channel, a thread and a DM are places, so
// no core type and no signature carries the top of the tree beside the conversation: a channel has exactly one server,
// and carrying both only lets them disagree. Code that needs the top calls `store.rootPlaceOf(placeId)` once inside.
//
// The scan parses every TypeScript file of the active tree with the compiler and reports a shape whose siblings name a
// top and a conversation: an object type, an interface, a destructured parameter, or one parameter list. The top is
// `placeId` or `rootId` beside `conversationId`, or `rootId` beside a conversation's own `id`. Native ids stay only at the
// protocol boundary with the interfaces and in the modules that name a native conversation as a place. So `interfaces/`,
// the shipped migrations and the entries of BOUNDARY are exempt; an entry is a whole file, or `file#Type` for one
// declared type and the shapes nested in it. A new entry needs a reviewer to add it here, because the implementer of a
// slice cannot edit this file.
//
// At `c0b071e0` the scan finds 25 shapes with a top beside a conversation id and 13 conversations that carry their top.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ACTIVE_ROOTS = ['src', 'bin', 'cli', 'interfaces', 'agents'];

/** A pair of sibling names the gate refuses: any of `top` beside any of `conversation`. */
type Pair = { top: ReadonlyArray<string>; conversation: ReadonlyArray<string> };
const TOP_BESIDE_CONVERSATION: Pair = { top: ['placeId', 'rootId'], conversation: ['conversationId'] };
const CONVERSATION_WITH_ITS_TOP: Pair = { top: ['rootId'], conversation: ['id'] };

const BOUNDARY = [
  // The conversation as the wire carries it from the interfaces.
  'src/protocol/events.ts#Conversation',
  'src/interface/neptunia-cli.ts#CommandEvent',
  // Where a native conversation becomes a place.
  'src/memory/addresses.ts',
  'src/memory/store-addresses.ts',
  'src/memory/db/observe-event.ts',
];

const exemptFile = (file: string): boolean =>
  file.startsWith('interfaces/') || file.startsWith('src/memory/migration/') || BOUNDARY.includes(file);

function walk(dir: string, found: Array<string> = []): Array<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, found);
    else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) found.push(relative(ROOT, full).split('\\').join('/'));
  }
  return found;
}

const nameText = (name: ts.Node | undefined): string | null =>
  name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : null;

/** The sibling names a node declares, when it is a shape the gate looks at; null otherwise. */
function siblingNames(node: ts.Node): Array<string> | null {
  const named = (names: Array<string | null>): Array<string> => names.filter((name) => name !== null);
  if (ts.isTypeLiteralNode(node) || ts.isInterfaceDeclaration(node))
    return named(node.members.map((member) => nameText(member.name)));
  if (ts.isObjectBindingPattern(node))
    return named(node.elements.map((element) => nameText(element.propertyName ?? element.name)));
  if (ts.isFunctionLike(node)) return named(node.parameters.map((parameter) => nameText(parameter.name)));
  return null;
}

/** The named type alias or interface a shape is declared in, at any depth; null outside one. */
function declaredName(node: ts.Node): string | null {
  for (let at: ts.Node | undefined = node; at; at = at.parent) {
    if (ts.isInterfaceDeclaration(at) || ts.isTypeAliasDeclaration(at)) return at.name.text;
  }
  return null;
}

const holds = (names: ReadonlyArray<string>, pair: Pair): boolean =>
  pair.top.some((name) => names.includes(name)) && pair.conversation.some((name) => names.includes(name));

/** Every shape of a source text that holds the pair, as `file:line Kind`, with the entries of BOUNDARY left out. */
function shapesIn(file: string, text: string, pair: Pair, boundary: ReadonlyArray<string> = BOUNDARY): Array<string> {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: Array<string> = [];
  const visit = (node: ts.Node): void => {
    const names = siblingNames(node);
    const declared = declaredName(node);
    if (names && holds(names, pair) && !(declared && boundary.includes(`${file}#${declared}`))) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      found.push(`${file}:${line + 1} ${ts.SyntaxKind[node.kind]}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function shapesInTree(pair: Pair): Array<string> {
  const out: Array<string> = [];
  for (const root of ACTIVE_ROOTS) {
    for (const file of walk(join(ROOT, root))) {
      if (exemptFile(file)) continue;
      out.push(...shapesIn(file, readFileSync(join(ROOT, file), 'utf8'), pair));
    }
  }
  return out;
}

test('the scan sees a top beside a conversation in each kind of shape, and only as siblings', () => {
  // Bug: the gate goes green because its parser stopped seeing a kind of shape, not because the shapes are gone.
  const probe = [
    'type A = { placeId: string; conversationId: string };',
    'interface B { placeId?: string | null; conversationId: string }',
    'function c({ placeId, conversationId }: Record<string, string>) {}',
    'const d = (placeId: string, conversationId: string) => 0;',
    'type E = { rootId: string; conversationId: string };',
    'type F = { placeId: string; inner: { conversationId: string } };',
  ].join('\n');
  const lines = shapesIn('probe.ts', probe, TOP_BESIDE_CONVERSATION).map((hit) => Number(/:(\d+) /.exec(hit)?.[1]));
  assert.deepEqual([...new Set(lines)], [1, 2, 3, 4, 5]);
});

test('a boundary entry of one type exempts that type and no other in its file', () => {
  // Bug: `file#Type` exempts the whole file, and a new shape beside the protocol's conversation type passes unseen.
  const probe = 'type Wire = { id: string; rootId: string };\ntype Core = { id: string; rootId: string };';
  const hits = shapesIn('p.ts', probe, CONVERSATION_WITH_ITS_TOP, ['p.ts#Wire']);
  assert.deepEqual(hits, ['p.ts:2 TypeLiteral']);
});

test('no core type or signature carries a top place beside a conversation id', () => {
  // Bug: a shape keeps the top place and the channel side by side, a caller fills one from another turn, and the lore,
  // the notes or the GIFs of one server are written or read under another.
  const shapes = shapesInTree(TOP_BESIDE_CONVERSATION);
  assert.deepEqual(shapes, [], `${shapes.length} shapes:\n${shapes.join('\n')}`);
});

test('no core conversation carries the native id of its top', () => {
  // Bug: a native `{ id, rootId }` travels through the turn past the protocol, and code reads the server from `rootId`
  // instead of asking `rootPlaceOf`, so a thread or a DM answers with a top the store does not hold.
  const shapes = shapesInTree(CONVERSATION_WITH_ITS_TOP);
  assert.deepEqual(shapes, [], `${shapes.length} shapes:\n${shapes.join('\n')}`);
});

test('every boundary entry names a file that exists and still holds a shape', () => {
  // Bug: a boundary file is cleaned or moved and its exemption stays, so a new shape there passes unseen.
  const idle = BOUNDARY.filter((entry) => {
    const [file] = entry.split('#');
    let text: string;
    try {
      text = readFileSync(join(ROOT, file), 'utf8');
    } catch {
      return true;
    }
    const others = BOUNDARY.filter((other) => other !== entry);
    return [TOP_BESIDE_CONVERSATION, CONVERSATION_WITH_ITS_TOP].every(
      (pair) => shapesIn(file, text, pair, others).length === 0
    );
  });
  assert.deepEqual(idle, [], `idle entries:\n${idle.join('\n')}`);
});
