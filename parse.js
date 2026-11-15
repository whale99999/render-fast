// render-fast: an original, dependency-free Markdown -> HTML renderer whose
// output matches marked 18.1.3 with default options (GFM on, breaks off).
// Structure: a line-oriented block parser builds block nodes and collects
// link reference definitions; a scanner-based inline parser then renders
// the text of paragraphs, headings, list items and table cells.

// ---------- small string helpers ----------

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
        const m = /^&(?:#\d{1,7}|#[Xx][A-Fa-f0-9]{1,6}|\w+);/.exec(s.slice(i, i + 12));
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
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
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

const HTML_TAG_RE = /^<(?:[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^ \t"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|\/[A-Za-z][A-Za-z0-9-]*\s*>|!--(?:-?>|[\s\S]*?(?:-->|$))|\?[\s\S]*?\?>|![A-Za-z][\s\S]*?>|!\[CDATA\[[\s\S]*?\]\]>)/;

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
function findCloseBracket(text, openIdx) {
  let depth = 0;
  let i = openIdx;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '`') {
      // skip a code span so brackets inside code do not count
      let run = 1;
      while (text[i + run] === '`') run++;
      const closeSeq = '`'.repeat(run);
      const end = text.indexOf(closeSeq, i + run);
      if (end !== -1) { i = end + run; continue; }
      i += run; continue;
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

// Render a plain-text run: decode numeric references, then escape.
function renderTextRun(s) {
  if (s.indexOf('&') !== -1) s = decodeNumericRefs(s);
  return escHtml(s, true);
}

// GFM extended autolink: try to match a bare URL / www / email at position i.
function matchExtendedAutolink(text, i) {
  const rest = text.slice(i, i + 300);
  let m = /^(?:https?:\/\/|ftp:\/\/|www\.)[^\s<]+/.exec(rest);
  if (m) {
    let link = m[0];
    let changed = true;
    while (changed && link.length > 0) {
      changed = false;
      const last = link[link.length - 1];
      if ('?!.,:*_~'.includes(last)) { link = link.slice(0, -1); changed = true; continue; }
      if (last === ';') {
        const ent = /&(?:#\d+|#x[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);$/.exec(link);
        link = ent ? link.slice(0, link.length - ent[0].length) : link.slice(0, -1);
        changed = true; continue;
      }
      if (last === ')') {
        let open = 0, close = 0;
        for (const ch of link) { if (ch === '(') open++; else if (ch === ')') close++; }
        if (close > open) { link = link.slice(0, -1); changed = true; continue; }
      }
      if (last === ']') {
        let open = 0, close = 0;
        for (const ch of link) { if (ch === '[') open++; else if (ch === ']') close++; }
        if (close > open) { link = link.slice(0, -1); changed = true; continue; }
      }
    }
    if (link.length === 0) return null;
    const isWww = link.startsWith('www.');
    const href = isWww ? 'http://' + link : link;
    return { href, text: link, end: i + link.length };
  }
  m = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(rest);
  if (m) {
    let link = m[0];
    while (link.endsWith('.')) link = link.slice(0, -1);
    if (!link) return null;
    return { href: 'mailto:' + link, text: link, end: i + link.length };
  }
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
    '|(?!_)' + P + '(_+)(?!_)(?=' + P + ')' +
    '|(?:(?!_)' + P + '|' + NPS + ')(_+)(?!_)(?=' + NPS + ')',
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
function maskSource(text, links) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < n && PUNCT_RE.test(text[i + 1])) { out += '++'; i += 2; continue; }
    if (ch === '`') {
      let run = 1;
      while (text[i + run] === '`') run++;
      const close = findCodeClose(text, i + run, run);
      if (close !== -1) {
        const len = close + run - i;
        out += '[' + 'a'.repeat(Math.max(0, len - 2)) + ']';
        i += len; continue;
      }
      out += ch; i++; continue;
    }
    if (ch === '<') {
      const m = /^<[^<>]*?>/.exec(text.slice(i));
      if (m) { out += '[' + 'a'.repeat(Math.max(0, m[0].length - 2)) + ']'; i += m[0].length; continue; }
      out += ch; i++; continue;
    }
    if (ch === '[' || (ch === '!' && text[i + 1] === '[')) {
      const open = ch === '!' ? i + 1 : i;
      const close = findCloseBracket(text, open);
      if (close !== -1) {
        let end = -1;
        if (text[close + 1] === '(') {
          const d = parseLinkDest(text, close + 1);
          if (d) end = d.end;
        } else if (text[close + 1] === '[') {
          const c2 = findCloseBracket(text, close + 1);
          if (c2 !== -1) {
            const ref = text.slice(close + 2, c2);
            const label = text.slice(open + 1, close);
            if (links.has(normLabel(ref === '' ? label : ref))) end = c2 + 1;
          }
        } else {
          const label = text.slice(open + 1, close);
          if (links.has(normLabel(label))) end = close + 1;
        }
        if (end !== -1) {
          const len = end - i;
          out += '[' + 'a'.repeat(Math.max(0, len - 2)) + ']';
          i = end; continue;
        }
      }
      out += ch; i++; continue;
    }
    out += ch; i++;
  }
  return out;
}

// Find the end of a code span: a run of exactly `run` backticks.
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
  if (ch === '_' && nextIsNonSpace && prevChar !== '' && ALNUM_RE.test(prevChar)) return null;
  const nextChar = nextIsPunct ? after : '';
  const prevPunct = prevChar !== '' && prevChar !== '*' && prevChar !== '_' && /[\s\p{P}\p{S}]/u.test(prevChar);
  if (nextChar && prevChar && !prevPunct) return null;
  // whole-run context for rules 9-10
  let runStart = i;
  while (runStart > 0 && masked[runStart - 1] === ch) runStart--;
  const runPrevChar = runStart > 0 ? masked[runStart - 1] : '';
  const runPrevPunct = runPrevChar !== '' && /[\s\p{P}\p{S}]/u.test(runPrevChar);
  const runLength = (i - runStart) + run;
  const midRun = prevChar === ch;
  const openerCanClose = runPrevChar !== '' && !!runPrevChar.trim() && (!!nextChar || (ch === '*' && !runPrevPunct));
  const lLength = run;
  const endReg = rDelimRegex(ch);
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
  const endReg = new RegExp(DEL_RDELIM.source, 'gu');
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

const DISALLOWED_TAGS = new Set(['title', 'textarea', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'script', 'plaintext']);

// Main inline renderer: a single left-to-right scan.
function parseInline(text, links, inLink) {
  const masked = (text.includes('*') || text.includes('_') || text.includes('~')) ? maskSource(text, links) : text;
  const parts = [];
  const openers = [];
  let buf = '';
  const flush = () => { if (buf) { parts.push({ html: renderTextRun(buf) }); buf = ''; } };
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '\\') {
      const nx = text[i + 1];
      if (nx === '\n') { flush(); parts.push({ html: '<br>' }); i += 2; continue; }
      if (nx !== undefined && ESCAPABLE.includes(nx)) { buf += nx; i += 2; continue; }
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
      parts.push({ html: '<code>' + escHtml(content, true) + '</code>' });
      i = close + run; continue;
    }
    if (ch === '!' && text[i + 1] === '[') {
      flush();
      openers.push({ partIdx: parts.length, srcIdx: i, isImage: true, active: true });
      parts.push({ html: '![' });
      i += 2; continue;
    }
    if (ch === '[') {
      flush();
      openers.push({ partIdx: parts.length, srcIdx: i, isImage: false, active: true });
      parts.push({ html: '[' });
      i++; continue;
    }
    if (ch === ']') {
      flush();
      const formed = tryCloseBracket(text, i, parts, openers, links, inLink);
      if (formed !== -1) { i = formed; continue; }
      parts.push({ html: ']' });
      i++; continue;
    }
    if (ch === '<') {
      const rest = text.slice(i);
      const auto = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/.exec(rest) || /^<([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})>/.exec(rest);
      if (auto) {
        flush();
        const isEmail = auto[1].includes('@') && !auto[1].includes(':');
        const href = isEmail ? 'mailto:' + auto[1] : auto[1];
        parts.push({ html: '<a href="' + escHtml(cleanHref(href), true) + '">' + renderTextRun(auto[1]) + '</a>' });
        i += auto[0].length; continue;
      }
      const tag = HTML_TAG_RE.exec(rest);
      if (tag) {
        flush();
        const raw = tag[0];
        const nameM = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(raw);
        if (nameM && DISALLOWED_TAGS.has(nameM[1].toLowerCase())) parts.push({ html: escHtml(raw, false) });
        else parts.push({ html: raw });
        i += raw.length; continue;
      }
      buf += ch; i++; continue;
    }
    if (ch === '*' || ch === '_') {
      const prevChar = i > 0 ? text[i - 1] : '';
      const m = matchEmStrong(text, masked, i, prevChar);
      if (m) {
        flush();
        parts.push({ html: '<' + m.tag + '>' + parseInline(m.inner, links, inLink) + '</' + m.tag + '>' });
        i += m.rawLen; continue;
      }
      buf += ch; i++; continue;
    }
    if (ch === '~') {
      const prevChar = i > 0 ? text[i - 1] : '';
      const m = matchDel(text, masked, i, prevChar);
      if (m) {
        flush();
        parts.push({ html: '<del>' + parseInline(m.inner, links, inLink) + '</del>' });
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
        parts.push({ html: '<br>' });
        i++; continue;
      }
      if (sp === 1) buf = buf.slice(0, buf.length - 1);
      buf += ch; i++; continue;
    }
    if ((ch === 'w' || ch === 'h' || ch === 'f') && (i === 0 || !isAlnumCh(text[i - 1])) && !inLink) {
      const auto = matchExtendedAutolink(text, i);
      if (auto && (auto.text.startsWith('www.') || auto.text.includes('://'))) {
        flush();
        parts.push({ html: '<a href="' + escHtml(cleanHref(auto.href), true) + '">' + renderTextRun(auto.text) + '</a>' });
        i = auto.end; continue;
      }
    }
    if (isAlnumCh(ch) && !inLink) {
      const prev = i > 0 ? text[i - 1] : '';
      if (!isAlnumCh(prev) && prev !== '.' && prev !== '_' && prev !== '%' && prev !== '+' && prev !== '-') {
        const auto = matchExtendedAutolink(text, i);
        if (auto && auto.href.startsWith('mailto:')) {
          flush();
          parts.push({ html: '<a href="' + escHtml(cleanHref(auto.href), true) + '">' + renderTextRun(auto.text) + '</a>' });
          i = auto.end; continue;
        }
      }
    }
    buf += ch; i++;
  }
  flush();
  let out = '';
  for (const p of parts) out += p.html;
  return out;
}

// Handle a ']' at closeIdx: try to form a link/image from the nearest
// active bracket opener. The parts between opener and here are re-rendered
// from their source so emphasis inside the label resolves in its own run.
function tryCloseBracket(text, closeIdx, parts, openers, links, inLink) {
  let op = null;
  for (let k = openers.length - 1; k >= 0; k--) {
    if (openers[k].active) { op = openers[k]; break; }
  }
  if (!op) return -1;
  if (inLink && !op.isImage) { op.active = false; return -1; }
  const labelText = text.slice(op.srcIdx + (op.isImage ? 2 : 1), closeIdx);
  let href = null, title = null, end = -1;
  const after = closeIdx + 1;
  if (text[after] === '(') {
    const d = parseLinkDest(text, after);
    if (!d) { op.active = false; return -1; }
    href = d.href; title = d.title; end = d.end;
  } else if (text[after] === '[') {
    const close2 = findCloseBracket(text, after);
    if (close2 === -1) { op.active = false; return -1; }
    const refLabel = text.slice(after + 1, close2);
    const def = links.get(normLabel(refLabel === '' ? labelText : refLabel));
    if (!def) { op.active = false; return -1; }
    href = def.href; title = def.title; end = close2 + 1;
  } else {
    const def = links.get(normLabel(labelText));
    if (!def) { op.active = false; return -1; }
    href = def.href; title = def.title; end = after;
  }
  const hrefAttr = escHtml(cleanHref(unescapePunct(href)), true);
  let html;
  if (op.isImage) {
    const innerHtml = parseInline(labelText, links, false);
    const alt = innerHtml.replace(/<[^>]*>/g, '');
    html = '<img src="' + hrefAttr + '" alt="' + alt + '"';
    if (title !== null) html += ' title="' + escHtml(cleanTitle(title), false) + '"';
    html += '>';
  } else {
    if (!op.isImage && containsLink(labelText, links)) {
      op.active = false;
      return -1;
    }
    html = '<a href="' + hrefAttr + '"';
    if (title !== null) html += ' title="' + escHtml(cleanTitle(title), false) + '"';
    html += '>' + parseInline(labelText, links, true) + '</a>';
  }
  parts.length = op.partIdx;
  parts.push({ html });
  while (openers.length && openers[openers.length - 1] !== op) openers.pop();
  openers.pop();
  if (!op.isImage) {
    for (const o of openers) if (!o.isImage) o.active = false;
  }
  return end;
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
function stripCols(line, cols) {
  let col = 0, i = 0;
  while (i < line.length && col < cols) {
    if (line[i] === ' ') { col++; i++; }
    else if (line[i] === '\t') {
      const w = 4 - (col % 4);
      if (col + w > cols) {
        // partial tab: the remainder becomes spaces
        return ' '.repeat(col + w - cols) + line.slice(i + 1);
      }
      col += w; i++;
    } else break;
  }
  return line.slice(i);
}
function isBlankLine(line) {
  return /^[ \t]*$/.test(line);
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
  const head = /^ {0,3}\[/.exec(first);
  if (!head) return null;
  let rest = first.slice(head[0].length);
  // label may span lines; gather until ]
  let label = '';
  let li = i;
  let found = false;
  let cur = rest;
  while (li < lines.length && li <= i + 2) {
    const close = findLabelEnd(cur);
    if (close !== -1) {
      label += cur.slice(0, close);
      rest = cur.slice(close + 1);
      found = true;
      break;
    }
    label += cur + '\n';
    li++;
    cur = lines[li] ?? '';
  }
  if (!found || rest[0] !== ':') return null;
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
  // optional title, on this line or the next
  let title = null;
  let t = s.replace(/^[ \t]+/, '');
  let titleLine = lineIdx;
  if (t === '' && lineIdx + 1 < lines.length) {
    const nxt = lines[lineIdx + 1].replace(/^[ \t]+/, '');
    if (nxt[0] === '"' || nxt[0] === "'" || nxt[0] === '(') { t = nxt; titleLine = lineIdx + 1; }
  }
  if (t !== '') {
    const q = t[0];
    if (q === '"' || q === "'" || q === '(') {
      const close = q === '(' ? ')' : q;
      let k = 1, buf = '', ok = false;
      while (k < t.length) {
        if (t[k] === '\\' && k + 1 < t.length) { buf += t[k] + t[k + 1]; k += 2; continue; }
        if (t[k] === close) { ok = true; break; }
        buf += t[k]; k++;
      }
      if (!ok) return null;
      title = unescapePunct(buf);
      const tail = t.slice(k + 1);
      if (!/^[ \t]*$/.test(tail)) return null;
      return { label, href, title, next: titleLine + 1 };
    }
    return null;
  }
  return { label, href, title, next: lineIdx + 1 };
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

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})([^`~]*)$/;
const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/;
const HR_RE = /^ {0,3}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})[ \t]*$/;
const QUOTE_RE = /^ {0,3}>[ \t]?/;
const LIST_RE = /^ {0,3}([*+-]|\d{1,9}[.)])([ \t]+|$)/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;

function fenceCloseRe(marker) {
  const ch = marker[0];
  return new RegExp('^ {0,3}' + (ch === '`' ? '`' : '~') + '{' + marker.length + ',}[ \t]*$');
}

// Does this line begin a block that interrupts a paragraph?
function startsBlock(line, inPara) {
  if (FENCE_RE.test(line)) return true;
  if (ATX_RE.test(line)) return true;
  if (HR_RE.test(line)) return true;
  if (QUOTE_RE.test(line)) return true;
  if (htmlBlockStart(line)) return true;
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

const HTML_BLOCK_TAGS_RE = new RegExp('^ {0,3}</?(?:' + BLOCK_TAGS + ')(?:[ \\t]|$|/?>)', 'i');
function htmlBlockStart(line) {
  if (/^ {0,3}<(?:script|pre|style|textarea)(?:[\s>]|$)/i.test(line)) return 1;
  if (/^ {0,3}<!--/.test(line)) return 2;
  if (/^ {0,3}<\?/.test(line)) return 3;
  if (/^ {0,3}<![A-Za-z]/.test(line)) return 4;
  if (/^ {0,3}<!\[CDATA\[/.test(line)) return 5;
  if (HTML_BLOCK_TAGS_RE.test(line)) return 6;
  if (/^ {0,3}<\/?[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:[^ \t"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t]*\/?>[ \t]*$/.test(line)) return 7;
  if (/^ {0,3}<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>[ \t]*$/.test(line)) return 7;
  return 0;
}

// Split a table row into cells, honouring \| escapes and code spans.
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') { cur += '|'; i += 2; continue; }
    if (ch === '`') {
      let run = 1;
      while (s[i + run] === '`') run++;
      const seq = '`'.repeat(run);
      const end = s.indexOf(seq, i + run);
      if (end !== -1) { cur += s.slice(i, end + run); i = end + run; continue; }
      cur += seq; i += run; continue;
    }
    if (ch === '|') { cells.push(cur); cur = ''; i++; continue; }
    cur += ch; i++;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
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
  while (j < lines.length && !isBlankLine(lines[j]) && lines[j].includes('|')) {
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
  html += '</tr>\n</thead>\n<tbody>';
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

function parseList(lines, i, links) {
  const first = LIST_RE.exec(lines[i]);
  if (!first) return null;
  const firstMarker = first[1];
  const ordered = /\d/.test(firstMarker[0]);
  const bulletKey = ordered ? firstMarker[firstMarker.length - 1] : firstMarker;
  const startNum = ordered ? parseInt(firstMarker, 10) : 1;
  const items = []; // { lines: string[] }
  let loose = false;
  let j = i;
  let prevBlankSep = false;
  while (j < lines.length) {
    const m = LIST_RE.exec(lines[j]);
    if (!m) break;
    const marker = m[1];
    const isOrdered = /\d/.test(marker[0]);
    const key = isOrdered ? marker[marker.length - 1] : marker;
    if (isOrdered !== ordered || key !== bulletKey) break;
    if (items.length > 0 && prevBlankSep) loose = true;
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
    const restAfterMarker = line.slice(indentInfo.idx + marker.length);
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
    itemLines.push(firstContent);
    j++;
    let sawBlank = false;
    let pendingBlanks = 0;
    while (j < lines.length) {
      const l = lines[j];
      if (isBlankLine(l)) { pendingBlanks++; j++; sawBlank = true; continue; }
      const li = leadingIndent(l);
      if (li.cols >= contentIndent) {
        while (pendingBlanks > 0) { itemLines.push(''); pendingBlanks--; }
        itemLines.push(stripCols(l, contentIndent));
        j++;
        continue;
      }
      if (LIST_RE.test(l)) break;
      // lazy continuation line
      if (pendingBlanks === 0) { itemLines.push(l); j++; continue; }
      break;
    }
    // a blank line that separates two blocks inside the item makes the
    // whole list loose, as does a blank line between items
    if (itemLines.some((x, idx) => idx > 0 && x === '')) loose = true;
    if (sawBlank) prevBlankSep = true; else prevBlankSep = false;
    // trim trailing blank lines of the item
    while (itemLines.length && itemLines[itemLines.length - 1] === '') itemLines.pop();
    items.push({ lines: itemLines });
    if (j >= lines.length) break;
    if (!LIST_RE.test(lines[j])) break;
  }
  if (items.length === 0) return null;
  return { node: { kind: 'list', ordered, startNum, loose, items: items.map((it) => it.lines) }, next: j };
}

// Render a list node once the full definition table is known.
function renderList(nd, links) {
  const tag = nd.ordered ? 'ol' : 'ul';
  let html = '<' + tag + (nd.ordered && nd.startNum !== 1 ? ' start="' + nd.startNum + '"' : '') + '>\n';
  for (const itemLines of nd.items) {
    const nodes = parseBlocks(itemLines.join('\n'), links);
    let checkbox = '';
    const firstText = itemLines.length ? itemLines[0] : '';
    const taskM = /^\[([ xX])\][ \t]+/.exec(firstText);
    if (taskM && nodes.length && nodes[0].kind === 'para') {
      checkbox = taskM[1] === ' '
        ? '<input disabled="" type="checkbox"> '
        : '<input checked="" disabled="" type="checkbox"> ';
      nodes[0] = { ...nodes[0], text: nodes[0].text.replace(/^\[[ xX]\][ \t]+/, '') };
    }
    const body = renderBlocks(nodes, !nd.loose, links);
    html += '<li>' + checkbox + body + '</li>\n';
  }
  html += '</' + tag + '>\n';
  return html;
}

function parseBlocks(src, links) {
  const lines = toLines(src);
  const nodes = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }
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
    if (fm && !(fm[1][0] === '`' && fm[2].includes('`'))) {
      const marker = fm[1];
      const info = fm[2].trim();
      const closeRe = fenceCloseRe(marker);
      const body = [];
      let j = i + 1;
      while (j < lines.length && !closeRe.test(lines[j])) { body.push(lines[j]); j++; }
      if (j < lines.length) j++;
      let content = body.join('\n');
      if (body.length) content += '\n';
      const lang = info ? info.split(/\s+/)[0] : '';
      const cls = lang ? ' class="language-' + escHtml(lang, false) + '"' : '';
      nodes.push({ kind: 'html', html: '<pre><code' + cls + '>' + escHtml(content, true) + '</code></pre>\n' });
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
      let j = i;
      while (j < lines.length) {
        const l = lines[j];
        if (QUOTE_RE.test(l)) { inner.push(l.replace(QUOTE_RE, '')); j++; continue; }
        if (isBlankLine(l)) break;
        // lazy continuation
        if (inner.length && inner[inner.length - 1] !== '' && !startsBlock(l, true)) { inner.push(l); j++; continue; }
        break;
      }
      nodes.push({ kind: 'quote', src: inner.join('\n') });
      i = j; continue;
    }
    // table (needs a delimiter on the next line)
    const tbl = parseTable(lines, i, links);
    if (tbl) { nodes.push(tbl.node); i = tbl.next; continue; }
    // list
    if (LIST_RE.test(line)) {
      const lst = parseList(lines, i, links);
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
      let raw = body.join('\n');
      nodes.push({ kind: 'htmlblock', raw });
      i = j; continue;
    }
    // indented code block
    if (leadingIndent(line).cols >= 4) {
      const body = [];
      let j = i;
      while (j < lines.length) {
        const l = lines[j];
        if (isBlankLine(l)) { body.push(''); j++; continue; }
        if (leadingIndent(l).cols >= 4) { body.push(stripCols(l, 4)); j++; continue; }
        break;
      }
      while (body.length && body[body.length - 1] === '') body.pop();
      let content = body.join('\n');
      if (body.length) content += '\n';
      nodes.push({ kind: 'html', html: '<pre><code>' + escHtml(content, true) + '</code></pre>\n' });
      i = j; continue;
    }
    // setext heading or paragraph: gather lines
    const paraLines = [line];
    let j = i + 1;
    let setextDepth = 0;
    while (j < lines.length) {
      const l = lines[j];
      if (isBlankLine(l)) break;
      const sm = SETEXT_RE.exec(l);
      if (sm && paraLines.length >= 1) { setextDepth = sm[1][0] === '=' ? 1 : 2; j++; break; }
      if (startsBlock(l, true)) break;
      // a table can interrupt: header + delimiter
      if (l.includes('|') && j + 1 < lines.length && /^[ \t]*\|?[ \t:|-]+$/.test(lines[j + 1]) && lines[j + 1].includes('-')) break;
      paraLines.push(l);
      j++;
    }
    const text = paraLines.join('\n');
    if (setextDepth) nodes.push({ kind: 'heading', depth: setextDepth, text: text.trim() });
    else nodes.push({ kind: 'para', text });
    i = j;
  }
  return nodes;
}

function renderBlocks(nodes, tight, links) {
  let out = '';
  nodes.forEach((nd, idx) => {
    const isLast = idx === nodes.length - 1;
    if (nd.kind === 'quote') out += '<blockquote>\n' + renderBlocks(parseBlocks(nd.src, links), false, links) + '</blockquote>\n';
    else if (nd.kind === 'list') out += renderList(nd, links);
    else if (nd.kind === 'table') out += renderTable(nd, links);
    else if (nd.kind === 'htmlblock') out += nd.raw + (isLast ? '\n' : '');
    else if (nd.kind === 'html') out += nd.html;
    else if (nd.kind === 'heading') out += '<h' + nd.depth + '>' + parseInline(nd.text, links, false) + '</h' + nd.depth + '>\n';
    else if (nd.kind === 'para') {
      if (tight) out += parseInline(nd.text, links, false);
      else out += '<p>' + parseInline(nd.text, links, false) + '</p>\n';
    }
  });
  return out;
}

// Public entry: render one Markdown document to the exact HTML the
// reference renderer produces for it.
export function parse(markdown) {
  const src = String(markdown).replace(/\r\n|\r/g, '\n');
  const links = new Map();
  const nodes = parseBlocks(src, links);
  // Definitions may appear after their uses; paragraphs were stored raw, so
  // rendering now (with the complete definition table) resolves them all.
  return renderBlocks(nodes, false, links);
}
