// render-fast: an original, dependency-free Markdown -> HTML renderer whose
// output matches marked 18.1.3 with default options (GFM on, breaks off).
// Structure: a line-oriented block parser builds block nodes and collects
// link reference definitions; a scanner-based inline parser then renders
// the text of paragraphs, headings, list items and table cells.

// ---------- small string helpers ----------

const ENTITY_AT = /&(?:#\d{1,7}|#[Xx][A-Fa-f0-9]{1,6}|\w+);/y;

const ESCAPABLE = '\\!"#$%&\'()*+,-./:;<=>?@[]^_`{|}~';

function isPunct(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}

// Escape the five HTML-significant characters. When keepEntities is set, an
// ampersand that already introduces a character reference is left alone.
function escHtml(s, keepEntities) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 38) { // &
      if (keepEntities) {
        ENTITY_AT.lastIndex = i;
        const m = ENTITY_AT.exec(s);
        if (m) { out += m[0]; i += m[0].length; continue; }
      }
      out += '&amp;'; i++; continue;
    }
    if (c === 60) { out += '&lt;'; i++; continue; }
    if (c === 62) { out += '&gt;'; i++; continue; }
    if (c === 34) { out += '&quot;'; i++; continue; }
    if (c === 39) { out += '&#39;'; i++; continue; }
    // copy a plain run in one slice
    let j = i + 1;
    while (j < n) {
      const d = s.charCodeAt(j);
      if (d === 38 || d === 60 || d === 62 || d === 34 || d === 39) break;
      j++;
    }
    out += s.slice(i, j);
    i = j;
  }
  return out;
}

// Decode numeric character references; map the values HTML forbids to the
// replacement character, mirroring browser behaviour.
function decodeNumericRefs(s) {
  if (s.indexOf('&#') === -1) return s;
  return s.replace(/&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/g, (whole, dec, hex) => {
    let cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) cp = 0xFFFD;
    return String.fromCodePoint(cp);
  });
}

// Normalise a link label the way reference lookup expects: collapse inner
// whitespace, fold case.
function normLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Remove backslash escapes before ASCII punctuation.
function unescapePunct(s) {
  return s.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
}

// Clean a link destination the way the reference renderer does: resolve
// percent-encoded bytes conservatively and strip control characters.
function cleanHref(href) {
  try {
    href = encodeURI(href).replace(/%25/g, '%');
  } catch {
    // leave malformed destinations untouched
  }
  return href.replace(/[\u0000-\u001F\u007F]/g, '');
}

function cleanTitle(t) {
  return t;
}

// ---------- inline parsing ----------
//
// The inline parser scans once, emitting finished HTML into `out` while a
// stack of emphasis delimiters is resolved at the end (the classic
// delimiter-run algorithm). Links are recognised during the scan; their
// bracket nesting is tracked on a separate stack.

const ANGLE_AUTO_RE = /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/y;
const ANGLE_MAIL_RE = /<([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})>/y;
const HTML_TAG_RE = /^<(?:!--(?:-?>|[\s\S]*?-->)|\/[A-Za-z][A-Za-z0-9-]*\s*>|[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z:_][\w.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*?\s*\/?>|\?[\s\S]*?\?>|![A-Za-z]+\s[\s\S]*?>|!\[CDATA\[[\s\S]*?\]\]>)/;
const TAG_AT_RE = new RegExp(HTML_TAG_RE.source.replace(/^\^/, ''), 'y');

function isSpaceCh(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}
function isAlnumCh(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c > 127;
}

// Parse a link destination + optional title starting at the '(' position.
// Returns { href, title, end } or null.
function parseLinkDest(text, openIdx) {
  let i = openIdx + 1;
  const n = text.length;
  while (i < n && isSpaceCh(text[i])) i++;
  let href = '';
  if (text[i] === '<') {
    let j = i + 1;
    let buf = '';
    let ok = false;
    while (j < n) {
      const ch = text[j];
      if (ch === '\\' && j + 1 < n) { buf += text[j + 1]; j += 2; continue; }
      if (ch === '>') { ok = true; break; }
      if (ch === '\n' || ch === '<') break;
      buf += ch; j++;
    }
    if (!ok) return null;
    href = buf;
    i = j + 1;
  } else {
    let depth = 0;
    let buf = '';
    while (i < n) {
      const ch = text[i];
      if (ch === '\\' && i + 1 < n && isPunct(text[i + 1])) { buf += text[i + 1]; i += 2; continue; }
      if (ch === '(') { depth++; buf += ch; i++; continue; }
      if (ch === ')') {
        if (depth === 0) break;
        depth--; buf += ch; i++; continue;
      }
      if (isSpaceCh(ch) || ch.charCodeAt(0) < 32) break;
      buf += ch; i++;
    }
    if (depth !== 0) return null;
    href = buf;
  }
  let title = null;
  let j = i;
  while (j < n && isSpaceCh(text[j])) j++;
  if (j > i || title === null) {
    const q = text[j];
    if (q === '"' || q === "'" || q === '(') {
      const close = q === '(' ? ')' : q;
      let k = j + 1;
      let buf = '';
      let ok = false;
      while (k < n) {
        const ch = text[k];
        if (ch === '\\' && k + 1 < n) { buf += ch + text[k + 1]; k += 2; continue; }
        if (ch === close) { ok = true; break; }
        if (q === '(' && ch === '(') break;
        buf += ch; k++;
      }
      if (ok) {
        title = unescapePunct(buf);
        j = k + 1;
        while (j < n && isSpaceCh(text[j])) j++;
      }
    }
  }
  if (text[j] !== ')') return null;
  return { href, title, end: j + 1 };
}

// Find the ']' matching the '[' at openIdx, honouring nesting and escapes.
// Returns index of the matching ']' or -1.
// Yield the positions where the bracket opened at openIdx can close
// under the rich label grammar, most preferred parse first. A backtick
// run that could complete a code unit is consumed as a unit on the
// preferred path; when the run has length 2+ directly before a ']',
// treating the run as literal text is kept as a fallback path (the
// reference grammar backtracks into it when the unit parse cannot
// complete the surrounding link).
function* labelCloseCandidates(text, openIdx) {
  const n = text.length;
  const seen = new Set();
  const stack = [[openIdx, 0]];
  while (stack.length) {
    const start = stack.pop();
    let i = start[0];
    let depth = start[1];
    const branches = [];
    let candidate = -1;
    while (i < n) {
      const ch = text[i];
      if (ch === '\\') { i += 2; continue; }
      if (ch === '`') {
        let run = 1;
        while (text[i + run] === '`') run++;
        let j = i + run;
        while (j < n && text[j] !== '`') j++;
        if (j < n) {
          if (depth <= 1 && run >= 2 && text[i + run] === ']') branches.push([i + run, depth]);
          let r2 = 1;
          while (text[j + r2] === '`') r2++;
          i = j + r2; continue;
        }
        if (depth <= 1) {
          if (run >= 2 && text[i + run] === ']') { i += run; continue; }
          break;
        }
        i += run; continue;
      }
      if (ch === '<') {
        const rest = text.slice(i);
        const skip = /^<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*>/.exec(rest) || HTML_TAG_RE.exec(rest);
        if (skip) { i += skip[0].length; continue; }
        i++; continue;
      }
      if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) { candidate = i; break; }
      }
      i++;
    }
    if (candidate !== -1 && !seen.has(candidate)) { seen.add(candidate); yield candidate; }
    for (let b = branches.length - 1; b >= 0; b--) stack.push(branches[b]);
  }
}

function scanBracketPlain(text, openIdx) {
  let depth = 0;
  let i = openIdx;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '`') return -2;
    if (ch === '<') {
      const rest = text.slice(i);
      const skip = /^<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*>/.exec(rest) || HTML_TAG_RE.exec(rest);
      if (skip) { i += skip[0].length; continue; }
      i++; continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

function findCloseBracket(text, openIdx) {
  const fast = scanBracketPlain(text, openIdx);
  if (fast !== -2) return fast;
  for (const c of labelCloseCandidates(text, openIdx)) return c;
  return -1;
}

// Render a plain-text run: decode numeric references, then escape.
function renderTextRun(s) {
  if (!/[&<>"'\u0001]/.test(s)) return s;
  if (s.indexOf('&') !== -1) s = decodeNumericRefs(s);
  const out = escHtml(s, true);
  return out.indexOf('\u0001') === -1 ? out : out.replace(/\u0001/g, '&amp;');
}

// GFM extended autolinks: bare URLs, www addresses, mailto:/xmpp:
// addresses and bare email addresses. The domain part of an email-style
// address must end in an alphanumeric character, and a following word
// character or hyphen vetoes the match outright (it is not a trim
// point). The URL form is shortened by repeatedly keeping the longest
// prefix that does not end in dangling punctuation, an entity, or an
// unbalanced closing bracket.
const BACKPEDAL = /^(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
const EMAIL_CORE = '[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])';
const MAILTO_RE = new RegExp('^mailto:' + EMAIL_CORE);
const XMPP_RE = new RegExp('^xmpp:' + EMAIL_CORE + '(?:\\/[A-Za-z0-9@.]+)?');
const EMAIL_RE = new RegExp('^' + EMAIL_CORE);
const URL_FULL_RE = /^(?:(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9-]+\.?)+[^\s<]*/;

function matchExtendedAutolink(text, i) {
  const rest = text.slice(i, i + 300);
  if (rest.startsWith('mailto:')) {
    const m = MAILTO_RE.exec(rest);
    if (m) return { href: m[0], text: m[0], end: i + m[0].length };
    return null;
  }
  if (rest.startsWith('xmpp:')) {
    const m = XMPP_RE.exec(rest);
    if (m) return { href: m[0], text: m[0], end: i + m[0].length };
    return null;
  }
  const um = URL_FULL_RE.exec(rest);
  if (um) {
    let cur = um[0];
    for (;;) {
      const b = BACKPEDAL.exec(cur);
      const next = b ? b[0] : '';
      if (next === cur || next === '') { cur = next; break; }
      cur = next;
    }
    if (cur.startsWith('www.') ? cur.length > 4 : cur.includes('://')) {
      const href = cur.startsWith('www.') ? 'http://' + cur : cur;
      return { href, text: cur, end: i + cur.length };
    }
    return null;
  }
  const em = EMAIL_RE.exec(rest);
  if (em) return { href: 'mailto:' + em[0], text: em[0], end: i + em[0].length };
  return null;
}

// --- emphasis / strikethrough matching -------------------------------------
// The reference renderer's inline scanner is greedy and left-to-right: at a
// delimiter run it looks for the matching closer with a set of contextual
// patterns over a masked copy of the source (links, code spans, tags and
// escapes blanked out so delimiters inside them stay invisible). The
// patterns below encode those context classes directly: P = punctuation or
// symbol, PS = whitespace/punctuation/symbol, NPS = anything else.

const CLS_P = '[\\p{P}\\p{S}]';
const CLS_PS = '[\\s\\p{P}\\p{S}]';
const CLS_NPS = '[^\\s\\p{P}\\p{S}]';

function rDelimRegex(ch) {
  // Tilde-aware classes for '*': a '~' counts as a word character, not as
  // punctuation, so strikethrough delimiters never disturb emphasis.
  const PT = '(?!~)[\\p{P}\\p{S}]';
  const PST = '(?!~)[\\s\\p{P}\\p{S}]';
  const NPST = '(?:[^\\s\\p{P}\\p{S}]|~)';
  const P = '[\\p{P}\\p{S}]';
  const PS = '[\\s\\p{P}\\p{S}]';
  const NPS = '[^\\s\\p{P}\\p{S}]';
  if (ch === '*') {
    return new RegExp(
      '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)' +
      '|[^*]+(?=[^*])' +
      '|(?!\\*)' + PT + '(\\*+)(?=[\\s]|$)' +
      '|' + NPST + '(\\*+)(?!\\*)(?=' + PST + '|$)' +
      '|(?!\\*)' + PST + '(\\*+)(?=' + NPST + ')' +
      '|[\\s](\\*+)(?!\\*)(?=' + PT + ')' +
      '|(?!\\*)' + PT + '(\\*+)(?!\\*)(?=' + PT + ')' +
      '|' + NPST + '(\\*+)(?=' + NPST + ')',
      'gu');
  }
  return new RegExp(
    '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)' +
    '|[^_]+(?=[^_])' +
    '|(?!_)' + P + '(_+)(?=[\\s]|$)' +
    '|' + NPS + '(_+)(?!_)(?=' + PS + '|$)' +
    '|(?!_)' + PS + '(_+)(?=' + NPS + ')' +
    '|[\\s](_+)(?!_)(?=' + P + ')' +
    '|(?!_)' + P + '(_+)(?!_)(?=' + P + ')',
    'gu');
}

const DEL_RDELIM = new RegExp(
  '^[^~]+(?=[^~])' +
  '|(?!~)[\\p{P}\\p{S}](~~?)(?=[\\s]|$)' +
  '|[^\\s\\p{P}\\p{S}](~~?)(?!~)(?=[\\s\\p{P}\\p{S}]|$)' +
  '|(?!~)[\\s\\p{P}\\p{S}](~~?)(?=[^\\s\\p{P}\\p{S}])' +
  '|[\\s](~~?)(?!~)(?=[\\p{P}\\p{S}])' +
  '|(?!~)[\\p{P}\\p{S}](~~?)(?!~)(?=[\\p{P}\\p{S}])' +
  '|[^\\s\\p{P}\\p{S}](~~?)(?=[^\\s\\p{P}\\p{S}])',
  'gu');

const PUNCT_RE = /[\p{P}\p{S}]/u;
const ALNUM_RE = /[\p{L}\p{N}]/u;

// Build the masked copy of an inline run: code spans, links, reference
// links that resolve, autolinks and tags collapse to [aaa...] of the same
// length, and backslash-escaped punctuation becomes '+' characters.
// The masked twin of an inline text, used by the emphasis matcher so
// delimiters inside other constructs stay invisible. It is built in
// three length-preserving passes, in the same order the reference
// lexer masks its source: resolvable reference links first, then
// escaped punctuation and the defusing of backticks inside code spans,
// then inline links, code spans and tags.
function maskSource(text, links) {
  let s = text;
  if (s.includes('[')) s = maskReflinks(s, links);
  if (s.includes('\\') || s.includes('`')) s = defuseInline(s);
  if (s.includes('[') || s.includes('`') || s.includes('<')) s = maskBlockSkip(s);
  return s;
}

function maskSpan(a, b) {
  // [aaa...] covering s[a..b] inclusive, keeping the total length
  const len = b - a + 1;
  return len >= 2 ? '[' + 'a'.repeat(len - 2) + ']' : 'a'.repeat(len);
}

// Pass 1: mask reference-style links whose label resolves. A candidate
// whose text itself holds a link is not flattened; only the links
// inside it are masked (images are exempt from that rule).
function maskReflinks(s, links) {
  let out = '';
  let last = 0;
  let i = 0;
  const n = s.length;
  const emit = (from, to, replacement) => {
    out += s.slice(last, from) + replacement;
    last = to;
  };
  while (i < n) {
    const isImg = s[i] === '!' && s[i + 1] === '[';
    if (s[i] === '[' || isImg) {
      const open = isImg ? i + 1 : i;
      const close = findCloseBracket(s, open);
      if (close !== -1) {
        const label = s.slice(open + 1, close);
        let end = -1;
        let refText = null;
        if (s[close + 1] === '[' && s[close + 2] === ']') {
          refText = label;
          end = close + 2;
        } else if (s[close + 1] === '[') {
          const c2 = findCloseBracket(s, close + 1);
          if (c2 !== -1) { refText = s.slice(close + 2, c2); end = c2; }
        } else if (s[close + 1] !== '(') {
          refText = label;
          end = close;
        }
        if (end !== -1 && refText !== null && links.has(normLabel(refText))) {
          if (!isImg && containsLink(label, links)) {
            let replacement = s.slice(i, open + 1) + maskReflinks(label, links) + ']';
            if (end > close) replacement += '[' + 'a'.repeat(Math.max(0, end - close - 2)) + (end - close >= 2 ? ']' : '');
            emit(i, end + 1, replacement);
            i = end + 1;
            continue;
          }
          emit(i, end + 1, maskSpan(i, end));
          i = end + 1;
          continue;
        }
      }
      i++; continue;
    }
    i++;
  }
  return last === 0 ? s : out + s.slice(last);
}

// Pass 2: escaped punctuation becomes '+', and backticks inside a code
// span become '+' (the delimiters stay), so later passes can treat the
// span's content as backtick-free.
function defuseInline(s) {
  let out = '';
  let last = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < n) {
      const pair = s.slice(i + 1, i + 3);
      const pm = /^[\p{P}\p{S}]/u.exec(pair);
      if (pm) {
        const len = 1 + pm[0].length;
        out += s.slice(last, i) + '+'.repeat(len);
        i += len;
        last = i;
        continue;
      }
      i++; continue;
    }
    if (ch === '`') {
      let run = 1;
      while (s[i + run] === '`') run++;
      const close = findCodeClose(s, i + run, run);
      if (close !== -1) {
        out += s.slice(last, i) + '`'.repeat(run) + s.slice(i + run, close).replace(/`/g, '+') + '`'.repeat(run);
        i = close + run;
        last = i;
        continue;
      }
      i += run;
      continue;
    }
    i++;
  }
  return last === 0 ? s : out + s.slice(last);
}

// The label scan for masking: no brackets may appear in a label, but
// code units (a run, backtick-free content, the same run) may.
function blockSkipLabelEnd(s, open) {
  let j = open + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === ']') return j;
    if (c === '[') return -1;
    if (c === '`') {
      let run = 1;
      while (s[j + run] === '`') run++;
      let k = j + run;
      while (k < s.length && s[k] !== '`') k++;
      if (k >= s.length) return -1;
      let r2 = 1;
      while (s[k + r2] === '`') r2++;
      if (r2 !== run) return -1;
      j = k + r2;
      continue;
    }
    j++;
  }
  return -1;
}

// The destination scan for masking: an opening paren, then escaped
// characters, plain characters, or one nested paren pair, to the
// closing paren.
function blockSkipDestEnd(s, openParen) {
  let depth = 0;
  let j = openParen;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '(') {
      depth++;
      if (depth > 2) return -1;
      j++;
      continue;
    }
    if (c === ')') {
      depth--;
      j++;
      if (depth === 0) return j - 1;
      continue;
    }
    j++;
  }
  return -1;
}

// Pass 3: mask inline links, code spans and tags.
function maskBlockSkip(s) {
  let out = '';
  let last = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    const isImg = ch === '!' && s[i + 1] === '[';
    if (ch === '[' || isImg) {
      const open = isImg ? i + 1 : i;
      const close = blockSkipLabelEnd(s, open);
      if (close !== -1 && s[close + 1] === '(') {
        const end = blockSkipDestEnd(s, close + 1);
        if (end !== -1) {
          out += s.slice(last, i) + maskSpan(i, end);
          i = end + 1;
          last = i;
          continue;
        }
      }
      i++; continue;
    }
    if (ch === '`') {
      let run = 1;
      while (s[i + run] === '`') run++;
      let j = i + run;
      while (j < n && s[j] !== '`') j++;
      if (j < n) {
        let r2 = 1;
        while (s[j + r2] === '`') r2++;
        if (r2 === run) {
          out += s.slice(last, i) + maskSpan(i, j + r2 - 1);
          i = j + r2;
          last = i;
          continue;
        }
      }
      i += run;
      continue;
    }
    if (ch === '<' && s[i + 1] !== ' ') {
      const m = /^<[^<>]*?>/.exec(s.slice(i));
      if (m) {
        out += s.slice(last, i) + maskSpan(i, i + m[0].length - 1);
        i += m[0].length;
        last = i;
        continue;
      }
      i++; continue;
    }
    i++;
  }
  return last === 0 ? s : out + s.slice(last);
}

function findCodeClose(text, from, run) {
  let i = from;
  while (i < text.length) {
    if (text[i] === '`') {
      let r = 1;
      while (text[i + r] === '`') r++;
      if (r === run) return i;
      i += r; continue;
    }
    i++;
  }
  return -1;
}

// Try to match emphasis/strong starting at the delimiter run at index i of
// text (masked is the masked twin). Returns { tag, inner, rawLen } or null.
function matchEmStrong(text, masked, i, prevChar) {
  const ch = text[i];
  let run = 1;
  while (text[i + run] === ch) run++;
  const after = i + run < text.length ? text[i + run] : '';
  // left-delimiter shape: the run must be followed by punctuation (the
  // tilde-aware punctuation class) or by a non-space character
  let nextIsPunct = false, nextIsNonSpace = false;
  if (after !== '') {
    if (after !== '~' && PUNCT_RE.test(after)) nextIsPunct = true;
    else if (!/\s/.test(after)) nextIsNonSpace = true;
  }
  if (!nextIsPunct && !nextIsNonSpace) return null;
  // whole-run context for rules 9-10
  let runStart = i;
  while (runStart > 0 && masked[runStart - 1] === ch) runStart--;
  const runPrevChar = runStart > 0 ? masked[runStart - 1] : '';
  const effPrevChar = runStart < i ? runPrevChar : prevChar;
  if (ch === '_' && nextIsNonSpace && effPrevChar !== '' && ALNUM_RE.test(effPrevChar)) return null;
  const nextChar = nextIsPunct ? after : '';
  const prevPunct = effPrevChar !== '' && effPrevChar !== '*' && effPrevChar !== '_' && /[\s\p{P}\p{S}]/u.test(effPrevChar);
  if (nextChar && effPrevChar && !prevPunct) return null;
  const runPrevPunct = runPrevChar !== '' && /[\s\p{P}\p{S}]/u.test(runPrevChar);
  const runLength = (i - runStart) + run;
  const midRun = prevChar === ch;
  const openerCanClose = runPrevChar !== '' && !!runPrevChar.trim() && (!!nextChar || (ch === '*' && !runPrevPunct));
  const lLength = run;
  const endReg = ch === '*' ? RDELIM_STAR : RDELIM_UND;
  const window = masked.slice(i + lLength);
  let delimTotal = lLength, midDelimTotal = 0;
  let match;
  endReg.lastIndex = 0;
  while ((match = endReg.exec(window)) !== null) {
    const rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
    if (!rDelim) continue;
    let rLength = rDelim.length;
    if (match[3] || match[4]) { delimTotal += rLength; continue; }
    if (match[5] || match[6] || openerCanClose) {
      if (midRun && (match[5] || match[6])) break;
      if (runLength % 3 && !((runLength + rLength) % 3)) { midDelimTotal += rLength; continue; }
    }
    delimTotal -= rLength;
    if (delimTotal > 0) continue;
    rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
    const firstCharLen = match[0].codePointAt(0) > 0xFFFF ? 2 : 1;
    const rawLen = lLength + match.index + firstCharLen + rLength;
    const raw = text.slice(i, i + rawLen);
    if (Math.min(lLength, rLength) % 2) {
      return { tag: 'em', inner: raw.slice(1, -1), rawLen };
    }
    return { tag: 'strong', inner: raw.slice(2, -2), rawLen };
  }
  return null;
}

// Try to match strikethrough at index i. Returns { inner, rawLen } or null.
const RDELIM_STAR = rDelimRegex('*');
const RDELIM_UND = rDelimRegex('_');

function matchDel(text, masked, i, prevChar) {
  let run = 1;
  while (text[i + run] === '~') run++;
  if (run > 2) run = 2;
  const after = i + run < text.length ? text[i + run] : '';
  let nextIsPunct = false, nextIsNonSpace = false;
  if (after !== '') {
    if (after !== '~' && PUNCT_RE.test(after)) nextIsPunct = true;
    else if (!/\s/.test(after) && after !== '~') nextIsNonSpace = true;
  }
  if (!nextIsPunct && !nextIsNonSpace) return null;
  const nextChar = nextIsPunct ? after : '';
  const prevPunctD = prevChar !== '' && prevChar !== '*' && prevChar !== '_' && /[\s\p{P}\p{S}]/u.test(prevChar);
  if (nextChar && prevChar && !prevPunctD) return null;
  const lLength = run;
  const window = masked.slice(i + lLength);
  const endReg = DEL_RDELIM;
  endReg.lastIndex = 0;
  let delimTotal = lLength;
  let match;
  while ((match = endReg.exec(window)) !== null) {
    const rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
    if (!rDelim) continue;
    let rLength = rDelim.length;
    if (rLength !== lLength) continue;
    if (match[3] || match[4]) { delimTotal += rLength; continue; }
    delimTotal -= rLength;
    if (delimTotal > 0) continue;
    rLength = Math.min(rLength, rLength + delimTotal);
    const firstCharLen = match[0].codePointAt(0) > 0xFFFF ? 2 : 1;
    const rawLen = lLength + match.index + firstCharLen + rLength;
    const raw = text.slice(i, i + rawLen);
    return { inner: raw.slice(lLength, raw.length - lLength), rawLen };
  }
  return null;
}


// Could an email autolink start at i? The local part is a run of
// word chars and ._%+- immediately followed by '@'.
function hasEmailAhead(text, i) {
  let k = i;
  const n = text.length;
  while (k < n) {
    const c = text[k];
    if (isAlnumCh(c) || c === '.' || c === '_' || c === '%' || c === '+' || c === '-') { k++; continue; }
    return c === '@';
  }
  return false;
}

// Could a www. or scheme:// autolink start at i?
function hasUrlAhead(text, i) {
  if (text.startsWith('www.', i)) return true;
  let k = i;
  const n = text.length;
  while (k < n) {
    const c = text[k];
    if (isAlnumCh(c) || c === '+' || c === '.' || c === '-') { k++; continue; }
    return c === ':' && text[k + 1] === '/' && text[k + 2] === '/';
  }
  return false;
}

// Advance over plain text starting at i, returning the index of the
// next position that needs branch handling (or the end). A position
// needs handling when it holds a special character, or when an
// autolink might start there.
// Why scanPlainRun stopped: 0 = end of text, 1 = a special character,
// 2 = a possible www/scheme autolink start, 3 = a possible bare email
// start. Set on every call; read before anything else can overwrite it.
let runStopKind = 0;

function scanPlainRun(text, i, inLink) {
  const n = text.length;
  let j = i;
  runStopKind = 0;
  while (j < n) {
    const c = text[j];
    if (c === '\\' || c === '`' || c === '!' || c === '[' || c === '<' || c === '*' || c === '_' || c === '~' || c === '\n') { runStopKind = 1; break; }
    const prev = j > 0 ? text[j - 1] : '';
    if (c === 'w' || c === 'h' || c === 'f' || c === 'W' || c === 'H' || c === 'F' || c === 'm' || c === 'x') {
      if (!isAlnumCh(prev)) { runStopKind = 2; break; }
      j++; continue;
    }
    if (!inLink && !docInLink && isAlnumCh(c)
      && !isAlnumCh(prev) && prev !== '.' && prev !== '_' && prev !== '%' && prev !== '+' && prev !== '-') { runStopKind = 3; break; }
    j++;
  }
  return j;
}

// The autolink attempts shared by the trigger-letter and email-start
// stops. Returns the end index after a formed autolink, or -1.
function tryAutolinks(text, i, inLink, parts, flush) {
  const ch = text[i];
  if ((ch === 'w' || ch === 'h' || ch === 'f' || ch === 'W' || ch === 'H' || ch === 'F') && (i === 0 || !isAlnumCh(text[i - 1])) && !inLink && !docInLink && hasUrlAhead(text, i)) {
    const auto = matchExtendedAutolink(text, i);
    if (auto && (auto.text.startsWith('www.') || auto.text.includes('://'))) {
      flush();
      parts.push('<a href="' + escHtml(cleanHref(auto.href), true) + '">' + renderTextRun(auto.text) + '</a>');
      return auto.end;
    }
  }
  if ((ch === 'm' || ch === 'x') && !inLink && !docInLink && (i === 0 || !isAlnumCh(text[i - 1]))
    && (text.startsWith('mailto:', i) || text.startsWith('xmpp:', i))) {
    const auto = matchExtendedAutolink(text, i);
    if (auto) {
      flush();
      parts.push('<a href="' + escHtml(cleanHref(auto.href), true) + '">' + renderTextRun(auto.text) + '</a>');
      return auto.end;
    }
  }
  if (isAlnumCh(ch) && !inLink && !docInLink) {
    const prev = i > 0 ? text[i - 1] : '';
    if (!isAlnumCh(prev) && prev !== '.' && prev !== '_' && prev !== '%' && prev !== '+' && prev !== '-' && hasEmailAhead(text, i)) {
      const auto = matchExtendedAutolink(text, i);
      if (auto && auto.href.startsWith('mailto:')) {
        flush();
        parts.push('<a href="' + escHtml(cleanHref(auto.href), true) + '">' + renderTextRun(auto.text) + '</a>');
        return auto.end;
      }
    }
  }
  return -1;
}

// Main inline renderer: a single left-to-right scan.
function parseInline(text, links, inLink) {
  // Masking only matters for emphasis matching, and it can only change
  // something when the text holds a bracket, backtick, tag or escape.
  const masked = (text.includes('*') || text.includes('_') || text.includes('~'))
    && /[`[\\<]/.test(text) ? maskSource(text, links) : text;
  const parts = [];
  let buf = '';
  const flush = () => { if (buf) { parts.push(renderTextRun(buf)); buf = ''; } };
  let i = 0;
  const n = text.length;
  while (i < n) {
    const runEnd = scanPlainRun(text, i, inLink);
    if (runEnd > i) { buf += text.slice(i, runEnd); i = runEnd; if (i >= n) break; }
    if (runStopKind === 2 || runStopKind === 3) {
      const end = tryAutolinks(text, i, inLink, parts, flush);
      if (end !== -1) { i = end; continue; }
      buf += text[i]; i++; continue;
    }
    const ch = text[i];
    if (ch === '\\') {
      const nx = text[i + 1];
      if (nx === '\n') {
        flush(); parts.push('<br>');
        i += 2;
        while (text[i] === ' ' || text[i] === '\t') i++;
        continue;
      }
      if (nx !== undefined && ESCAPABLE.includes(nx)) { buf += nx === '&' ? '\u0001' : nx; i += 2; continue; }
      buf += ch; i++; continue;
    }
    if (ch === '`') {
      let run = 1;
      while (text[i + run] === '`') run++;
      const close = findCodeClose(text, i + run, run);
      if (close === -1) { buf += '`'.repeat(run); i += run; continue; }
      let content = text.slice(i + run, close).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') {
        content = content.slice(1, -1);
      }
      flush();
      parts.push('<code>' + escHtml(content, false) + '</code>');
      i = close + run; continue;
    }
    if (ch === '!' && text[i + 1] === '[') {
      const f = tryFormLink(text, i + 1, true, links);
      if (f) { flush(); parts.push(f.html); i = f.end; continue; }
      buf += ch; i++; continue;
    }
    if (ch === '[') {
      const f = tryFormLink(text, i, false, links);
      if (f) { flush(); parts.push(f.html); i = f.end; continue; }
      buf += ch; i++; continue;
    }
    if (ch === '<') {
      ANGLE_AUTO_RE.lastIndex = i;
      ANGLE_MAIL_RE.lastIndex = i;
      const auto = ANGLE_AUTO_RE.exec(text) || ANGLE_MAIL_RE.exec(text);
      if (auto) {
        flush();
        const isEmail = auto[1].includes('@') && !auto[1].includes(':');
        const href = isEmail ? 'mailto:' + auto[1] : auto[1];
        parts.push('<a href="' + escHtml(cleanHref(href), true) + '">' + renderTextRun(auto[1]) + '</a>');
        i += auto[0].length; continue;
      }
      TAG_AT_RE.lastIndex = i;
      const tag = TAG_AT_RE.exec(text);
      if (tag) {
        flush();
        parts.push(tag[0]);
        if (!docInLink && /^<a /i.test(tag[0])) docInLink = true;
        else if (docInLink && /^<\/a>/i.test(tag[0])) docInLink = false;
        i += tag[0].length; continue;
      }
      buf += ch; i++; continue;
    }
    if (ch === '*' || ch === '_') {
      const prevChar = i > 0 ? text[i - 1] : '';
      const m = matchEmStrong(text, masked, i, prevChar);
      if (m) {
        flush();
        parts.push('<' + m.tag + '>' + parseInline(m.inner, links, inLink) + '</' + m.tag + '>');
        i += m.rawLen; continue;
      }
      buf += ch; i++; continue;
    }
    if (ch === '~') {
      const prevChar = i > 0 ? text[i - 1] : '';
      const m = matchDel(text, masked, i, prevChar);
      if (m) {
        flush();
        parts.push('<del>' + parseInline(m.inner, links, inLink) + '</del>');
        i += m.rawLen; continue;
      }
      buf += ch; i++; continue;
    }
    if (ch === '\n') {
      let sp = 0;
      while (sp < buf.length && buf[buf.length - 1 - sp] === ' ') sp++;
      if (sp >= 2) {
        buf = buf.slice(0, buf.length - sp);
        flush();
        parts.push('<br>');
        i++;
        while (text[i] === ' ' || text[i] === '\t') i++;
        continue;
      }
      buf += ch; i++; continue;
    }
    buf += ch; i++;
  }
  flush();
  return parts.join('');
}

// Try to form a link or image whose '[' sits at openIdx. The reference
// scanner attempts a link at the bracket itself: inline destination
// first, then a full or collapsed reference, then a shortcut reference.
// A link whose label itself contains a link never forms.
// Bracket matching with the simple label grammar (used for shortcut
// references when the rich grammar fails): backticks are ordinary
// characters, only escapes and bracket balance matter.
function findCloseBracketSimple(text, openIdx) {
  let depth = 0;
  let i = openIdx;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

function tryFormLink(text, openIdx, isImage, links) {
  // One label parse, attempted: returns a finished link, STOP when a
  // completed parse's definition lookup failed (no other parse may be
  // tried), or NEXT when the parse's tail did not complete.
  const STOP = { stop: true };
  const NEXT = { next: true };
  const attempt = (close) => {
    const labelText = text.slice(openIdx + 1, close);
    const after = close + 1;
    if (text[after] === '(') {
      const d = parseLinkDest(text, after);
      if (!d) return NEXT;
      const f = finishLink(labelText, d.href, d.title, d.end, isImage, links);
      return f ? { value: f } : STOP;
    }
    if (text[after] === '[') {
      const close2 = findCloseBracket(text, after);
      if (close2 !== -1) {
        const refLabel = text.slice(after + 1, close2);
        const def = links.get(normLabel(refLabel === '' ? labelText : refLabel));
        if (!def) return STOP;
        const f = finishLink(labelText, def.href, def.title, close2 + 1, isImage, links);
        return f ? { value: f } : STOP;
      }
    }
    const def = links.get(normLabel(labelText));
    if (!def) return STOP;
    const f = finishLink(labelText, def.href, def.title, after, isImage, links);
    return f ? { value: f } : STOP;
  };
  const fast = scanBracketPlain(text, openIdx);
  if (fast >= 0) {
    const r = attempt(fast);
    if (r.value) return r.value;
    if (r === STOP) return null;
    // the plain parse's tail failed: richer parses may still exist
    // only when a backtick follows later in the text
    if (!text.includes('`', fast)) return shortcutFallback(text, openIdx, isImage, links);
  } else if (fast === -1) {
    return shortcutFallback(text, openIdx, isImage, links);
  }
  let tried = 0;
  for (const close of labelCloseCandidates(text, openIdx)) {
    if (++tried > 12) break;
    if (close === fast) continue;
    const r = attempt(close);
    if (r.value) return r.value;
    if (r === STOP) return null;
  }
  return shortcutFallback(text, openIdx, isImage, links);
}

function shortcutFallback(text, openIdx, isImage, links) {
  // No rich-grammar parse: a shortcut or collapsed reference may still
  // form under the simple label grammar.
  const closeS = findCloseBracketSimple(text, openIdx);
  if (closeS === -1) return null;
  const labelS = text.slice(openIdx + 1, closeS);
  if (/\n[ \t]*\n/.test(labelS)) return null;
  let endS = -1;
  let defS = null;
  if (text[closeS + 1] === '[' && text[closeS + 2] === ']') {
    defS = links.get(normLabel(labelS));
    if (defS) endS = closeS + 3;
  }
  if (endS === -1) {
    defS = links.get(normLabel(labelS));
    if (defS) endS = closeS + 1;
  }
  if (endS === -1 || !defS) return null;
  return finishLink(labelS, defS.href, defS.title, endS, isImage, links);
}

function finishLink(labelText, href, title, end, isImage, links) {
  if (!isImage && containsLink(labelText, links)) return null;
  const hrefAttr = escHtml(cleanHref(unescapePunct(href)), true);
  const savedInLink = docInLink;
  if (isImage) {
    const innerHtml = parseInline(labelText, links, false);
    docInLink = savedInLink;
    const alt = innerHtml.replace(/<img[^>]*? alt="([^"]*)"[^>]*?>/g, '$1').replace(/<[^>]*>/g, '');
    let html = '<img src="' + hrefAttr + '" alt="' + alt + '"';
    if (title !== null) html += ' title="' + escHtml(cleanTitle(title), true) + '"';
    return { html: html + '>', end };
  }
  let html = '<a href="' + hrefAttr + '"';
  if (title !== null) html += ' title="' + escHtml(cleanTitle(title), true) + '"';
  html += '>' + parseInline(labelText, links, true) + '</a>';
  docInLink = savedInLink;
  return { html, end };
}

// Does this label text itself contain a link (not an image)? Then the
// outer brackets cannot form a link either.
function containsLink(labelText, links) {
  if (!labelText.includes('[')) return false;
  let depth = 0;
  for (let i = 0; i < labelText.length; i++) {
    const ch = labelText[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '[') {
      if (i > 0 && labelText[i - 1] === '!') {
        // an image never counts as a nested link: skip its whole form,
        // including a destination or reference part, so the reference
        // bracket is not misread as a shortcut link
        const c0 = findCloseBracket(labelText, i);
        if (c0 === -1) return false;
        let end = c0;
        if (labelText[end + 1] === '(') {
          const d = parseLinkDest(labelText, end + 1);
          if (d) end = d.end - 1;
        } else if (labelText[end + 1] === '[') {
          const c2 = findCloseBracket(labelText, end + 1);
          if (c2 !== -1) end = c2;
        }
        i = end;
        continue;
      }
      const close = findCloseBracket(labelText, i);
      if (close === -1) return false;
      const after = labelText[close + 1];
      if (after === '(' && parseLinkDest(labelText, close + 1)) return true;
      if (after === '[') {
        const c2 = findCloseBracket(labelText, close + 1);
        if (c2 !== -1) {
          const ref = labelText.slice(close + 2, c2);
          const lab = labelText.slice(i + 1, close);
          if (links.has(normLabel(ref === '' ? lab : ref))) return true;
        }
      }
      if (after !== '(' && after !== '[') {
        const lab = labelText.slice(i + 1, close);
        if (links.has(normLabel(lab))) return true;
      }
      i = close;
    }
  }
  return false;
}

// ---------- block parsing ----------
//
// parseBlocks turns source text into a list of block nodes:
//   { kind: 'html', html }      finished HTML (already ends with \n)
//   { kind: 'para', text }      a paragraph (raw inline source)
//   { kind: 'heading', depth, text }
// Link definitions are registered into `links` and produce no node.

const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

// Column width of the leading indentation of a line, and the index where
// that indentation ends when `cols` columns are consumed.
function leadingIndent(line) {
  let col = 0, i = 0;
  while (i < line.length) {
    if (line[i] === ' ') { col++; i++; }
    else if (line[i] === '\t') { col += 4 - (col % 4); i++; }
    else break;
  }
  return { cols: col, idx: i };
}
// Remove one indented-code unit from a line: up to three spaces
// followed by a tab, or one to four spaces. A tab met inside the unit
// is consumed whole and ends it, so a tab after four spaces survives.
function dedentCode(line) {
  let i = 0, spaces = 0;
  while (i < line.length) {
    if (line[i] === ' ') {
      if (spaces === 4) break;
      spaces++; i++;
    } else if (line[i] === '\t') {
      if (spaces <= 3) i++;
      break;
    } else break;
  }
  return line.slice(i);
}

function stripCols(line, cols) {
  // Expand the leading whitespace run to plain spaces (tabs run to the
  // next multiple-of-four column), then drop `cols` of them. Whitespace
  // later in the line is untouched.
  let col = 0, i = 0, prefix = '';
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === ' ') { prefix += ' '; col++; i++; }
    else { const w = 4 - (col % 4); prefix += ' '.repeat(w); col += w; i++; }
  }
  if (prefix.length >= cols) return prefix.slice(cols) + line.slice(i);
  return line.slice(i);
}

// Expand a whitespace run to spaces, given the column the run starts at.
// Expand tabs in a line's leading whitespace run to spaces.
function expandLeadingTabs(line) {
  const m = /^[ \t]*/.exec(line);
  return expandWs(m[0], 0) + line.slice(m[0].length);
}

function expandWs(ws, startCol) {
  let col = startCol, out = '';
  for (const ch of ws) {
    if (ch === '\t') { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; }
    else { out += ' '; col++; }
  }
  return out;
}
// Drop trailing blank lines, but keep the string whole when no more
// than two line elements follow the last content line.
function trimTrailingBlankLines(str) {
  const ls = str.split('\n');
  let end = ls.length - 1;
  while (end >= 0 && /^[ \t]*$/.test(ls[end])) end--;
  if (ls.length - end <= 2) return str;
  return ls.slice(0, end + 1).join('\n');
}

function isBlankLine(line) {
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

// Split source into lines without their \n terminators.
function toLines(src) {
  const lines = src.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Try to read one link reference definition starting at lines[i].
// Returns { label, href, title, next } or null.
function readDef(lines, i) {
  const first = lines[i];
  let hp = 0;
  while (hp < 4 && first[hp] === ' ') hp++;
  if (hp > 3 || first[hp] !== '[') return null;
  let rest = first.slice(hp + 1);
  // label may span lines; it ends at the first unescaped ']' and may not
  // contain an unescaped '[' (or be blank)
  let label = '';
  let li = i;
  let found = false;
  let cur = rest;
  while (li < lines.length && li <= i + 2) {
    let bad = false;
    let close = -1;
    for (let k = 0; k < cur.length; k++) {
      if (cur[k] === '\\') { k++; continue; }
      if (cur[k] === '[') { bad = true; break; }
      if (cur[k] === ']') { close = k; break; }
    }
    if (bad) return null;
    if (close !== -1) {
      label += cur.slice(0, close);
      rest = cur.slice(close + 1);
      found = true;
      break;
    }
    label += cur + '\n';
    li++;
    cur = lines[li] ?? '';
    if (cur.trim() === '') return null;
  }
  if (!found || rest[0] !== ':') return null;
  if (normLabel(label) === '') return null;
  rest = rest.slice(1);
  // destination: possibly on the next line
  let lineIdx = li;
  let s = rest;
  const skipWs = () => {
    for (;;) {
      const t = s.replace(/^[ \t]+/, '');
      if (t === '' && lineIdx + 1 < lines.length && s !== '') {
        // only a line break counts when something was consumed or line ended
      }
      s = t;
      if (s !== '') break;
      if (lineIdx + 1 >= lines.length) break;
      lineIdx++;
      s = lines[lineIdx];
      if (!/^[ \t]/.test(s) && s !== '') { /* destination must be indented? no: it can start at col 0 on next line */ }
      s = s.replace(/^[ \t]+/, '');
      break;
    }
  };
  skipWs();
  let href = null;
  if (s[0] === '<') {
    const gt = s.indexOf('>');
    if (gt === -1) return null;
    href = s.slice(1, gt);
    s = s.slice(gt + 1);
  } else {
    const m = /^\S+/.exec(s);
    if (!m) return null;
    href = m[0];
    s = s.slice(m[0].length);
  }
  href = unescapePunct(href);
  // a bare destination may only hold balanced parentheses
  {
    let depth = 0, bad = false;
    const rawDest = href;
    for (let k = 0; k < rawDest.length; k++) {
      if (rawDest[k] === '(') depth++;
      else if (rawDest[k] === ')') { depth--; if (depth < 0) { bad = true; break; } }
    }
    if (bad) return null;
  }
  // optional title: it must be separated from the destination by spaces
  // or by the line break; a title on the next line that does not parse
  // cleanly is simply not part of the definition
  let title = null;
  const afterDest = s;
  const parseTitleFrom = (text, allowMultiline, startLine) => {
    const q = text[0];
    if (q !== '"' && q !== "'" && q !== '(') return null;
    const close = q === '(' ? ')' : q;
    let buf = '';
    let cur = text;
    let ln = startLine;
    for (;;) {
      let k = ln === startLine ? 1 : 0;
      let closedAt = -1;
      while (k < cur.length) {
        if (cur[k] === '\\' && k + 1 < cur.length) { buf += cur[k] + cur[k + 1]; k += 2; continue; }
        if (cur[k] === close) { closedAt = k; break; }
        if (q === '(' && cur[k] === '(') return null;
        buf += cur[k]; k++;
      }
      if (closedAt !== -1) {
        return { title: unescapePunct(buf), tail: cur.slice(closedAt + 1), line: ln };
      }
      if (!allowMultiline) return null;
      ln++;
      if (ln >= lines.length || isBlankLine(lines[ln])) return null;
      buf += '\n';
      cur = lines[ln];
    }
  };
  if (/^[ \t]*$/.test(afterDest)) {
    // maybe a title on the next line
    if (lineIdx + 1 < lines.length) {
      const nxt = lines[lineIdx + 1];
      const lead = /^[ \t]*/.exec(nxt)[0].length;
      const t = parseTitleFrom(nxt.slice(lead), true, lineIdx + 1);
      if (t && /^[ \t]*$/.test(t.tail)) {
        return { label, href, title: t.title, next: t.line + 1 };
      }
    }
    return { label, href, title, next: lineIdx + 1 };
  }
  if (/^[ \t]/.test(afterDest)) {
    const t = parseTitleFrom(afterDest.replace(/^[ \t]+/, ''), true, lineIdx);
    if (!t) return null;
    if (!/^[ \t]*$/.test(t.tail)) {
      // junk after a same-line title: the whole definition fails, unless
      // the title actually started on the next line (handled above)
      return null;
    }
    return { label, href, title: t.title, next: t.line + 1 };
  }
  return null;
}
function findLabelEnd(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '[') depth++;
    else if (s[i] === ']') { if (depth === 0) return i; depth--; }
  }
  return -1;
}

const BEGIN_RES = [0, 1, 2, 3].map((k) => {
  const pre = '^ {0,' + k + '}';
  return {
    fence: new RegExp(pre + '(?:`{3,}|~{3,})'),
    atx: new RegExp(pre + '#{1,6}(?:[ \t]|$)'),
    hr: new RegExp(pre + '((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})[ \\t]*$'),
    quote: new RegExp(pre + '>'),
    list: new RegExp(pre + '(?:[*+-]|\\d{1,9}[.)])(?:[ \t]|$)'),
  };
});
const FENCE_RE = /^ {0,3}(?:(`{3,})([^`]*)|(~{3,})(.*))$/;
const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/;
const HR_RE = /^ {0,3}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})[ \t]*$/;
const QUOTE_RE = /^ {0,3}>[ \t]?/;
const LIST_RE = /^ {0,3}([*+-]|\d{1,9}[.)])([ \t]+|$)/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
const TABLE_ALIGN_RE = /^ {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)$/;

// Is this line a closing fence for the given marker run?
function isFenceClose(line, marker) {
  const ch = marker[0];
  let p = 0;
  while (p < 4 && line[p] === ' ') p++;
  if (p > 3 || line[p] !== ch) return false;
  let r = 0;
  while (line[p + r] === ch) r++;
  if (r < marker.length) return false;
  for (let k = p + r; k < line.length; k++) {
    if (line[k] !== ' ' && line[k] !== '\t') return false;
  }
  return true;
}

// Does this line begin a block that interrupts a paragraph?
function startsBlock(line, inPara) {
  // cheap dispatch on the first non-space character: every block start
  // pattern is anchored at 0-3 spaces, so most lines reject at once
  let p = 0;
  while (p < line.length && line[p] === ' ') p++;
  if (p > 3) return false;
  const c = line[p];
  if (c === '`' || c === '~') return FENCE_RE.test(line);
  if (c === '#') return ATX_RE.test(line);
  if (c === '>') return true;
  if (c === '<') {
    const hb = htmlBlockStart(line);
    return hb >= 1 && hb <= 6;
  }
  if (c === '_' || c === '-' || c === '*') {
    if (HR_RE.test(line)) return true;
    if (c === '_') return false;
  } else if (c !== '+' && !(c >= '0' && c <= '9')) {
    return false;
  }
  const lm = LIST_RE.exec(line);
  if (lm) {
    if (!inPara) return true;
    // a list interrupts a paragraph only when its first item is non-empty,
    // and an ordered list only when it starts at 1
    const rest = line.slice(lm[0].length);
    if (rest.trim() === '') return false;
    if (/\d/.test(lm[1][0]) && parseInt(lm[1], 10) !== 1) return false;
    return true;
  }
  return false;
}

const BLOCK_TAG_SET = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul h1 h2 h3 h4 h5 h6').split(' '));

// Read a tag name starting at pos (a letter); returns [lowerName, end].
function scanTagName(line, pos) {
  const c = line[pos];
  if (c === undefined || !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'))) return null;
  let e = pos + 1;
  while (e < line.length) {
    const d = line[e];
    if ((d >= 'a' && d <= 'z') || (d >= 'A' && d <= 'Z') || (d >= '0' && d <= '9') || d === '-') e++;
    else break;
  }
  return [line.slice(pos, e).toLowerCase(), e];
}

// Would an HTML block (types 1-6) begin on this line if up to `maxLead`
// leading spaces are allowed?
function htmlBeginAt(line, maxLead) {
  let p = 0;
  while (p < maxLead && line[p] === ' ') p++;
  if (line[p] !== '<') return false;
  const c1 = line[p + 1];
  if (c1 === '!') {
    if (line.startsWith('<!--', p) || line.startsWith('<![CDATA[', p)) return true;
    const c2 = line[p + 2];
    return c2 !== undefined && ((c2 >= 'a' && c2 <= 'z') || (c2 >= 'A' && c2 <= 'Z'));
  }
  if (c1 === '?') return true;
  if (c1 === '/') {
    const nm = scanTagName(line, p + 2);
    if (!nm || !BLOCK_TAG_SET.has(nm[0])) return false;
    const a = line[nm[1]];
    return a === undefined || a === ' ' || a === '\t' || a === '>' || (a === '/' && line[nm[1] + 1] === '>');
  }
  const nm = scanTagName(line, p + 1);
  if (!nm) return false;
  const a = line[nm[1]];
  if (nm[0] === 'script' || nm[0] === 'pre' || nm[0] === 'style' || nm[0] === 'textarea') {
    return a === undefined || a === '>' || isSpaceCh(a);
  }
  if (!BLOCK_TAG_SET.has(nm[0])) return false;
  return a === undefined || a === ' ' || a === '\t' || a === '>' || (a === '/' && line[nm[1] + 1] === '>');
}

const HTML_TYPE7_OPEN_RE = /^ {0,3}<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:[^ \t"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t]*\/?>[ \t]*$/;
const HTML_TYPE7_CLOSE_RE = /^ {0,3}<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>[ \t]*$/;

function htmlBlockStart(line) {
  let p = 0;
  while (p < 4 && line[p] === ' ') p++;
  if (p > 3 || line[p] !== '<') return 0;
  const c1 = line[p + 1];
  if (c1 === '!') {
    if (line.startsWith('<!--', p)) return 2;
    if (line.startsWith('<![CDATA[', p)) return 5;
    const c2 = line[p + 2];
    if (c2 !== undefined && ((c2 >= 'a' && c2 <= 'z') || (c2 >= 'A' && c2 <= 'Z'))) return 4;
    return 0;
  }
  if (c1 === '?') return 3;
  if (c1 === '/') {
    const nm = scanTagName(line, p + 2);
    if (nm && BLOCK_TAG_SET.has(nm[0])) {
      const a = line[nm[1]];
      if (a === undefined || a === ' ' || a === '\t' || a === '>' || (a === '/' && line[nm[1] + 1] === '>')) return 6;
    }
    return HTML_TYPE7_CLOSE_RE.test(line) ? 7 : 0;
  }
  const nm = scanTagName(line, p + 1);
  if (!nm) return 0;
  const a = line[nm[1]];
  if (nm[0] === 'script' || nm[0] === 'pre' || nm[0] === 'style' || nm[0] === 'textarea') {
    if (a === undefined || a === '>' || isSpaceCh(a)) return 1;
  } else if (BLOCK_TAG_SET.has(nm[0])) {
    if (a === undefined || a === ' ' || a === '\t' || a === '>' || (a === '/' && line[nm[1] + 1] === '>')) return 6;
  }
  return HTML_TYPE7_OPEN_RE.test(line) ? 7 : 0;
}

// Split a table row into cells. A pipe is a delimiter unless it is
// preceded by an odd number of backslashes; code spans do not protect
// pipes. Delimiters are marked by inserting a space, the row is split
// on space+pipe, empty edge cells (from leading/trailing pipes) are
// dropped, and escaped pipes unfold to literal pipes in the cells.
function splitRow(line) {
  let markedStr = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '|') {
      let bs = 0;
      for (let k = i - 1; k >= 0 && line[k] === '\\'; k--) bs++;
      markedStr += bs % 2 === 1 ? '|' : ' |';
    } else {
      markedStr += line[i];
    }
  }
  const cells = markedStr.split(' |');
  if (cells.length && !cells[0].trim()) cells.shift();
  if (cells.length && !cells[cells.length - 1].trim()) cells.pop();
  return cells.map((c) => c.trim().replace(/\\\|/g, '|'));
}

function tableRowContinues(l) {
  if (/^ *$/.test(l)) return false;
  if (startsBlock(l, true)) return false;
  const cm = /^(?: {4}| {0,3}\t)/.exec(l);
  if (cm && cm[0].length < l.length) return false;
  return true;
}

function parseTable(lines, i, links) {
  if (i + 1 >= lines.length) return null;
  const headerLine = lines[i];
  if (!headerLine.includes('|')) return null;
  const delimLine = lines[i + 1];
  if (!/^[ \t]*\|?[ \t:|-]+$/.test(delimLine) || !delimLine.includes('-')) return null;
  const header = splitRow(headerLine);
  const delims = splitRow(delimLine);
  if (header.length !== delims.length) return null;
  const aligns = [];
  for (const d of delims) {
    if (!/^:?-+:?$/.test(d)) return null;
    if (d.startsWith(':') && d.endsWith(':')) aligns.push('center');
    else if (d.endsWith(':')) aligns.push('right');
    else if (d.startsWith(':')) aligns.push('left');
    else aligns.push(null);
  }
  const rows = [];
  let j = i + 2;
  while (j < lines.length && tableRowContinues(lines[j])) {
    rows.push(splitRow(lines[j]));
    j++;
  }
  return { node: { kind: 'table', header, aligns, rows }, next: j };
}

function renderTable(nd, links) {
  let html = '<table>\n<thead>\n<tr>\n';
  nd.header.forEach((c, k) => {
    html += '<th' + (nd.aligns[k] ? ' align="' + nd.aligns[k] + '"' : '') + '>' + parseInline(c, links, false) + '</th>\n';
  });
  html += '</tr>\n</thead>\n';
  if (nd.rows.length === 0) return html + '</table>\n';
  html += '<tbody>';
  for (const row of nd.rows) {
    html += '<tr>\n';
    for (let k = 0; k < nd.header.length; k++) {
      const c = row[k] ?? '';
      html += '<td' + (nd.aligns[k] ? ' align="' + nd.aligns[k] + '"' : '') + '>' + parseInline(c, links, false) + '</td>\n';
    }
    html += '</tr>\n';
  }
  html += '</tbody></table>\n';
  return html;
}

function parseList(lines, i, links, lazyMap) {
  const first = LIST_RE.exec(lines[i]);
  if (!first) return null;
  const firstMarker = first[1];
  const ordered = /\d/.test(firstMarker[0]);
  const bulletKey = ordered ? firstMarker[firstMarker.length - 1] : firstMarker;
  const startNum = ordered ? parseInt(firstMarker, 10) : 1;
  const items = []; // { lines: string[], blankAfter: boolean }
  let j = i;
  let lastItemEnd = i;
  // inside a blockquote, once any item has absorbed a line that had no
  // quote marker (a lazy line), no later marker line may join the list:
  // the quote's chunks were lexed separately, so the list ends there
  let anyLazy = false;
  let listDone = false;
  while (j < lines.length) {
    if (listDone) break;
    if (HR_RE.test(lines[j])) break;
    const m = LIST_RE.exec(lines[j]);
    if (!m) break;
    if (anyLazy && lazyMap && lazyMap[j] === false) break;
    const marker = m[1];
    const isOrdered = /\d/.test(marker[0]);
    const key = isOrdered ? marker[marker.length - 1] : marker;
    if (isOrdered !== ordered || key !== bulletKey) break;
    // content indent: marker start col + marker width + following spaces (1..4)
    const line = lines[j];
    const indentInfo = leadingIndent(line);
    const afterMarker = indentInfo.idx + marker.length;
    let spaces = 0;
    while (line[afterMarker + spaces] === ' ' || line[afterMarker + spaces] === '\t') spaces++;
    // measure columns of the gap
    let gapCols = 0;
    {
      let col = indentInfo.cols + marker.length;
      let k = afterMarker;
      while (k < line.length && (line[k] === ' ' || line[k] === '\t')) {
        gapCols += line[k] === ' ' ? 1 : 4 - (col % 4);
        col += line[k] === ' ' ? 1 : 4 - (col % 4);
        k++;
      }
      var contentStart = k;
    }
    const gapRaw = /^[ \t]*/.exec(line.slice(indentInfo.idx + marker.length))[0];
    const gapExpanded = expandWs(gapRaw, indentInfo.cols + marker.length);
    const restAfterMarker = gapExpanded + line.slice(indentInfo.idx + marker.length + gapRaw.length);
    let contentIndent, stripN;
    if (gapCols >= 1 && gapCols <= 4 && restAfterMarker.trim() !== '') {
      contentIndent = indentInfo.cols + marker.length + gapCols;
      stripN = gapCols;
    } else {
      contentIndent = indentInfo.cols + marker.length + 1;
      stripN = 1;
    }
    const itemLines = [];
    const firstContent = stripCols(restAfterMarker, stripN);
    if (firstContent.trim() === '' && j + 1 < lines.length && isBlankLine(lines[j + 1])) {
      // empty item: consume the one blank line and finish
      items.push({ lines: [], blankAfter: true, trailBlank: false });
      j += 2;
      lastItemEnd = j;
      continue;
    }
    itemLines.push(firstContent);
    if (lazyMap && lazyMap[j] === true) anyLazy = true;
    // the previous line as the reference item lexer tracks it: the
    // tab-expanded source line cut at the content indent
    let prevSliced = firstContent;
    j++;
    let itemEnd = j;
    let sawBlank = false;
    let pendingBlanks = 0;
    let lastLine = firstContent;
    // whether the last line pushed belongs to an indented code block:
    // a content line still indented by 4+ after the item dedent, when
    // it follows a blank line or another such line
    let lastWasCode = false;
    while (j < lines.length) {
      const l = lines[j];
      if (anyLazy && lazyMap && lazyMap[j] === false) { listDone = true; break; }
      if (isBlankLine(l)) { pendingBlanks++; j++; sawBlank = true; continue; }
      // a marker-less line after a line ending in two spaces does not
      // join a quote-contained item (the chunk re-lex drops it)
      if (lazyMap && lazyMap[j] === true && !anyLazy && / {2}$/.test(lastLine)) { listDone = true; break; }
      // a line that begins another block at least one column before the
      // content indent ends this item (the begin patterns allow at most
      // contentIndent-1 leading spaces on the raw line)
      const br = BEGIN_RES[Math.min(3, Math.max(0, contentIndent - 1))];
      if (br.fence.test(l) || br.atx.test(l) || br.hr.test(l) || br.quote.test(l)
        || br.list.test(l)
        || htmlBeginAt(l, Math.min(3, Math.max(0, contentIndent - 1)))) {
        break;
      }
      if (lazyMap && (lazyMap[j] === 'setext' || lazyMap[j] === 'setextStart')) {
        // the quote stored this underline defused; the item sees the
        // bare underline, defused again here when the previous line
        // could close a setext heading with it
        const trimmed = l.trim();
        if (pendingBlanks > 0) break;
        itemLines.push(prevSliced.trim() !== '' ? '    ' + trimmed : trimmed);
        anyLazy = true;
        prevSliced = trimmed.slice(contentIndent);
        lastLine = l;
        lastWasCode = false;
        j++;
        itemEnd = j;
        continue;
      }
      const li = leadingIndent(l);
      if (li.cols >= contentIndent) {
        const hadBlanks = pendingBlanks > 0;
        while (pendingBlanks > 0) { itemLines.push(''); pendingBlanks--; }
        const stripped = stripCols(l, contentIndent);
        itemLines.push(stripped);
        if (lazyMap && lazyMap[j] === true) anyLazy = true;
        prevSliced = expandLeadingTabs(l).slice(contentIndent);
        lastWasCode = leadingIndent(stripped).cols >= 4 && (hadBlanks || lastWasCode);
        lastLine = stripped;
        j++;
        itemEnd = j;
        continue;
      }
      if (pendingBlanks > 0) break;
      // lazy continuation: only plain paragraph text may continue lazily,
      // and not after a line that was itself a block start or code
      if (lastWasCode || FENCE_RE.test(lastLine) || ATX_RE.test(lastLine)
        || HR_RE.test(lastLine) || (htmlBlockStart(lastLine) >= 1 && htmlBlockStart(lastLine) <= 6)) {
        break;
      }
      if (SETEXT_RE.test(l) && prevSliced.trim() !== '') {
        // a lazy underline that would complete a setext heading with
        // the previous line is defused with four spaces so it stays
        // paragraph text
        const wsM = /^[ \t]*/.exec(l);
        const expanded = expandWs(wsM[0], 0) + l.slice(wsM[0].length);
        itemLines.push('    ' + expanded.replace(/^ {0,3}/, ''));
        if (lazyMap && lazyMap[j] === true) anyLazy = true;
        prevSliced = expandLeadingTabs(l).slice(contentIndent);
        lastLine = l;
        lastWasCode = false;
        j++;
        itemEnd = j;
        continue;
      }
      itemLines.push(l);
      if (lazyMap && lazyMap[j] === true) anyLazy = true;
      prevSliced = expandLeadingTabs(l).slice(contentIndent);
      lastLine = l;
      lastWasCode = false;
      j++;
      itemEnd = j;
    }
    // trim trailing blank lines of the item
    while (itemLines.length && itemLines[itemLines.length - 1] === '') itemLines.pop();
    items.push({ lines: itemLines, blankAfter: pendingBlanks > 0, trailBlank: pendingBlanks === 1 });
    lastItemEnd = itemEnd;
    if (j >= lines.length) break;
    if (!LIST_RE.test(lines[j])) break;
  }
  if (items.length === 0) return null;
  const lastItemLines = items[items.length - 1].lines;
  if (lastItemLines.length) {
    const li = lastItemLines.length - 1;
    lastItemLines[li] = lastItemLines[li].replace(/[ \t]+$/, '');
  }
  const sepLoose = items.slice(0, -1).some((it) => it.blankAfter);
  const parsedItems = items.map((it, idx) => {
    const nodes = parseBlocks(it.lines.join('\n'), links, true);
    if (idx < items.length - 1 && it.trailBlank && nodes.length) {
      // a non-last item whose text ends on a merged indented line
      // (a defused underline, or code merged into the paragraph)
      // keeps that line's trailing newline in the paragraph text
      const lastNode = nodes[nodes.length - 1];
      const ll = it.lines[it.lines.length - 1];
      if (lastNode.kind === 'para' && ll !== undefined
        && (/^ {4}(=+|-+)[ \t]*$/.test(ll) || (leadingIndent(ll).cols >= 4 && lastNode.text.endsWith(dedentCode(ll))))) {
        nodes[nodes.length - 1] = { ...lastNode, text: lastNode.text + '\n' };
      }
    }
    let checkbox = '';
    const firstText = it.lines.length ? it.lines[0] : '';
    const taskM = /^\[([ xX])\][ \t]+\S/.exec(firstText);
    if (taskM && nodes.length && nodes[0].kind === 'para') {
      checkbox = taskM[1] === ' '
        ? '<input disabled="" type="checkbox"> '
        : '<input checked="" disabled="" type="checkbox"> ';
      nodes[0] = { ...nodes[0], text: nodes[0].text.replace(/^\[[ xX]\][ \t]+/, '') };
    }
    return { nodes, checkbox };
  });
  const loose = sepLoose || parsedItems.some((pi) => pi.nodes.hasSpacer);
  return { node: { kind: 'list', ordered, startNum, loose, items: parsedItems }, next: lastItemEnd };
}

// Render a list node whose items were parsed when the list was read.
function renderList(nd, links) {
  const tag = nd.ordered ? 'ol' : 'ul';
  let html = '<' + tag + (nd.ordered && nd.startNum !== 1 ? ' start="' + nd.startNum + '"' : '') + '>\n';
  for (const { nodes, checkbox } of nd.items) {
    if (nd.loose && checkbox && nodes.length && nodes[0].kind === 'para') {
      // in a loose list the checkbox lives inside the first paragraph
      const first = '<p>' + checkbox + parseInline(nodes[0].text, links, false) + '</p>\n';
      html += '<li>' + first + renderBlocks(nodes.slice(1), false, links) + '</li>\n';
    } else {
      html += '<li>' + checkbox + renderBlocks(nodes, !nd.loose, links) + '</li>\n';
    }
  }
  html += '</' + tag + '>\n';
  return html;
}

// Does the quote content gathered so far end with a block after which a
// lazy continuation cannot follow (code, heading, rule, HTML, table)?
// The gathered lines are scanned with a light block tracker: fence and
// HTML-block state carry over lines, and the kind of the most recent
// block decides.
function quoteChunkIsBlocky(inner) {
  let last = 'none';
  let fence = null;
  let inHtml = false;
  let inTable = false;
  let listOpen = false;
  let prevLine = '';
  for (const l of inner) {
    if (fence) {
      if (isFenceClose(l, fence)) fence = null;
      last = 'code';
      continue;
    }
    if (isBlankLine(l)) { inHtml = false; inTable = false; continue; }
    if (inHtml) { last = 'html'; prevLine = l; continue; }
    if (inTable) {
      if (startsBlock(l, true)) { inTable = false; }
      else { last = 'table'; prevLine = l; continue; }
    }
    if (listOpen) {
      // lines belonging to a list (items, content, lazy lines, and
      // blocks nested in items) keep the list as the current block;
      // only a block start that would end the list at this level
      // replaces it
      const fm2 = FENCE_RE.exec(l);
      if (fm2 || ATX_RE.test(l) || HR_RE.test(l) || QUOTE_RE.test(l) || htmlBlockStart(l) >= 1) {
        listOpen = false;
        if (fm2) { fence = fm2[1] || fm2[3]; last = 'code'; prevLine = l; continue; }
        if (ATX_RE.test(l)) { last = 'heading'; prevLine = l; continue; }
        if (HR_RE.test(l)) { last = 'hr'; prevLine = l; continue; }
        if (QUOTE_RE.test(l)) { last = 'quote'; prevLine = l; continue; }
        inHtml = true; last = 'html'; prevLine = l; continue;
      }
      last = 'list';
      prevLine = l;
      continue;
    }
    const fm = FENCE_RE.exec(l);
    if (fm) { fence = fm[1] || fm[3]; last = 'code'; prevLine = l; continue; }
    if (ATX_RE.test(l)) { last = 'heading'; prevLine = l; continue; }
    if (HR_RE.test(l)) { last = 'hr'; prevLine = l; continue; }
    if (htmlBlockStart(l) >= 1) { inHtml = true; last = 'html'; prevLine = l; continue; }
    if (prevLine.includes('|') && /^[ \t]*\|?[ \t:|-]+$/.test(l) && l.includes('-')) { inTable = true; last = 'table'; prevLine = l; continue; }
    if (leadingIndent(l).cols >= 4 && last !== 'para' && last !== 'list' && last !== 'quote') { last = 'code'; prevLine = l; continue; }
    if (QUOTE_RE.test(l)) { last = 'quote'; prevLine = l; continue; }
    if (LIST_RE.test(l)) { last = 'list'; listOpen = true; prevLine = l; continue; }
    last = 'para';
    prevLine = l;
  }
  return last === 'code' || last === 'heading' || last === 'hr' || last === 'html' || last === 'table';
}

function parseBlocks(src, links, inItem = false, lazyMap = null, chunkStart = null) {
  const lines = toLines(src);
  const nodes = [];
  nodes.hasSpacer = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlankLine(line)) {
      // a blank run followed by another block is a spacer at this level
      let k = i;
      while (k < lines.length && isBlankLine(lines[k])) k++;
      if (nodes.length > 0 && k < lines.length) nodes.hasSpacer = true;
      i = k; continue;
    }
    // link reference definitions (a run of them)
    const def = readDef(lines, i);
    if (def) {
      const key = normLabel(def.label);
      if (!links.has(key)) links.set(key, { href: def.href, title: def.title });
      i = def.next;
      continue;
    }
    // fenced code
    const fm = FENCE_RE.exec(line);
    if (fm) {
      const marker = fm[1] || fm[3];
      const info = (fm[1] ? fm[2] : fm[4]).trim();
      // compensation removes whitespace characters (never expanded
      // tabs), at most the number the opening fence itself is
      // indented by, and only for backtick fences
      const fenceWs = fm[1] ? /^[ \t]*/.exec(line)[0].length : 0;
      const body = [];
      let j = i + 1;
      while (j < lines.length && !isFenceClose(lines[j], marker)) {
        const bl = lines[j];
        if (fenceWs === 0) body.push(bl);
        else {
          const lead = /^[ \t]*/.exec(bl)[0].length;
          body.push(bl.slice(Math.min(lead, fenceWs)));
        }
        j++;
      }
      if (j < lines.length) j++;
      let content = body.join('\n');
      content = content ? content.replace(/\n$/, '') + '\n' : '';
      const lang = info ? unescapePunct(info.split(/\s+/)[0]) : '';
      const cls = lang ? ' class="language-' + escHtml(lang, true) + '"' : '';
      nodes.push({ kind: 'html', html: '<pre><code' + cls + '>' + escHtml(content, false) + '</code></pre>\n' });
      i = j; continue;
    }
    // ATX heading
    const am = ATX_RE.exec(line);
    if (am) {
      let text = am[2] ?? '';
      text = text.replace(/[ \t]+$/, '');
      if (/^#+$/.test(text)) text = '';
      else text = text.replace(/[ \t]+#+$/, '');
      text = text.trim();
      nodes.push({ kind: 'heading', depth: am[1].length, text });
      i++; continue;
    }
    // thematic break
    if (HR_RE.test(line)) { nodes.push({ kind: 'html', html: '<hr>\n' }); i++; continue; }
    // block quote
    if (QUOTE_RE.test(line)) {
      const inner = [];
      const lazy = [];
      const chunkStart = [];
      let j = i;
      let chunkLen = 0;
      let chunkHasMarker = false;
      let prevWasSetext = false;
      while (j < lines.length) {
        const l = lines[j];
        const qm = /^ {0,3}>/.exec(l);
        if (qm) {
          const afterM = l.slice(qm[0].length);
          const wsM = /^[ \t]*/.exec(afterM);
          const expanded = expandWs(wsM[0], qm[0].length);
          inner.push((expanded.startsWith(' ') ? expanded.slice(1) : expanded) + afterM.slice(wsM[0].length));
          lazy.push(false);
          chunkStart.push(false);
          chunkLen++;
          chunkHasMarker = true;
          prevWasSetext = false;
          j++; continue;
        }
        if (isBlankLine(l)) break;
        // lazy continuation; an '=' underline is kept as paragraph text,
        // but lazy lines stop at block starts and after a chunk whose
        // last block is code, a heading, a rule, an HTML block or a table
        if (inner.length && inner[inner.length - 1] !== '') {
          // a lazy line starts a new chunk once the current chunk
          // holds a marker line
          const chunkFirst = chunkHasMarker;
          if (/^ {0,3}=+[ \t]*$/.test(l)) {
            inner.push('    ' + l.trim());
            // an underline inside a chunk is defused with four spaces
            // that survive; at a chunk start the same prefix is later
            // removed again by the paragraph's lazy-line handling
            lazy.push(chunkFirst ? 'setextStart' : 'setext');
            chunkStart.push(chunkFirst);
            chunkLen = chunkFirst ? 1 : chunkLen + 1;
            chunkHasMarker = false;
            prevWasSetext = true;
            j++; continue;
          }
          if (!startsBlock(l, prevWasSetext ? false : true) && !LIST_RE.test(l) && (!chunkFirst || !quoteChunkIsBlocky(inner))) {
            inner.push(l);
            lazy.push(true);
            chunkStart.push(chunkFirst);
            prevWasSetext = false;
            chunkLen = chunkFirst ? 1 : chunkLen + 1;
            if (chunkFirst) chunkHasMarker = false;
            j++; continue;
          }
        }
        break;
      }
      // quote contents lex as top level even inside a list item
      nodes.push({ kind: 'quote', children: parseBlocks(inner.join('\n'), links, false, lazy, chunkStart) });

      i = j; continue;
    }
    // table (needs a delimiter on the next line)
    const tbl = parseTable(lines, i, links);
    if (tbl) { nodes.push(tbl.node); i = tbl.next; continue; }
    // list
    if (LIST_RE.test(line)) {
      const lst = parseList(lines, i, links, lazyMap);
      if (lst) { nodes.push(lst.node); i = lst.next; continue; }
    }
    // HTML block
    const hb = htmlBlockStart(line);
    if (hb) {
      const body = [line];
      let j = i + 1;
      if (hb === 1) {
        const tagM = /<(script|pre|style|textarea)/i.exec(line);
        const closeTag = tagM ? '</' + tagM[1].toLowerCase() + '>' : null;
        let closed = closeTag ? line.toLowerCase().includes(closeTag) : true;
        while (j < lines.length && !closed) {
          body.push(lines[j]);
          if (closeTag && lines[j].toLowerCase().includes(closeTag)) closed = true;
          j++;
        }
      } else if (hb === 2) {
        while (j < lines.length && !body[body.length - 1].includes('-->')) { body.push(lines[j]); j++; }
      } else if (hb === 3) {
        while (j < lines.length && !body[body.length - 1].includes('?>')) { body.push(lines[j]); j++; }
      } else if (hb === 4) {
        while (j < lines.length && !body[body.length - 1].includes('>')) { body.push(lines[j]); j++; }
      } else if (hb === 5) {
        while (j < lines.length && !body[body.length - 1].includes(']]>')) { body.push(lines[j]); j++; }
      } else {
        while (j < lines.length && !isBlankLine(lines[j])) { body.push(lines[j]); j++; }
      }
      // The raw text the reference block rule captures also swallows
      // following blank lines (only empty ones for types 1-5, any
      // whitespace-only ones for types 6-7); trailing blank lines are
      // then trimmed, keeping the whole string when at most two line
      // elements follow the last content line.
      const following = [];
      if (hb <= 5) {
        while (j + following.length < lines.length && lines[j + following.length] === '') following.push('');
      } else {
        while (j + following.length < lines.length && isBlankLine(lines[j + following.length])) following.push(lines[j + following.length]);
      }
      const consumed = body.concat(following);
      const moreAfter = j + following.length < lines.length;
      let cap0 = consumed.join('\n');
      if (moreAfter || src.endsWith('\n')) cap0 += '\n';
      nodes.push({ kind: 'html', html: trimTrailingBlankLines(cap0) });
      i = j; continue;
    }
    // indented code block
    if (leadingIndent(line).cols >= 4) {
      const body = [];
      let j = i;
      while (j < lines.length) {
        const l = lines[j];
        if (isBlankLine(l)) { body.push(dedentCode(l)); j++; continue; }
        if (leadingIndent(l).cols >= 4) { body.push(dedentCode(l)); j++; continue; }
        break;
      }
      while (body.length && isBlankLine(body[body.length - 1])) body.pop();
      let content = body.join('\n');
      if (body.length) content += '\n';
      content = content ? content.replace(/\n$/, '') + '\n' : '';
      nodes.push({ kind: 'html', html: '<pre><code>' + escHtml(content, false) + '</code></pre>\n' });
      i = j; continue;
    }
    // setext heading or paragraph: gather lines. rawLines keeps every
    // line verbatim (a setext heading's text is the raw capture);
    // paraLines is the paragraph form, where inside a list item an
    // indented line merges dedented (an indented block cannot
    // interrupt a paragraph) and a plain line after such a merge is
    // separated by a blank line in the text.
    const paraLines = [line];
    const rawLines = [line];
    let j = i + 1;
    let setextDepth = 0;
    let lazyStrip = false;
    let lastWasCodeMerge = false;
    let defBoundary = false;
    let sawListLine = false;
    while (j < lines.length) {
      const l = lines[j];
      if (isBlankLine(l)) {
        if (l.length > 0 && j === lines.length - 1 && !src.endsWith('\n')) { paraLines.push(l); rawLines.push(l); j++; }
        break;
      }
      const isDefLine = !!(chunkStart && chunkStart[j] && lazyMap && lazyMap[j] && readDef(lines, j));
      if (lazyMap && lazyMap[j] === 'setext') {
        if (lastWasCodeMerge) { paraLines.push(dedentCode(l)); rawLines.push(l); lastWasCodeMerge = false; j++; continue; }
        paraLines.push(l); rawLines.push(l); j++; continue;
      }
      if (lazyMap && lazyMap[j]) {
        // a lazy quote line that opens a chunk and is indented like a
        // code block has up to four columns removed, as an indented
        // block cannot interrupt a paragraph; the removal continues
        // over the run of indented lazy lines and stops at the first
        // outdented one. A mid-chunk lazy line is paragraph text
        // exactly as written.
        if (leadingIndent(l).cols >= 4 && (lazyStrip || defBoundary || (chunkStart && chunkStart[j]))) { lazyStrip = true; paraLines.push(dedentCode(l)); rawLines.push(l); lastWasCodeMerge = true; j++; continue; }
        lazyStrip = false;
      } else if (inItem && leadingIndent(l).cols >= 4 && !startsBlock(l, true)) {
        paraLines.push(dedentCode(l));
        rawLines.push(l);
        lastWasCodeMerge = true;
        j++; continue;
      }
      const sm = SETEXT_RE.exec(l);
      if (sm && paraLines.length >= 1 && !sawListLine && !lastWasCodeMerge) { setextDepth = sm[1][0] === '=' ? 1 : 2; j++; break; }
      if (sm && lastWasCodeMerge) {
        // an underline right after a merged code line stays plain
        // paragraph text, joined without the merge separator
        paraLines.push(l);
        rawLines.push(l);
        lastWasCodeMerge = false;
        j++; continue;
      }
      if (startsBlock(l, true)) break;
      // inside a list item the content is lexed line by line, so a
      // list marker with any number interrupts the paragraph (at the
      // top level only a list starting at 1 can do that)
      if (inItem && LIST_RE.test(l)) break;
      // a table can interrupt: the next line begins a table when it
      // is a header line and the line after it is a delimiter row
      // (pipes are not required for the interruption itself)
      if (j + 1 < lines.length && /^ *\S/.test(l) && TABLE_ALIGN_RE.test(lines[j + 1])
        && !(SETEXT_RE.test(lines[j + 1]) && !sawListLine && !LIST_RE.test(l))) break;
      if (lastWasCodeMerge) { paraLines.push(''); lastWasCodeMerge = false; }
      defBoundary = isDefLine;
      if (LIST_RE.test(l)) sawListLine = true;
      paraLines.push(l);
      rawLines.push(l);
      j++;
    }
    if (lastWasCodeMerge && lazyMap && j < lines.length) paraLines.push('');
    if (setextDepth) nodes.push({ kind: 'heading', depth: setextDepth, text: rawLines.join('\n').trim() });
    else nodes.push({ kind: 'para', text: paraLines.join('\n') });
    i = j;
  }
  return nodes;
}

function renderBlocks(nodes, tight, links) {
  let out = '';
  for (let idx = 0; idx < nodes.length; idx++) {
    const nd = nodes[idx];
    const isLast = idx === nodes.length - 1;
    if (nd.kind === 'quote') out += '<blockquote>\n' + renderBlocks(nd.children, false, links) + '</blockquote>\n';
    else if (nd.kind === 'list') out += renderList(nd, links);
    else if (nd.kind === 'table') out += renderTable(nd, links);

    else if (nd.kind === 'html') out += nd.html;
    else if (nd.kind === 'heading') out += '<h' + nd.depth + '>' + parseInline(nd.text, links, false) + '</h' + nd.depth + '>\n';
    else if (nd.kind === 'para') {
      if (tight) out += parseInline(nd.text, links, false);
      else out += '<p>' + parseInline(nd.text, links, false) + '</p>\n';
    }
  }
  return out;
}

// Public entry: render one Markdown document to the exact HTML the
// reference renderer produces for it.
let docInLink = false;

export function parse(markdown) {
  docInLink = false;
  const src = String(markdown).replace(/\r\n|\r/g, '\n');
  const links = new Map();
  const nodes = parseBlocks(src, links);
  // Definitions may appear after their uses; paragraphs were stored raw, so
  // rendering now (with the complete definition table) resolves them all.
  return renderBlocks(nodes, false, links);
}
