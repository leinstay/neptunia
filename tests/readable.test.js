// Tests for src/web/readable.js: the hand-written HTML-to-text used when the
// persona reads a linked page -- scope choice (article/main over body),
// boilerplate and raw-text elements dropped, entities, block newlines,
// whitespace collapse, the word-boundary cut, malformed input and the page
// title.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, pageTitle, truncateText } from '../src/web/readable.js';

test('htmlToText: the article is preferred over the rest of the body', () => {
  const html =
    '<html><body><div>Sidebar junk</div><article><p>The real story.</p></article><div>More junk</div></body></html>';
  assert.equal(htmlToText(html), 'The real story.');
});

test('htmlToText: the largest of several article/main elements wins', () => {
  const html =
    '<body><article>Short teaser.</article><main><p>A much longer main text that carries the page.</p></main></body>';
  assert.equal(htmlToText(html), 'A much longer main text that carries the page.');
});

test('htmlToText: without article/main the body is used, the head is not', () => {
  const html =
    '<html><head><title>Page title</title><meta charset="utf-8"></head><body><p>Body text.</p></body></html>';
  assert.equal(htmlToText(html), 'Body text.');
});

test('htmlToText: nav, header, footer, aside and form contents are dropped, nested ones too', () => {
  const html =
    '<body><header><nav>Home <nav>Deep</nav> About</nav>Logo</header>' +
    '<p>Content.</p><aside>Related</aside><form><input> Search</form><footer>Copyright</footer></body>';
  assert.equal(htmlToText(html), 'Content.');
});

test('htmlToText: script, style, noscript, template, svg and comments are dropped', () => {
  const html =
    '<body><script>var a = "<p>no</p>";</script><style>p { color: red }</style>' +
    '<noscript>Enable it</noscript><template><p>tpl</p></template><svg><text>icon</text></svg>' +
    '<!-- a comment <p>hidden</p> --><p>Visible.</p><SCRIPT type="x">upper</SCRIPT ></body>';
  assert.equal(htmlToText(html), 'Visible.');
});

test('htmlToText: named and numeric entities are decoded', () => {
  const html = '<p>a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; f&nbsp;g &#937;&#x3B1; caf&eacute; &unknown;</p>';
  assert.equal(htmlToText(html), 'a & b <c> "d" \'e\' f g \u03a9\u03b1 caf\u00e9 &unknown;');
});

test('htmlToText: a decoded tag-like entity stays text', () => {
  assert.equal(htmlToText('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>'), '<script>alert(1)</script>');
});

test('htmlToText: block-level tags become line breaks, inline tags do not', () => {
  const html = '<h1>Title</h1><p>First <b>bold</b> para.</p><ul><li>one</li><li>two</li></ul>line<br>next';
  assert.equal(htmlToText(html), 'Title\n\nFirst bold para.\n\none\n\ntwo\n\nline\nnext');
});

test('htmlToText: whitespace collapses to single spaces and at most one blank line', () => {
  const html = '<div>  lots\n\n of   \t space  </div>\n\n<div></div><div></div><div></div><p>after</p>';
  assert.equal(htmlToText(html), 'lots of space\n\nafter');
});

test('htmlToText: a long text is cut on a word boundary with an ellipsis', () => {
  const html = '<p>alpha beta gamma delta epsilon</p>';
  const out = htmlToText(html, { maxChars: 20 });
  assert.equal(out, 'alpha beta gamma\u2026');
  assert.ok(Array.from(out).length <= 20);
});

test('htmlToText: a cut never splits a surrogate pair', () => {
  const out = truncateText('\u{1F600}\u{1F600}\u{1F600}\u{1F600}', 3);
  assert.equal(out, '\u{1F600}\u{1F600}\u2026');
});

test('htmlToText: malformed HTML never throws and keeps the readable text', () => {
  const cases = [
    '<p>unclosed <b>bold <i>italic',
    '<div class="a>b">quoted gt</div>',
    'a < b and c > d',
    "<p title=it's>apostrophe</p>",
    '<script>never closed',
    '<!-- never closed',
    '<',
    '</p></div>stray closes',
    '<header>unclosed header, the only text',
  ];
  const expected = [
    'unclosed bold italic',
    'quoted gt',
    'a < b and c > d',
    'apostrophe',
    '',
    '',
    '<',
    'stray closes',
    'unclosed header, the only text',
  ];
  cases.forEach((html, i) => assert.equal(htmlToText(html), expected[i], `case ${i}`));
  for (const bad of [null, undefined, 42, {}]) assert.equal(typeof htmlToText(bad), 'string');
});

test('htmlToText: control characters and byte-order marks are removed', () => {
  assert.equal(htmlToText('\ufeff<p>a&#x1F;b\u0007c</p>'), 'abc');
});

test('pageTitle: the title element, entities decoded and whitespace collapsed', () => {
  assert.equal(
    pageTitle('<head><title>\n  Caf&eacute;   &amp; \u03b1\u03b2\u03b3 </title></head>'),
    'Caf\u00e9 & \u03b1\u03b2\u03b3'
  );
});

test('pageTitle: og:title when the title element is missing or empty, attributes in any order', () => {
  assert.equal(pageTitle('<meta content="Open &amp; Graph" property="og:title">'), 'Open & Graph');
  assert.equal(pageTitle("<title> </title><meta property='og:title' content='Second'>"), 'Second');
});

test('pageTitle: null when there is no title at all', () => {
  assert.equal(pageTitle('<p>nothing</p>'), null);
  assert.equal(pageTitle(null), null);
});

test('pageTitle: a title with attributes, an uppercase tag and a spaced closing tag', () => {
  assert.equal(pageTitle('<TITLE lang="en">Upper</TITLE >'), 'Upper');
  assert.equal(pageTitle('<titles>no</titles><title>Real</title>'), 'Real');
});

test('pageTitle: an unclosed title falls through to og:title, a meta with a quoted > still parses', () => {
  assert.equal(pageTitle('<title>never closed <meta property="og:title" content="Fallback">'), 'Fallback');
  assert.equal(pageTitle('<meta name="x" content="a > b"><meta name="og:title" content=\'Q &gt; R\'>'), 'Q > R');
  assert.equal(pageTitle('<meta property=og:title content=Bare>'), 'Bare');
});

test('pageTitle: only the first 64 KB of the document are looked at', () => {
  const pad = `<p>${'x'.repeat(70 * 1024)}</p>`;
  assert.equal(pageTitle(`${pad}<title>Late</title>`), null);
  assert.equal(pageTitle(`<title>Early</title>${pad}`), 'Early');
});

test('readable: pageTitle and htmlToText stay linear on 1.5 MB of unclosed title or meta tags', () => {
  const size = 1.5 * 1024 * 1024;
  for (const unit of ['<title>', '<meta ', '<meta a="', "<title x='", '<meta ' + 'a'.repeat(50)]) {
    const page = unit.repeat(Math.ceil(size / unit.length));
    for (const [name, fn] of [
      ['pageTitle', pageTitle],
      ['htmlToText', htmlToText],
    ]) {
      const started = process.hrtime.bigint();
      fn(page);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      assert.ok(ms < 500, `${name} on repeated ${JSON.stringify(unit.slice(0, 12))}: ${ms.toFixed(0)} ms`);
    }
  }
});
