// render-fast: a small, dependency-free Markdown renderer whose output is
// byte-identical to marked 18.1.3 with default options (gfm, no breaks,
// no pedantic), tuned to spend less CPU than marked itself.
//
// Shape of the implementation:
//   1. a block pass that walks the source once, dispatching on the first
//      character of each position so irrelevant block constructs are never
//      probed;
//   2. link reference definitions are collected during that pass;
//   3. an inline pass per block that first builds a "masked" copy of the
//      text (code spans and resolvable link labels neutralised) so the
//      emphasis scanner cannot see delimiters it must ignore, then scans
//      left to right dispatching on the current character;
//   4. a renderer that walks the token tree emitting HTML strings.
//
// No state survives a parse() call: every call builds fresh tables.

// ---------------------------------------------------------------- helpers

// Expand tabs the way the reference does: a tab advances the column to the
// next multiple of four, counting from `base` columns already consumed.
function expandTabs(text, base = 0) {
  if (!text.includes('\t')) return text;
  let col = base, out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\t') {
      const n = 4 - (col % 4);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// Strip trailing `ch` characters (used for the "\n" at the end of a raw
// block). When `invert` is set, strip everything that is NOT `ch`.
function trimEndChar(s, ch, invert = false) {
  let n = s.length, cut = 0;
  while (cut < n) {
    const c = s.charAt(n - cut - 1);
    if ((c === ch) !== invert) cut++;
    else break;
  }
  return cut ? s.slice(0, n - cut) : s;
}

// Drop trailing blank lines from a raw HTML block, but only when there are
// at least two of them (a single trailing blank line stays part of the raw).
function trimHtmlRaw(raw) {
  if (!raw.includes('\n')) return raw;
  const lines = raw.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && /^[ \t]*$/.test(lines[end])) end--;
  return lines.length - end <= 2 ? raw : lines.slice(0, end + 1).join('\n');
}

// Normalise a link label for lookup: trim, collapse whitespace runs to a
// single space, fold case (via the lower->upper->lower round trip the
// reference uses so special foldings agree).
function labelKey(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Find the matching closer for a bracket pair in `s`, honouring backslash
// escapes. Returns the index of the unmatched closer, -1 when neither
// bracket occurs, or -2 when an opener is left unclosed.
function bracketBalance(s, pair) {
  const open = pair[0], close = pair[1];
  if (!s.includes(open) && !s.includes(close)) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') i++;
    else if (c === open) depth++;
    else if (c === close && --depth < 0) return i;
  }
  return depth > 0 ? -2 : -1;
}

// ------------------------------------------------------------ HTML escape

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeAllRe = /[&<>"']/g;
const escapeKeepEntitiesRe = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Escape for HTML output. With `encode` true every special char is escaped;
// otherwise an `&` that already begins a character reference is left alone.
function escHtml(s, encode = false) {
  if (encode) return /[&<>"']/.test(s) ? s.replace(escapeAllRe, (c) => ESCAPES[c]) : s;
  return /[<>"']|&/.test(s) ? s.replace(escapeKeepEntitiesRe, (c) => ESCAPES[c]) : s;
}

// Inline text post-processing: numeric character references are decoded to
// their code point (with the reference's replacement rules). A stray `&`
// that merely looks like the start of a numeric reference but is not one
// becomes `&amp;` here; named references pass through untouched.
const numericRefRe = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const numericRefOrAmpRe = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function decodeNumericRefs(s) {
  if (!numericRefRe.test(s)) return s;
  return s.replace(numericRefOrAmpRe, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}

// Clean a link destination the way the reference does: percent-encode via
// encodeURI, then undo the encoding of a literal "%" ("%25" back to "%").
// Returns null when encodeURI throws (lone surrogates) — the caller then
// drops the link wrapper and keeps only its text.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Split a table row into cells. Escaped pipes (\|) do not split; a pipe
// preceded by an even number of backslashes does. The row is rewritten so
// unescaped pipes become " |" (the split marker) before splitting.
function splitRow(row, cellCount) {
  const marked = row.replace(/\|/g, (m, offset, whole) => {
    let odd = false, p = offset;
    while (--p >= 0 && whole[p] === '\\') odd = !odd;
    return odd ? '|' : ' |';
  });
  const cells = marked.split(/ \|/);
  if (cells.length && !cells[0].trim()) cells.shift();
  if (cells.length && !cells[cells.length - 1].trim()) cells.pop();
  if (cellCount !== undefined) {
    if (cells.length > cellCount) cells.length = cellCount;
    while (cells.length < cellCount) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// ------------------------------------------------------- block patterns
// The patterns below state the block grammar. They are anchored at the
// current position and tried only when the first character makes the
// construct plausible (see the dispatch in lexBlocks).

const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

const reBlankRun = /^(?:[ \t]*(?:\n|$))+/;
const reIndented = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const reFence = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const reAtx = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const reThematic = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const reQuoteStart = /^ {0,3}>/;
const reListStart = /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/;
const reHtmlBlock = new RegExp(
  '^ {0,3}(?:' +
  '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)' +
  '|<!--(?:-?>|[\\s\\S]*?(?:-->|$))[^\\n]*(\\n+|$)' +
  '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)' +
  '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)' +
  '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)' +
  '|<\\/?(' + BLOCK_TAGS + ')(?:[ \\t]+|\\n|\\/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)' +
  '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\\w.:-]*(?: *= *"[^"\\n]*"| *= *\'[^\'\\n]*\'| *= *[^\\s"\'=<>`]+)?)*? *\\/?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)' +
  '|<\\/[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)' +
  ')', 'i');
const reDefLabel = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const reDefTitle = /(?:\"(?:\\[\s\S]|[^\"\\])*\"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/;
const reDef = new RegExp('^ {0,3}\\[(' + reDefLabel.source + ')\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(' + reDefTitle.source + '))? *(?:\\n+|$)');
// What can interrupt a paragraph: a thematic break, ATX heading,
// blockquote, fence, list starting with a bullet or "1." / "1)", an HTML
// block start, or a line ending in two or more spaces (which ends the
// paragraph's last line in the reference's line model).
const INTERRUPT =
  ' {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)' +
  '| {0,3}#{1,6}(?:\\s|$)' +
  '| {0,3}>' +
  '| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)' +
  '| {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]' +
  '| {0,3}(?:<\\/?(?:' + BLOCK_TAGS + ')(?: +|\\n|\\/?>)' +
  '|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)' +
  '|<\\?|<![A-Za-z]|<!\\[CDATA\\[)' +
  '|[ \\t]+\\n';
// reParagraph is built after reTable below: a paragraph line also ends
// when a complete table starts at that line.
// Setext heading: text lines (none starting another block construct, no
// blank line inside) followed by an = or - underline. The GFM variant also
// refuses table-delimiter lines as first line, content lines and
// interrupting lines.
const SETEXT_STOP =
  ' {0,3}(?:[*+-]|\\d{1,9}[.)]) |(?: {4}| {0,3}\\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\\s|$)| {0,3}<[^\\n>]+>\\n| {0,3}\\|?(?:[:\\- ]*\\|)+[:\\- ]*\\n';
const SETEXT_CONT =
  ' {0,3}(?:[*+-]|\\d{1,9}[.)]) | {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\\s|$)| {0,3}<[^\\n>]+>\\n| {0,3}\\|?(?:[:\\- ]*\\|)+[:\\- ]*\\n';
const reSetext = new RegExp(
  '^(?!' + SETEXT_STOP + ')((?:.|\\n(?!\\s*?\\n|' + SETEXT_CONT +
  '| {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)' +
  '| {0,3}<[^\\n>]+>\\n| {0,3}\\|?(?:[:\\- ]*\\|)+[:\\- ]*\\n))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)');
const TABLE_STOP =
  ' {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)' +
  '| {0,3}#{1,6}(?:\\s|$)' +
  '| {0,3}>' +
  '|(?: {4}| {0,3}\\t)[^\\n]' +
  '| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)' +
  '| {0,3}(?:[*+-]|1[.)])[ \\t]' +
  '| {0,3}(?:<\\/?(?:' + BLOCK_TAGS + ')(?: +|\\n|\\/?>)' +
  '|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)' +
  '|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';
const reTable = new RegExp(
  '^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)' +
  '(?:\\n((?:(?! *\\n|' + TABLE_STOP + ').*?(?:\\n|$))*)\\n*|$)');
const reParagraph = new RegExp('^([^\\n]+(?:\\n(?!' + INTERRUPT + '|' + reTable.source.slice(1) + ')[^\\n]+)*)');
const reTextLine = /^[^\n]+/;

// A blockquote is a run of lines each starting with ">"; a non-blank line
// without the marker may continue the quote lazily, unless it starts one of
// the constructs that interrupt laziness.
const LAZY_STOP =
  ' {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)' +
  '| {0,3}#{1,6}(?:\\s|$)' +
  '| {0,3}>' +
  '| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)' +
  '| {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)' +
  '| {0,3}(?:<\\/?(?:' + BLOCK_TAGS + ')(?: +|\\n|\\/?>)' +
  '|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)' +
  '|<\\?|<![A-Za-z]|<!\\[CDATA\\[)' +
  '|[ \\t]+\\n';
const reQuote = new RegExp('^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(([^\\n]+(?:\\n(?!' + LAZY_STOP + ')[^\\n]+)*))|[^\\n]*)(?:\\n|$))+');
const reQuoteMarker = /^ {0,3}>[ \t]?/gm;
const reQuoteMarkerWs = /^( {0,3}>)([ \t]+)/gm;
const reQuoteSetext = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;

// ------------------------------------------------------- block scanning
// Tokens are plain objects: {kind, raw, text?, ...}. Inline parsing is
// deferred to render time; `text` holds the inline source for leaf blocks.

function scanIndented(src) {
  const m = reIndented.exec(src);
  if (!m) return null;
  const raw = trimHtmlRaw(m[0]);
  return { kind: 'code', raw, text: raw.replace(/^(?: {0,3}\t| {1,4})/gm, ''), indented: true };
}

function scanFence(src) {
  const m = reFence.exec(src);
  if (!m) return null;
  // Indented-fence compensation: when the opening line is indented, that
  // much leading space is stripped from each content line.
  let text = m[3] || '';
  const comp = /^(\s+)(?:```)/.exec(m[0]);
  if (comp) {
    const indent = comp[1];
    text = text.split('\n').map((line) => {
      const lead = /^\s+/.exec(line);
      return lead ? line.slice(Math.min(lead[0].length, indent.length)) : line;
    }).join('\n');
  }
  const lang = m[2] ? m[2].trim().replace(/\\([\p{P}\p{S}])/gu, '$1') : m[2];
  return { kind: 'code', raw: m[0], text, lang };
}

function scanAtx(src) {
  const m = reAtx.exec(src);
  if (!m) return null;
  let text = m[2].trim();
  if (/#$/.test(text)) {
    const stripped = trimEndChar(text, '#');
    if (!stripped || /[ \t]$/.test(stripped)) text = stripped.trim();
  }
  return { kind: 'heading', raw: trimEndChar(m[0], '\n'), depth: m[1].length, text };
}

function scanThematic(src) {
  const m = reThematic.exec(src);
  return m ? { kind: 'hr', raw: trimEndChar(m[0], '\n') } : null;
}

function scanHtmlBlock(src) {
  const m = reHtmlBlock.exec(src);
  if (!m) return null;
  const raw = trimHtmlRaw(m[0]);
  return { kind: 'html', raw, text: raw, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style' };
}

function scanDef(src, ctx) {
  const m = reDef.exec(src);
  if (!m) return null;
  if (!/^</.test(m[2]) && bracketBalance(m[2], '()') !== -1) return null;
  const tag = labelKey(m[1]);
  const href = m[2] ? m[2].replace(/^<(.*)>$/, '$1').replace(/\\([\p{P}\p{S}])/gu, '$1') : '';
  const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(/\\([\p{P}\p{S}])/gu, '$1') : m[3];
  return { kind: 'def', raw: trimEndChar(m[0], '\n'), tag, href, title };
}

const reAlignRight = /^ *-+: *$/;
const reAlignCenter = /^ *:-+: *$/;
const reAlignLeft = /^ *:-+ *$/;
function scanTable(src, ctx) {
  const m = reTable.exec(src);
  if (!m || !/[:|]/.test(m[2])) return null;
  const headerCells = splitRow(m[1]);
  const alignCells = splitRow(m[2].replace(/^\||\| *$/g, ''));
  if (headerCells.length !== alignCells.length) return null;
  const align = alignCells.map((c) =>
    reAlignRight.test(c) ? 'right' : reAlignCenter.test(c) ? 'center' : reAlignLeft.test(c) ? 'left' : null);
  const header = headerCells.map((text, i) => ({ text, align: align[i], header: true }));
  const bodyText = m[3] && m[3].trim() ? m[3].replace(/\n[ \t]*$/, '') : '';
  const rows = bodyText
    ? bodyText.split('\n').map((line) => splitRow(line, header.length).map((text, i) => ({ text, align: align[i], header: false })))
    : [];
  return { kind: 'table', raw: trimEndChar(m[0], '\n'), header, rows, align };
}

function scanSetext(src) {
  const m = reSetext.exec(src);
  if (!m) return null;
  const text = m[1].trim();
  return { kind: 'heading', raw: trimEndChar(m[0], '\n'), depth: m[2].charAt(0) === '=' ? 1 : 2, text };
}

function scanParagraph(src) {
  const m = reParagraph.exec(src);
  if (!m) return null;
  const text = m[1].endsWith('\n') ? m[1].slice(0, -1) : m[1];
  return { kind: 'paragraph', raw: m[0], text };
}

// Blockquote: lex the quoted run, then repeatedly try to extend the inner
// result with the lines that follow when the inner parse ended in a
// paragraph-ish token (the reference re-lexes merged chunks so lazy lines
// join the right inner block; a trailing inner blockquote or list absorbs
// following lines by being re-lexed together with them).
function scanQuote(src, ctx) {
  const m = reQuote.exec(src);
  if (!m) return null;
  let lines = trimEndChar(m[0], '\n').split('\n');
  let rawAll = '', textAll = '';
  const inner = [];
  while (lines.length > 0) {
    let cut = 0, seenMarker = false;
    const chunk = [];
    for (; cut < lines.length; cut++) {
      if (reQuoteStart.test(lines[cut])) { chunk.push(lines[cut]); seenMarker = true; }
      else if (!seenMarker) chunk.push(lines[cut]);
      else break;
    }
    lines = lines.slice(cut);
    const chunkRaw = chunk.join('\n');
    const stripped = chunkRaw
      .replace(reQuoteMarkerWs, (whole, marker, ws) => marker + expandTabs(ws, marker.length))
      .replace(reQuoteSetext, '\n    $1')
      .replace(reQuoteMarker, '');
    rawAll = rawAll ? rawAll + '\n' + chunkRaw : chunkRaw;
    textAll = textAll ? textAll + '\n' + stripped : stripped;
    const savedTop = ctx.top;
    ctx.top = true;
    lexBlocks(stripped, inner, ctx, true);
    ctx.top = savedTop;
    if (lines.length === 0) break;
    const last = inner[inner.length - 1];
    if (!last || last.kind === 'code' || last.kind === 'heading' || last.kind === 'hr' || last.kind === 'html' || last.kind === 'table') break;
    if (last.kind === 'blockquote') {
      const rest = lines.join('\n');
      const merged = last.raw + '\n' + rest.replace(reQuoteMarker, '');
      const retry = scanQuote(merged + '\n', ctx);
      if (!retry) break;
      inner[inner.length - 1] = retry;
      const consumed = merged.substring(retry.raw.length).replace(/^\n/, '');
      const consumedLines = consumed ? consumed.split('\n').length : 0;
      const used = consumedLines ? lines.slice(0, -consumedLines) : lines;
      if (used.length > 0) { rawAll += '\n' + used.join('\n'); }
      textAll = textAll.substring(0, textAll.length - last.text.length) + retry.text;
      lines = lines.slice(used.length);
      if (lines.length > 0 && reQuoteStart.test(lines[0])) continue;
      break;
    }
    if (last.kind === 'list') {
      const rest = lines.join('\n');
      const merged = last.raw + '\n' + rest;
      const retry = scanList(merged, ctx);
      if (!retry) break;
      inner[inner.length - 1] = retry;
      let extra = 0;
      if (retry.raw.length > last.raw.length) {
        extra = merged.slice(last.raw.length + 1, retry.raw.length).split('\n').length;
      }
      if (extra > 0) {
        const usedText = lines.slice(0, extra).join('\n');
        rawAll += '\n' + usedText;
        textAll += '\n' + usedText;
      }
      lines = lines.slice(extra);
      continue;
    }
    // Any other ending token: the next chunk's blocks are lexed into the
    // same token list, where a paragraph (or indented code / definition)
    // merges with the previous one — that is how lazy lines join the
    // quote's running paragraph.
    continue;
  }
  return { kind: 'blockquote', raw: rawAll, text: textAll, tokens: inner };
}

// ------------------------------------------------------------- list scan
// A list is lexed item by item. The first line gives the bullet; following
// lines belong to the item while they are indented to the item's content
// column, are blank, or continue the item's paragraph lazily. Whether the
// list is loose is decided afterwards from blank lines between items and
// inside items.
const reTaskItem = /^\[[ xX]\][ \t]+\S/;
const reTaskStrip = /^\[[ xX]\][ \t]+/;
const reCheckbox = /\[[ xX]\]/;

function scanList(src, ctx) {
  const first = reListStart.exec(src);
  if (!first) return null;
  const bullet = first[1].trim();
  const ordered = bullet.length > 1;
  const start = ordered ? +bullet.slice(0, -1) : '';
  // Subsequent items must use the same bullet family: same char for
  // bullets, same delimiter for ordered lists.
  const bulletPattern = ordered ? '\\d{1,9}\\' + bullet.slice(-1) : '\\' + bullet;
  const itemRe = new RegExp('^( {0,3}' + bulletPattern + ')((?:[\t ][^\\n]*)?(?:\\n|$))');
  const list = { kind: 'list', raw: '', ordered, start, loose: false, items: [] };
  let rest = src;
  let endWithBlank = false;
  while (rest) {
    const m = itemRe.exec(rest);
    if (!m || reThematic.test(rest)) break;
    const itemStart = src.length - rest.length;
    rest = rest.substring(m[0].length);
    // First line content after the bullet, tabs expanded from the bullet's
    // end column.
    const firstLine = m[2].split('\n', 1)[0];
    const bulletLen = m[1].length;
    const expanded = firstLine.replace(/^[ \t]+/, (ws) => expandTabs(ws, bulletLen));
    let nextLine = rest.split('\n', 1)[0];
    const blankFirst = !expanded.trim();
    let indent, content;
    if (blankFirst) {
      indent = bulletLen + 1;
      content = expanded;
    } else {
      indent = expanded.search(/\S/);
      if (indent > 4) indent = 1;
      content = expanded.slice(indent);
      indent += bulletLen;
    }
    let itemDone = false;
    if (blankFirst && /^[ \t]*$/.test(nextLine)) {
      rest = rest.substring(nextLine.length + 1);
      itemDone = true;
    }
    if (!itemDone) {
      const beginPad = Math.min(indent - 1, 3);
      const nextBulletRe = new RegExp('^ {0,' + beginPad + '}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))');
      const hrRe = new RegExp('^ {0,' + beginPad + '}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)');
      const fenceRe = new RegExp('^ {0,' + beginPad + '}(?:```|~~~)');
      const headingRe = new RegExp('^ {0,' + beginPad + '}#{1,6}(?:\\s|$)');
      const htmlRe = new RegExp('^ {0,' + beginPad + '}(?:<\\/?(?:' + BLOCK_TAGS + ')(?: +|$|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)', 'i');
      const quoteRe = new RegExp('^ {0,' + beginPad + '}>');
      let wasBlank = blankFirst;
      let prevLine = expanded;
      while (rest) {
        const line = rest.split('\n', 1)[0];
        const tabbed = line.replace(/^[ \t]+/, (ws) => expandTabs(ws));
        if (fenceRe.test(line) || headingRe.test(line) || htmlRe.test(line) || quoteRe.test(line) || nextBulletRe.test(line) || hrRe.test(line)) break;
        if (tabbed.search(/\S/) >= indent || !line.trim()) {
          content += '\n' + tabbed.slice(indent);
        } else {
          // Lazy continuation: allowed only while the previous line is a
          // plain paragraph line — it stops when the previous line is
          // blank, is indented code, or starts a fence, heading, HTML
          // block or thematic break.
          if (wasBlank || prevLine.replace(/\t/g, '    ').search(/\S/) >= 4 || fenceRe.test(prevLine) || headingRe.test(prevLine) || htmlRe.test(prevLine) || hrRe.test(prevLine)) break;
          const setextHack = /^ {0,3}(?:=+|-+) *$/.test(line) && reSetext.test(prevLine + '\n' + line)
            ? '    ' + tabbed.replace(/^ {0,3}/, '')
            : line;
          content += '\n' + setextHack;
        }
        wasBlank = !line.trim();
        rest = rest.substring(line.length + 1);
        prevLine = tabbed.slice(indent);
      }
    }
    const itemRaw = src.slice(itemStart, src.length - rest.length);
    list.loose || (endWithBlank ? (list.loose = true) : /\n[ \t]*\n[ \t]*$/.test(itemRaw) && (endWithBlank = true));
    list.items.push({
      kind: 'list_item', raw: itemRaw, task: reTaskItem.test(content),
      loose: false, text: content, tokens: [],
    });
  }
  const lastItem = list.items[list.items.length - 1];
  if (!lastItem) return null;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  list.raw = src.slice(0, src.length - rest.length).trimEnd();
  for (const item of list.items) {
    const savedTop = ctx.top;
    ctx.top = false;
    item.tokens = lexBlocks(item.text, [], ctx, false);
    ctx.top = savedTop;
    if (!list.loose) {
      const spaces = item.tokens.filter((t) => t.kind === 'space');
      if (spaces.length > 0 && spaces.some((t) => /\n.*\n/.test(t.raw))) list.loose = true;
    }
  }
  for (const item of list.items) {
    const head = item.tokens[0];
    if (item.task && head && (head.kind === 'text' || head.kind === 'paragraph')) {
      item.text = item.text.replace(reTaskStrip, '');
      head.raw = head.raw.replace(reTaskStrip, '');
      head.text = head.text.replace(reTaskStrip, '');
      const cb = reCheckbox.exec(item.raw);
      if (cb) {
        const box = { kind: 'checkbox', raw: cb[0] + ' ', checked: cb[0] !== '[ ]' };
        item.checked = box.checked;
        if (list.loose) head.leadBox = box;
        else item.tokens.unshift(box);
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const t of item.tokens) if (t.kind === 'text') t.kind = 'paragraph';
    }
  }
  return list;
}

// ------------------------------------------------------------ block loop
// Mirrors the reference's token-stream merges: a one-newline space run is
// folded into the previous token's raw; an indented code block or a link
// definition that directly follows a paragraph (or a bare text token, in
// non-top contexts) is folded into that paragraph instead of standing
// alone.
function lexBlocks(src, out, ctx, inQuote = false) {
  let guard = Infinity;
  while (src) {
    if (src.length < guard) guard = src.length;
    else break; // no progress: would loop forever
    let tok = null;
    const c0 = src[0];

    if (c0 === '\n' || c0 === ' ' || c0 === '\t') {
      const m = reBlankRun.exec(src);
      if (m && m[0].length > 0) {
        tok = { kind: 'space', raw: m[0] };
        src = src.substring(m[0].length);
        const prev = out[out.length - 1];
        if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n';
        else out.push(tok);
        continue;
      }
    }

    if ((tok = scanIndented(src))) {
      src = src.substring(tok.raw.length);
      const prev = out[out.length - 1];
      if (prev && (prev.kind === 'paragraph' || prev.kind === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
      } else out.push(tok);
      continue;
    }
    if ((tok = scanFence(src))) { src = src.substring(tok.raw.length); out.push(tok); continue; }
    if ((tok = scanAtx(src))) { src = src.substring(tok.raw.length); out.push(tok); continue; }
    if ((tok = scanThematic(src))) { src = src.substring(tok.raw.length); out.push(tok); continue; }
    if (c0 !== '<' || true) {
      if ((tok = scanQuote(src, ctx))) { src = src.substring(tok.raw.length); out.push(tok); continue; }
    }
    if ((tok = scanList(src, ctx))) { src = src.substring(tok.raw.length); out.push(tok); continue; }
    if ((tok = scanHtmlBlock(src))) { src = src.substring(tok.raw.length); out.push(tok); continue; }
    if ((tok = scanDef(src, ctx))) {
      src = src.substring(tok.raw.length);
      const prev = out[out.length - 1];
      if (prev && (prev.kind === 'paragraph' || prev.kind === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.raw;
      } else {
        if (!Object.hasOwn(ctx.links, tok.tag)) ctx.links[tok.tag] = { href: tok.href, title: tok.title };
        out.push(tok);
      }
      continue;
    }
    if ((tok = scanTable(src, ctx))) { src = src.substring(tok.raw.length); out.push(tok); continue; }
    if ((tok = scanSetext(src))) { src = src.substring(tok.raw.length); out.push(tok); continue; }

    if (ctx.top) {
      tok = scanParagraph(src);
      if (tok) {
        src = src.substring(tok.raw.length);
        const prev = out[out.length - 1];
        if (inQuote && prev && prev.kind === 'paragraph') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
        } else out.push(tok);
        continue;
      }
    }
    const m = reTextLine.exec(src);
    if (m) {
      tok = { kind: 'text', raw: m[0], text: m[0] };
      src = src.substring(m[0].length);
      const prev = out[out.length - 1];
      if (prev && prev.kind === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
      } else out.push(tok);
      continue;
    }
    break;
  }
  return out;
}

// ------------------------------------------------------ inline patterns
const reEscape = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/;
const reTag = /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/;
const reAutolink = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;
const reCodeSpan = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const reHardBreak = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const reLinkLabel = /((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)/;
const reLink = new RegExp('^!?\\[' + reLinkLabel.source + '\\]\\([ \\t\\n]*(<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\)))(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(\\"(?:\\\\[\\s\\S]|[^\\"\\\\])*\\"|\\\'(?:\\\\[\\s\\S]|[^\\\'\\\\])*\\\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)))?[ \\t\\n]*\\)');
const reRefLabel = /((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)/;
const reReflink = new RegExp('^!?\\[' + reLinkLabel.source + '\\]\\[' + reRefLabel.source + '\\]');
const reNolink = new RegExp('^!?\\[' + reRefLabel.source + '\\](?:\\[\\])?');
const reRefSearch = /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g;
const reBlockSkip = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\()]|\((?:\\[\s\S]|[^\\()])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
const reAnyPunctOutsideCode = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const reEmLDelim = /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u;
const reDelLDelim = /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u;
const reDelRDelim = /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu;
const reEmRDelimAst = /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu;
const reEmRDelimUnd = /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu;
const rePunctuation = /^((?![*_])[\s\p{P}\p{S}])/u;
const reUrl = /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const reBackpedal = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
const reInlineText = /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|\}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{|\}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|\}~-]+@))))/;

// ------------------------------------------------------------- masking
// The emphasis and strikethrough scanners work on a masked copy of the
// inline source in which:
//   - a resolvable reference link's label is replaced by "a"s (so a
//     delimiter inside a label that will become a link cannot pair with
//     one outside it);
//   - a full inline link "[..](..)" collapses to "[aaa]";
//   - code spans keep their backticks but their content's backticks are
//     neutralised, and backslash-escaped punctuation outside code becomes
//     "+"s (an escaped char can never be a delimiter).
// The masked copy has the same length as the source, so indices line up.
function maskInline(src, ctx) {
  let masked = src;
  if (src.includes('[')) {
    const maskRef = (whole) => {
      const open = whole.lastIndexOf('[');
      if (!Object.hasOwn(ctx.links, labelKey(whole.slice(open + 1, -1)))) return whole;
      if (open > 1 && whole.charAt(0) !== '!') {
        const inner = whole.slice(1, open - 1);
        if (textHasLink(inner, ctx)) {
          return '[' + inner.replace(reRefSearch, maskRef) + '][' + 'a'.repeat(whole.length - open - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(whole.length - 2) + ']';
    };
    masked = masked.replace(reRefSearch, maskRef);
  }
  masked = masked.replace(reAnyPunctOutsideCode, (whole, span, escaped) =>
    escaped ? '+'.repeat(whole.length)
      : span ? span + whole.slice(span.length, whole.length - span.length).replace(/`/g, '+') + span
        : whole);
  masked = masked.replace(reBlockSkip, (whole, g1, g2) => {
    const keep = g2 ? g2.length : 0;
    return whole.slice(0, keep) + '[' + 'a'.repeat(whole.length - keep - 2) + ']';
  });
  return masked;
}

// Does this fragment itself contain a resolvable reference link? Used by
// the masking pass for nested labels.
function textHasLink(text, ctx) {
  if (!text.includes('[')) return false;
  for (const m of text.matchAll(reBlockSkip)) {
    if (reLink.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of text.matchAll(reRefSearch)) {
    const whole = m[0];
    const open = whole.lastIndexOf('[');
    if (!(whole.charAt(0) === '!' || !Object.hasOwn(ctx.links, labelKey(whole.slice(open + 1, -1))))) {
      if (!(open > 1 && textHasLink(whole.slice(1, open - 1), ctx))) return true;
    }
  }
  return false;
}

// Last index in the masked source at which an emphasis closer (for `ch`)
// or a strikethrough closer (ch === '~') can still appear: the last run of
// that delimiter whose preceding character is not whitespace-ish. -1 when
// there is none.
function lastCloserIndex(masked, ch) {
  let found = -1;
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== ch) continue;
    const prev = i === 0 ? '\n' : masked[i - 1];
    let j = i + 1;
    while (j < masked.length && masked[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') found = i;
    i = j - 1;
  }
  return found;
}

// Would interpreting `label` (starting at offset `skip` in the full source
// `src`) as a link swallow a tag or autolink that sticks out past the
// label's end? The reference refuses such links.
function linkSwallowsTag(src, label, skip, ctx) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    const c = label[i];
    if (c === '\\') { i++; continue; }
    if (c === '`') {
      const m = reCodeSpan.exec(label.slice(i));
      if (m) { i += m[0].length - 1; continue; }
    }
    if (c !== '<') continue;
    const rest = src.slice(skip + i);
    const m = reTag.exec(rest) || reAutolink.exec(rest);
    if (m) {
      if (m[0].length > label.length - i) return true;
      i += m[0].length - 1;
    }
  }
  return false;
}

// Build a link or image token, parsing the label's inline content with
// link state set. A link whose label itself emitted a link is refused
// (nested links are not allowed); images always pass.
function makeLink(match, def, rawText, ctx) {
  const href = def.href;
  const title = def.title || null;
  const label = match[1].replace(/\\([\[\]])/g, '$1');
  const isImage = match[0].charAt(0) === '!';
  const savedInLink = ctx.inLink, savedEmitted = ctx.linkEmitted, savedRaw = ctx.inRawBlock;
  ctx.inLink = true;
  ctx.linkEmitted = false;
  const tokens = parseInline(label, ctx);
  const emitted = ctx.linkEmitted;
  ctx.linkEmitted = savedEmitted;
  ctx.inLink = savedInLink;
  if (!isImage) {
    if (emitted) { ctx.inRawBlock = savedRaw; return null; }
    ctx.linkEmitted = true;
  }
  return { kind: isImage ? 'image' : 'link', raw: rawText, href, title, text: label, tokens };
}

// ------------------------------------------------------- inline scanning
// Each scanner returns {token(s)..., len} or null. `src` is the remaining
// source, `masked` the remaining masked source, `prevChar` the last
// character of the previous text run ('' at the start).

function scanEscape(src) {
  const m = reEscape.exec(src);
  return m ? { kind: 'escape', raw: m[0], text: m[1], len: m[0].length } : null;
}

function scanTag(src, ctx) {
  const m = reTag.exec(src);
  if (!m) return null;
  if (!ctx.inLink && /^<a /i.test(m[0])) ctx.inLink = true;
  else if (ctx.inLink && /^<\/a>/i.test(m[0])) ctx.inLink = false;
  if (!ctx.inRawBlock && /^<(pre|code|kbd|script)(\s|>)/i.test(m[0])) ctx.inRawBlock = true;
  else if (ctx.inRawBlock && /^<\/(pre|code|kbd|script)(\s|>)/i.test(m[0])) ctx.inRawBlock = false;
  return { kind: 'html', raw: m[0], text: m[0], len: m[0].length };
}

function scanLink(src, ctx) {
  if (ctx.linkParenPossible === false) return null;
  const m = reLink.exec(src);
  if (!m) return null;
  const skip = src.charAt(0) === '!' ? 2 : 1;
  if (linkSwallowsTag(src, m[1], skip, ctx)) return null;
  let href = m[2].trim();
  if (/^</.test(href)) {
    if (!/>$/.test(href)) return null;
    const inner = trimEndChar(href.slice(0, -1), '\\');
    if ((href.length - inner.length) % 2 === 0) return null;
  } else {
    const bal = bracketBalance(m[2], '()');
    if (bal === -2) return null;
    if (bal > -1) {
      const cut = (src.indexOf('!') === 0 ? 5 : 4) + m[1].length + bal;
      m[2] = m[2].substring(0, bal);
      m[0] = src.substring(0, cut).trim();
      m[3] = '';
    }
  }
  const tail = trimEndChar(m[0].slice(0, -1), '\\');
  if ((m[0].length - tail.length) % 2 === 0) return null;
  href = m[2];
  let title = m[3] ? m[3].slice(1, -1) : '';
  href = href.trim();
  if (/^</.test(href)) href = href.slice(1, -1);
  const tok = makeLink(m, {
    href: href && href.replace(/\\([\p{P}\p{S}])/gu, '$1'),
    title: title && title.replace(/\\([\p{P}\p{S}])/gu, '$1'),
  }, m[0], ctx);
  return tok ? { ...tok, len: m[0].length } : null;
}

function scanReflink(src, ctx) {
  let m = reReflink.exec(src) || reNolink.exec(src);
  if (!m) return null;
  const skip = src.charAt(0) === '!' ? 2 : 1;
  if (linkSwallowsTag(src, m[1], skip, ctx)) return null;
  const def = ctx.links[labelKey(m[2] || m[1])];
  if (!def) {
    const first = src.charAt(0);
    return { kind: 'text', raw: first, text: first, len: 1 };
  }
  const tok = makeLink(m, def, m[0], ctx);
  return tok ? { ...tok, len: m[0].length } : null;
}

// Emphasis / strong. The left delimiter run is classified by the masked
// source; the matching right delimiter is searched with the reference's
// delimiter-run rules (the "rule of three", underscore intraword rules and
// the __ / ** cross-guards are all encoded in the search patterns and the
// bookkeeping below).
function scanEmStrong(src, masked, prevChar, ctx) {
  const lm = reEmLDelim.exec(src);
  if (!lm || (!lm[1] && !lm[2] && !lm[3] && !lm[4])) return null;
  const delim = lm[0][0];
  // Position of this delimiter run within the whole masked string, and the
  // character before the run (walking back over identical delimiters).
  const wholeMaskedLen = ctx.maskedWhole.length;
  const offset = wholeMaskedLen - masked.length;
  let runStart = offset;
  while (runStart > 0 && ctx.maskedWhole[runStart - 1] === delim) runStart--;
  const beforeRun = runStart > 0 ? ctx.maskedWhole[runStart - 1] : '';
  const beforeIsPunct = beforeRun === '*' || beforeRun === '_' || !!rePunctuation.exec(beforeRun);
  let prevMaskedChar = prevChar;
  if (runStart < offset) prevMaskedChar = beforeRun;
  const prevIsPunct = runStart < offset ? beforeIsPunct : !!rePunctuation.exec(prevChar);
  const sameChar = prevChar === delim;
  if (lm[4] && /[\p{L}\p{N}]/u.test(prevMaskedChar)) return null;
  const leftRun = lm[1] || lm[3] || '';
  if (!leftRun || !prevMaskedChar || prevIsPunct) {
    // Count the opening run in code points.
    let openLen = 0;
    for (const _ of lm[0]) openLen++;
    openLen -= 1;
    let nodeLen = openLen, spare = 0;
    const outerLen = offset - runStart + openLen;
    const canOpen = !!beforeRun.trim() && (!!leftRun || (delim === '*' && !beforeIsPunct));
    if (delim !== '*' && delim !== '_') return null;
    const rdelim = delim === '*' ? reEmRDelimAst : reEmRDelimUnd;
    const lastIdx = ctx.lastCloser[delim];
    if (lastIdx < offset + openLen) return null;
    let rest = masked.slice(openLen);
    const budget = lastIdx - (offset + openLen);
    let rm;
    rdelim.lastIndex = 0;
    let group = '';
    while ((rm = rdelim.exec(rest)) !== null && rm.index <= budget) {
      group = rm[1] || rm[2] || rm[3] || rm[4] || rm[5] || rm[6] || '';
      if (!group) continue;
      let gLen = 0;
      for (const _ of group) gLen++;
      if (rm[3] || rm[4]) { nodeLen += gLen; continue; }
      if (rm[5] || rm[6] || canOpen) {
        if (sameChar && (rm[5] || rm[6])) break;
        if (outerLen % 3 && !((outerLen + gLen) % 3)) { spare += gLen; continue; }
      }
      nodeLen -= gLen;
      if (nodeLen > 0) continue;
      gLen = Math.min(gLen, gLen + nodeLen + spare);
      const firstChLen = [...rm[0]][0].length;
      const raw = src.slice(0, openLen + rm.index + firstChLen + gLen);
      if (Math.min(openLen, gLen) % 2) {
        const text = raw.slice(1, -1);
        return { kind: 'em', raw, text, tokens: parseInline(text, ctx), len: raw.length };
      }
      const text = raw.slice(2, -2);
      return { kind: 'strong', raw, text, tokens: parseInline(text, ctx), len: raw.length };
    }
  }
  return null;
}

function scanDel(src, masked, prevChar, ctx) {
  const lm = reDelLDelim.exec(src);
  if (!lm) return null;
  if (!(lm[1] || '') || !prevChar || rePunctuation.test(prevChar)) {
    let openLen = 0;
    for (const _ of lm[0]) openLen++;
    openLen -= 1;
    let nodeLen = openLen;
    const wholeMaskedLen = ctx.maskedWhole.length;
    const offset = wholeMaskedLen - masked.length;
    const lastIdx = ctx.lastCloser['~'];
    if (lastIdx < offset + openLen) return null;
    let rest = masked.slice(openLen);
    const budget = lastIdx - (offset + openLen);
    let rm;
    reDelRDelim.lastIndex = 0;
    while ((rm = reDelRDelim.exec(rest)) !== null && rm.index <= budget) {
      const group = rm[1] || rm[2] || rm[3] || rm[4] || rm[5] || rm[6] || '';
      if (!group) continue;
      let gLen = 0;
      for (const _ of group) gLen++;
      if (gLen !== openLen) continue;
      if (rm[3] || rm[4]) { nodeLen += gLen; continue; }
      nodeLen -= gLen;
      if (nodeLen > 0) continue;
      gLen = Math.min(gLen, gLen + nodeLen);
      const firstChLen = [...rm[0]][0].length;
      const raw = src.slice(0, openLen + rm.index + firstChLen + gLen);
      const text = raw.slice(openLen, -openLen);
      return { kind: 'del', raw, text, tokens: parseInline(text, ctx), len: raw.length };
    }
  }
  return null;
}

function scanCodespan(src) {
  const m = reCodeSpan.exec(src);
  if (!m) return null;
  let text = m[2].replace(/\n/g, ' ');
  const hasNonSpace = /[^ ]/.test(text);
  if (hasNonSpace && /^ /.test(text) && / $/.test(text)) text = text.substring(1, text.length - 1);
  return { kind: 'codespan', raw: m[0], text, len: m[0].length };
}

function scanHardBreak(src) {
  const m = reHardBreak.exec(src);
  return m ? { kind: 'br', raw: m[0], len: m[0].length } : null;
}

function scanAutolink(src) {
  const m = reAutolink.exec(src);
  if (!m) return null;
  const isMail = m[2] === '@';
  const text = m[1];
  return {
    kind: 'link', raw: m[0], text, href: isMail ? 'mailto:' + text : text,
    autolink: true, tokens: [{ kind: 'text', raw: text, text }], len: m[0].length,
  };
}

function scanUrl(src, ctx) {
  if (ctx.inLink) return null;
  const m = reUrl.exec(src);
  if (!m) return null;
  let text, href;
  if (m[2] === '@') {
    text = m[0];
    href = 'mailto:' + m[0];
  } else {
    let prev;
    do {
      prev = m[0];
      m[0] = reBackpedal.exec(m[0])?.[0] ?? '';
    } while (prev !== m[0]);
    text = m[0];
    href = m[1] === 'www.' ? 'http://' + m[0] : m[0];
  }
  if (!m[0]) return null;
  return {
    kind: 'link', raw: m[0], text, href, autolink: true,
    tokens: [{ kind: 'text', raw: text, text }], len: m[0].length,
  };
}

function scanInlineText(src, ctx) {
  const m = reInlineText.exec(src);
  if (!m) return null;
  const raw = m[0];
  return {
    kind: 'text', raw, text: ctx.inRawBlock ? raw : decodeNumericRefs(raw),
    escaped: ctx.inRawBlock, len: raw.length,
  };
}

// The inline driver. When the source contains no emphasis/strikethrough
// delimiters at all, masking is skipped and the masked source is the
// source itself.
function parseInline(src, ctx) {
  const savedParen = ctx.linkParenPossible;
  ctx.linkParenPossible = savedParen && src.includes(')');
  try {
    return parseInlineInner(src, ctx);
  } finally {
    ctx.linkParenPossible = savedParen;
  }
}

function parseInlineInner(src, ctx) {
  const needsMask = src.includes('*') || src.includes('_') || src.includes('~');
  const maskedWhole = needsMask ? maskInline(src, ctx) : src;
  const savedMasked = ctx.maskedWhole, savedCloser = ctx.lastCloser;
  ctx.maskedWhole = maskedWhole;
  ctx.lastCloser = needsMask
    ? { '*': lastCloserIndex(maskedWhole, '*'), '_': lastCloserIndex(maskedWhole, '_'), '~': lastCloserIndex(maskedWhole, '~') }
    : { '*': -1, '_': -1, '~': -1 };
  const out = [];
  let rest = src, maskedRest = maskedWhole, prevChar = '';
  try {
    while (rest) {
      let tok = null;
      const c = rest[0];
      if (c === '\\') tok = scanEscape(rest);
      if (!tok && c === '<') tok = scanTag(rest, ctx);
      if (!tok && (c === '[' || c === '!')) tok = scanLink(rest, ctx);
      if (!tok && (c === '[' || c === '!')) tok = scanReflink(rest, ctx);
      if (!tok && (c === '*' || c === '_')) tok = scanEmStrong(rest, maskedRest, prevChar, ctx);
      if (!tok && c === '`') tok = scanCodespan(rest);
      if (!tok && (c === ' ' || c === '\\' || c === '\n')) tok = scanHardBreak(rest);
      if (!tok && c === '~') tok = scanDel(rest, maskedRest, prevChar, ctx);
      if (!tok && c === '<') tok = scanAutolink(rest);
      if (!tok) tok = scanUrl(rest, ctx);
      if (!tok) tok = scanInlineText(rest, ctx);
      if (!tok) break;
      rest = rest.substring(tok.len);
      maskedRest = maskedRest.substring(tok.len);
      if (tok.kind === 'text') {
        const prev = out[out.length - 1];
        if (prev && prev.kind === 'text') {
          prev.raw += tok.raw;
          prev.text += tok.text;
        } else out.push(tok);
        if (tok.raw.slice(-1) !== '_') prevChar = tok.raw.slice(-1);
      } else {
        out.push(tok);
        prevChar = '';
      }
    }
  } finally {
    ctx.maskedWhole = savedMasked;
    ctx.lastCloser = savedCloser;
  }
  return out;
}

// ------------------------------------------------------------- rendering
// Inline tokens render recursively. `asText` is the plain-text renderer
// used for image alt attributes: formatting is unwrapped, code spans and
// raw HTML pass through literally, hard breaks vanish and a checkbox
// renders as its raw source.
function renderInline(tokens, ctx, asText = false) {
  let out = '';
  for (const t of tokens) {
    switch (t.kind) {
      case 'escape':
        out += asText ? t.text : escHtml(t.text);
        break;
      case 'html':
        out += t.text;
        break;
      case 'text':
        out += asText ? t.text : (t.escaped ? t.text : escHtml(t.text));
        break;
      case 'strong':
        out += asText ? renderInline(t.tokens, ctx, true) : '<strong>' + renderInline(t.tokens, ctx) + '</strong>';
        break;
      case 'em':
        out += asText ? renderInline(t.tokens, ctx, true) : '<em>' + renderInline(t.tokens, ctx) + '</em>';
        break;
      case 'del':
        out += asText ? renderInline(t.tokens, ctx, true) : '<del>' + renderInline(t.tokens, ctx) + '</del>';
        break;
      case 'codespan':
        out += asText ? t.text : '<code>' + escHtml(t.text, true) + '</code>';
        break;
      case 'br':
        out += asText ? '' : '<br>';
        break;
      case 'checkbox':
        out += asText ? t.raw : '<input ' + (t.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
      case 'link': {
        const label = t.autolink ? escHtml(t.text, true) : renderInline(t.tokens, ctx, asText);
        if (asText) { out += label; break; }
        const url = cleanUrl(t.href);
        if (url === null) { out += label; break; }
        let tag = '<a href="' + escHtml(url, !!t.autolink) + '"';
        if (t.title) tag += ' title="' + escHtml(t.title) + '"';
        out += tag + '>' + label + '</a>';
        break;
      }
      case 'image': {
        let alt = t.text;
        if (t.tokens) alt = renderInline(t.tokens, ctx, true);
        if (asText) { out += alt; break; }
        const url = cleanUrl(t.href);
        if (url === null) { out += escHtml(alt); break; }
        let tag = '<img src="' + escHtml(url) + '" alt="' + escHtml(alt) + '"';
        if (t.title) tag += ' title="' + escHtml(t.title) + '"';
        out += tag + '>';
        break;
      }
    }
  }
  return out;
}

function renderBlocks(tokens, ctx) {
  let out = '';
  for (const t of tokens) {
    switch (t.kind) {
      case 'space':
      case 'def':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += '<h' + t.depth + '>' + renderInline(parseInline(t.text, ctx), ctx) + '</h' + t.depth + '>\n';
        break;
      case 'code': {
        const langWord = t.lang ? /^\S*/.exec(t.lang)[0] : '';
        const body = t.text ? t.text.replace(/\n$/, '') + '\n' : '';
        out += langWord
          ? '<pre><code class="language-' + escHtml(langWord) + '">' + escHtml(body, true) + '</code></pre>\n'
          : '<pre><code>' + escHtml(body, true) + '</code></pre>\n';
        break;
      }
      case 'html':
        out += t.text;
        break;
      case 'blockquote':
        out += '<blockquote>\n' + renderBlocks(t.tokens, ctx) + '</blockquote>\n';
        break;
      case 'paragraph':
        out += '<p>' + (t.leadBox ? renderBlocks([t.leadBox], ctx) : '') + renderInline(parseInline(t.text, ctx), ctx) + '</p>\n';
        break;
      case 'text':
        out += (t.leadBox ? renderBlocks([t.leadBox], ctx) : '') + renderInline(parseInline(t.text, ctx), ctx);
        break;
      case 'checkbox':
        out += '<input ' + (t.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
      case 'list': {
        let items = '';
        for (const item of t.items) items += '<li>' + renderBlocks(item.tokens, ctx) + '</li>\n';
        const tag = t.ordered ? 'ol' : 'ul';
        const startAttr = t.ordered && t.start !== 1 ? ' start="' + t.start + '"' : '';
        out += '<' + tag + startAttr + '>\n' + items + '</' + tag + '>\n';
        break;
      }
      case 'table': {
        let head = '';
        for (const cell of t.header) head += renderCell(cell, ctx);
        let body = '';
        for (const row of t.rows) {
          let cells = '';
          for (const cell of row) cells += renderCell(cell, ctx);
          body += '<tr>\n' + cells + '</tr>\n';
        }
        if (body) body = '<tbody>' + body + '</tbody>';
        out += '<table>\n<thead>\n<tr>\n' + head + '</tr>\n</thead>\n' + body + '</table>\n';
        break;
      }
    }
  }
  return out;
}

function renderCell(cell, ctx) {
  const tag = cell.header ? 'th' : 'td';
  const open = cell.align ? '<' + tag + ' align="' + cell.align + '">' : '<' + tag + '>';
  return open + renderInline(parseInline(cell.text, ctx), ctx) + '</' + tag + '>\n';
}

// -------------------------------------------------------------- entry point
export function parse(markdown) {
  const src = markdown.replace(/\r\n|\r/g, '\n');
  const ctx = {
    links: Object.create(null),
    top: true,
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    maskedWhole: '',
    lastCloser: { '*': -1, '_': -1, '~': -1 },
  };
  const tokens = lexBlocks(src, [], ctx, false);
  return renderBlocks(tokens, ctx);
}
