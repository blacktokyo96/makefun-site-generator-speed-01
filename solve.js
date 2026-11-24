// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
//
// Original implementation, written from the reference's README + source as
// the specification. It returns byte-identical output to makefun-site's
// build() on every input, faster:
//  - Markdown is rendered in one pass over the body (no lex tokens, no
//    per-character escapeHtml calls, inline markup scanned by charCode).
//  - slugify has an ASCII fast path plus a per-case cache (titles, tag
//    names and heading texts repeat heavily); the Unicode path is the
//    reference algorithm verbatim.
//  - Templates are parsed once per case into a node tree and rendered
//    into a string array (one join per page) with a scope chain of
//    null-prototype frames.
//  - Front matter is scanned line by line without splitting the file,
//    and the Markdown body is scanned from the same text (no copies).
//  - Word counting is a charCode scan (no /\S+/g match array).
// No state is kept between run() calls: every cache is created fresh
// inside run(), so each case is answered alone.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];
const REPORT_FILE = 'build-report.txt';

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- text

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
function esc(text) {
  return ESC_TEST.test(text) ? text.replace(ESC_RE, (c) => ESC[c]) : text;
}

/** The slug of `text`, cached per case in ctx. ASCII text takes a fast path
 *  (NFKD is the identity on ASCII and it holds no combining marks); anything
 *  else runs the reference algorithm exactly. */
function slugify(text, ctx) {
  const hit = ctx.slugCache.get(text);
  if (hit !== undefined) return hit;
  const out = slugifyRaw(text);
  ctx.slugCache.set(text, out);
  return out;
}

function slugifyRaw(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (ascii) {
    let out = '';
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      let keep = -1;
      if (ch >= 65 && ch <= 90) keep = ch + 32;
      else if ((ch >= 97 && ch <= 122) || (ch >= 48 && ch <= 57)) keep = ch;
      if (keep === -1) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
    out = out.slice(0, 64);
    let e = out.length;
    while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
    out = out.slice(0, e);
    return out === '' ? 'untitled' : out;
  }
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone, cached per case. */
function longDate(date, ctx) {
  let v = ctx.dateCache.get(date);
  if (v === undefined) {
    v = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
    ctx.dateCache.set(date, v);
  }
  return v;
}

/** Whether the UTF-16 unit is JS whitespace (\s). */
function isWS(code) {
  return code === 32 || code === 9 || code === 10 || code === 11 || code === 12 || code === 13 ||
    code === 160 || code === 5760 || (code >= 8192 && code <= 8202) || code === 8232 || code === 8233 ||
    code === 8239 || code === 8287 || code === 12288 || code === 65279;
}

/** The words of s[lo..hi): runs of characters other than whitespace. */
function wordsOfRange(s, lo, hi) {
  let n = 0;
  let inWord = false;
  for (let i = lo; i < hi; i++) {
    const c = s.charCodeAt(i);
    // Whitespace is almost always space/tab/newline; the rest is rare.
    if (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 ||
      c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 ||
      c === 8239 || c === 8287 || c === 12288 || c === 65279) {
      if (inWord) { n++; inWord = false; }
    } else inWord = true;
  }
  if (inWord) n++;
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function isAlnumLower(c) {
  return (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = false;
      let y = 0;
      let mo = 0;
      let d = 0;
      if (raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45) {
        ok = true;
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
        if (ok) {
          y = Number(raw.slice(0, 4));
          mo = Number(raw.slice(5, 7));
          d = Number(raw.slice(8, 10));
        }
      }
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.length < 2 || raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let k = 0; k < tags.length; k++) {
        const t = tags[k].trim();
        tags[k] = t;
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let i = 0; i < t.length; i++) {
          const c = t.charCodeAt(i);
          if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!isAlnumLower(c) && c !== 45) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      let ok = raw.length > 0 && raw.length <= 64;
      if (ok) {
        let i = 0;
        const n = raw.length;
        while (i < n && isAlnumLower(raw.charCodeAt(i))) i++;
        if (i === 0) ok = false;
        while (ok && i < n) {
          if (raw.charCodeAt(i) !== 45) { ok = false; break; }
          i++;
          const s = i;
          while (i < n && isAlnumLower(raw.charCodeAt(i))) i++;
          if (i === s) ok = false;
        }
        if (ok && i !== n) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body start: { data, bodyStart }, or { error }.
 * `text` has "\n" line ends. Lines are scanned by index, never split.
 */
function parseFrontMatter(text) {
  // Line 1 must be exactly '---'.
  const nl0 = text.indexOf('\n');
  const firstEnd = nl0 === -1 ? text.length : nl0;
  if (text.slice(0, firstEnd) !== '---') return { error: 'no front matter' };
  // Find the closing '---' line; remember every line's bounds on the way.
  const bounds = [];
  let pos = firstEnd + 1;
  let close = -1;
  let closeEnd = -1;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const le = nl === -1 ? text.length : nl;
    bounds.push([pos, le]);
    if (text.slice(pos, le) === '---') { close = bounds.length - 1; closeEnd = le; break; }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let li = 0; li < close; li++) {
    const ls = bounds[li][0];
    const le = bounds[li][1];
    // Blank (spaces/tabs only) or a comment ('#' first) is skipped.
    let blank = true;
    for (let i = ls; i < le; i++) {
      const c = text.charCodeAt(i);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (blank || text.charCodeAt(ls) === 35) continue;
    // key: [a-z_]+ ':' ( ' ' rest )?
    let j = ls;
    while (j < le) {
      const c = text.charCodeAt(j);
      if ((c >= 97 && c <= 122) || c === 95) j++;
      else break;
    }
    if (j === ls || j >= le || text.charCodeAt(j) !== 58) return { error: `line ${li + 2} is not "key: value"` };
    const key = text.slice(ls, j);
    let raw;
    if (j + 1 === le) raw = '';
    else if (text.charCodeAt(j + 1) === 32) {
      raw = text.slice(j + 2, le);
      let e = raw.length;
      while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
      raw = raw.slice(0, e);
    } else return { error: `line ${li + 2} is not "key: value"` };
    if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyStart: closeEnd < text.length ? closeEnd + 1 : text.length };
}

// ---------------------------------------------------------------- markdown

/** The characters a backslash escapes, as a 128-entry table. */
const ESCAPABLE_ARR = new Uint8Array(128);
for (const c of [92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]) ESCAPABLE_ARR[c] = 1;

const WS_TEST = /\s/;

/** The characters inline rendering must stop at, scanned natively. */
const SPECIAL_RE = /[\\`*\[&<>"']/g;

/** The first `**` from `from` outside a backslash escape, or -1. */
function findStrongClose(s, from, hi) {
  for (let j = from; j + 1 < hi; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < hi && ESCAPABLE_ARR[s.charCodeAt(j + 1)] === 1) { j++; continue; }
    if (s.charCodeAt(j) === 42 && s.charCodeAt(j + 1) === 42) return j;
  }
  return -1;
}

/** The first `]` from `from` outside a backslash escape, or -1. */
function findBracketClose(s, from, hi) {
  for (let j = from; j < hi; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < hi && ESCAPABLE_ARR[s.charCodeAt(j + 1)] === 1) { j++; continue; }
    if (s.charCodeAt(j) === 93) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, hi) {
  for (let j = from; j < hi; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < hi && ESCAPABLE_ARR[s.charCodeAt(j + 1)] === 1) { j++; continue; }
    if (c !== 42) continue;
    if (j + 1 < hi && s.charCodeAt(j + 1) === 42) { j++; continue; }
    return j;
  }
  return -1;
}

/** s[lo..hi) rendered inline into `out`; `link(target)` is a link's href.
 *  Plain runs are found by a native regex scan; only markup characters are
 *  handled in JS. SPECIAL_RE's lastIndex is set explicitly after every
 *  construct (including after recursive calls), so nesting is safe. */
function inlineRange(s, lo, hi, link, out) {
  SPECIAL_RE.lastIndex = lo;
  let run = lo;
  let m;
  while ((m = SPECIAL_RE.exec(s)) !== null) {
    const i = m.index;
    if (i >= hi) break;
    const c = m[0];
    if (c === '\\') {
      if (i + 1 < hi && ESCAPABLE_ARR[s.charCodeAt(i + 1)] === 1) {
        if (i > run) out.push(s.slice(run, i));
        // The escaped character is itself HTML-escaped: '>' is both
        // escapable and in the escape table, so \> writes &gt;.
        const e = ESC[s[i + 1]];
        out.push(e === undefined ? s[i + 1] : e);
        SPECIAL_RE.lastIndex = i + 2;
        run = i + 2;
        continue;
      }
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < hi && j > i + 1) {
        if (i > run) out.push(s.slice(run, i));
        out.push('<code>', esc(s.slice(i + 1, j)), '</code>');
        SPECIAL_RE.lastIndex = j + 1;
        run = j + 1;
        continue;
      }
      continue;
    }
    if (c === '*') {
      if (i + 1 < hi && s.charCodeAt(i + 1) === 42) {
        const j = findStrongClose(s, i + 2, hi);
        if (j !== -1 && j > i + 2) {
          if (i > run) out.push(s.slice(run, i));
          out.push('<strong>');
          inlineRange(s, i + 2, j, link, out);
          out.push('</strong>');
          SPECIAL_RE.lastIndex = j + 2;
          run = j + 2;
          continue;
        }
        SPECIAL_RE.lastIndex = i + 2;
        continue;
      }
      const j = findSingleStar(s, i + 1, hi);
      if (j !== -1 && j > i + 1) {
        if (i > run) out.push(s.slice(run, i));
        out.push('<em>');
        inlineRange(s, i + 1, j, link, out);
        out.push('</em>');
        SPECIAL_RE.lastIndex = j + 1;
        run = j + 1;
        continue;
      }
      continue;
    }
    if (c === '[') {
      const k = findBracketClose(s, i + 1, hi);
      let mm = -1;
      if (k !== -1 && k + 1 < hi && s.charCodeAt(k + 1) === 40) {
        mm = s.indexOf(')', k + 2);
        if (mm === -1 || mm >= hi) mm = -1;
      }
      if (mm !== -1) {
        const target = s.slice(k + 2, mm);
        if (target !== '' && !WS_TEST.test(target)) {
          if (i > run) out.push(s.slice(run, i));
          out.push('<a href="', esc(link(target)), '">');
          inlineRange(s, i + 1, k, link, out);
          out.push('</a>');
          SPECIAL_RE.lastIndex = mm + 1;
          run = mm + 1;
          continue;
        }
      }
      continue;
    }
    if (i > run) out.push(s.slice(run, i));
    out.push(ESC[c]);
    run = i + 1;
  }
  if (hi > run) out.push(s.slice(run, hi));
}

// --- block line classification over s[ls..le) (no slicing) ---

function lineIsBlank(s, ls, le) {
  for (let i = ls; i < le; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function isSpaceTab(s, i) {
  const c = s.charCodeAt(i);
  return c === 32 || c === 9;
}

/** A fence-open line: its language ('' when none), or null. */
function fenceOpen(s, ls, le) {
  if (le - ls < 3) return null;
  if (s.charCodeAt(ls) !== 96 || s.charCodeAt(ls + 1) !== 96 || s.charCodeAt(ls + 2) !== 96) return null;
  let i = ls + 3;
  const langStart = i;
  while (i < le) {
    const c = s.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = s.slice(langStart, i);
  while (i < le && isSpaceTab(s, i)) i++;
  return i === le ? lang : null;
}

/** A fence-close line: three backticks, spaces or tabs after them. */
function fenceClose(s, ls, le) {
  if (le - ls < 3) return false;
  if (s.charCodeAt(ls) !== 96 || s.charCodeAt(ls + 1) !== 96 || s.charCodeAt(ls + 2) !== 96) return false;
  let i = ls + 3;
  while (i < le && isSpaceTab(s, i)) i++;
  return i === le;
}

/** A heading line: { depth, ts, te } (text bounds, trailing spaces/tabs dropped), or null. */
function headingOf(s, ls, le) {
  let i = ls;
  let depth = 0;
  while (i < le && depth < 6 && s.charCodeAt(i) === 35) { i++; depth++; }
  if (depth === 0) return null;
  if (i >= le || !isSpaceTab(s, i)) return null;
  while (i < le && isSpaceTab(s, i)) i++;
  let e = le;
  while (e > i && isSpaceTab(s, e - 1)) e--;
  if (e <= i) return null;
  return { depth, ts: i, te: e };
}

/** A thematic break: `---` or `***`, then spaces or tabs only. */
function isHR(s, ls, le) {
  if (le - ls < 3) return false;
  const c0 = s.charCodeAt(ls);
  if (c0 !== 45 && c0 !== 42) return false;
  if (s.charCodeAt(ls + 1) !== c0 || s.charCodeAt(ls + 2) !== c0) return false;
  let i = ls + 3;
  while (i < le && isSpaceTab(s, i)) i++;
  return i === le;
}

/** Whether a line ends a paragraph: blank, a fence, a heading or a break. */
function endsParagraph(s, ls, le) {
  return lineIsBlank(s, ls, le) || fenceOpen(s, ls, le) !== null || headingOf(s, ls, le) !== null || isHR(s, ls, le);
}

/** s[ls..le) trimmed of spaces and tabs at both ends, as [a, b). */
function trimBounds(s, ls, le) {
  let a = ls;
  let b = le;
  while (a < b && isSpaceTab(s, a)) a++;
  while (b > a && isSpaceTab(s, b - 1)) b--;
  return [a, b];
}

/**
 * text[start..end) rendered: { html, toc, excerpt }. Single pass, no tokens.
 * `link` resolves link targets; slug ids are unique per page via `ids`.
 */
function renderMarkdown(text, start, end, link, ctx) {
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  let pos = start;
  while (pos < end) {
    let le = text.indexOf('\n', pos);
    if (le === -1 || le > end) le = end;
    const ls = pos;
    if (lineIsBlank(text, ls, le)) { pos = le + 1; continue; }
    const lang = fenceOpen(text, ls, le);
    if (lang !== null) {
      pos = le + 1;
      out.push('<pre><code' + (lang === '' ? '' : ` class="language-${esc(lang)}"`) + '>');
      while (pos < end) {
        let le2 = text.indexOf('\n', pos);
        if (le2 === -1 || le2 > end) le2 = end;
        if (fenceClose(text, pos, le2)) { pos = le2 + 1; break; }
        out.push(esc(text.slice(pos, le2)), '\n');
        pos = le2 + 1;
      }
      out.push('</code></pre>', '\n');
      continue;
    }
    const h = headingOf(text, ls, le);
    if (h !== null) {
      const id = uniqueSlug(slugify(text.slice(h.ts, h.te), ctx), ids);
      const tmp = [];
      inlineRange(text, h.ts, h.te, link, tmp);
      const html = tmp.join('');
      out.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>`, '\n');
      if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
      pos = le + 1;
      continue;
    }
    if (isHR(text, ls, le)) {
      out.push('<hr>', '\n');
      pos = le + 1;
      continue;
    }
    if (text.charCodeAt(ls) === 62) {
      const qlines = [];
      while (pos < end) {
        let le2 = text.indexOf('\n', pos);
        if (le2 === -1 || le2 > end) le2 = end;
        if (text.charCodeAt(pos) !== 62) break;
        let a = pos + 1;
        if (a < le2 && text.charCodeAt(a) === 32) a++;
        const tb = trimBounds(text, a, le2);
        if (tb[1] > tb[0]) qlines.push(text.slice(tb[0], tb[1]));
        pos = le2 + 1;
      }
      if (qlines.length === 0) out.push('<blockquote>\n</blockquote>', '\n');
      else {
        const joined = qlines.join('\n');
        out.push('<blockquote>\n<p>');
        inlineRange(joined, 0, joined.length, link, out);
        out.push('</p>\n</blockquote>', '\n');
      }
      continue;
    }
    // List: a bullet (`- ` / `* `) or an ordered (`digits. `) line starts one.
    let ordered = false;
    let start = 1;
    let isList = false;
    let contentStart = 0;
    {
      const c0 = text.charCodeAt(ls);
      if ((c0 === 45 || c0 === 42) && le - ls >= 2 && text.charCodeAt(ls + 1) === 32) {
        isList = true;
        contentStart = ls + 2;
      } else if (c0 >= 48 && c0 <= 57) {
        let i = ls;
        let digits = 0;
        while (i < le && digits < 9 && text.charCodeAt(i) >= 48 && text.charCodeAt(i) <= 57) { i++; digits++; }
        if (digits >= 1 && digits <= 9 && i + 1 < le && text.charCodeAt(i) === 46 && text.charCodeAt(i + 1) === 32) {
          isList = true;
          ordered = true;
          start = Number(text.slice(ls, i));
          contentStart = i + 2;
        }
      }
    }
    if (isList) {
      const items = [];
      while (pos < end) {
        let le2 = text.indexOf('\n', pos);
        if (le2 === -1 || le2 > end) le2 = end;
        let matched = false;
        if (ordered) {
          const c0 = text.charCodeAt(pos);
          if (c0 >= 48 && c0 <= 57) {
            let i = pos;
            let digits = 0;
            while (i < le2 && digits < 9 && text.charCodeAt(i) >= 48 && text.charCodeAt(i) <= 57) { i++; digits++; }
            if (digits >= 1 && digits <= 9 && i + 1 < le2 && text.charCodeAt(i) === 46 && text.charCodeAt(i + 1) === 32) {
              const tb = trimBounds(text, i + 2, le2);
              items.push([text.slice(tb[0], tb[1])]);
              matched = true;
            }
          }
        } else {
          const c0 = text.charCodeAt(pos);
          if ((c0 === 45 || c0 === 42) && le2 - pos >= 2 && text.charCodeAt(pos + 1) === 32) {
            const tb = trimBounds(text, pos + 2, le2);
            items.push([text.slice(tb[0], tb[1])]);
            matched = true;
          }
        }
        if (matched) { pos = le2 + 1; continue; }
        // Continuation: two or more spaces, then a non-space.
        let ci = pos;
        while (ci < le2 && text.charCodeAt(ci) === 32) ci++;
        if (ci - pos >= 2 && ci < le2 && !isWS(text.charCodeAt(ci))) {
          const tb = trimBounds(text, pos, le2);
          items[items.length - 1].push(text.slice(tb[0], tb[1]));
          pos = le2 + 1;
          continue;
        }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      out.push(open, '\n');
      for (const parts of items) {
        const itemText = parts.join('\n');
        out.push('<li>');
        inlineRange(itemText, 0, itemText.length, link, out);
        out.push('</li>\n');
      }
      out.push(`</${tag}>`, '\n');
      continue;
    }
    // Paragraph: lines up to a blank line, a fence, a heading or a break.
    {
      const parts = [];
      {
        const tb = trimBounds(text, ls, le);
        parts.push(text.slice(tb[0], tb[1]));
      }
      pos = le + 1;
      while (pos < end) {
        let le2 = text.indexOf('\n', pos);
        if (le2 === -1 || le2 > end) le2 = end;
        if (endsParagraph(text, pos, le2)) break;
        const tb = trimBounds(text, pos, le2);
        parts.push(text.slice(tb[0], tb[1]));
        pos = le2 + 1;
      }
      const ptext = parts.join('\n');
      out.push('<p>');
      const mark = out.length;
      inlineRange(ptext, 0, ptext.length, link, out);
      if (excerpt === null) excerpt = out.slice(mark).join('');
      out.push('</p>', '\n');
      continue;
    }
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope frames (innermost last): its first name
 *  from the nearest frame holding it, then own properties. */
function lookup(frames, path) {
  for (let f = frames.length - 1; f >= 0; f--) {
    const vars = frames[f];
    if (Object.hasOwn(vars, path[0])) {
      let v = vars[path[0]];
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    }
  }
  return undefined;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered with `frames` (innermost scope last), appending to `out`.
 *  A for body pushes its frame and pops it after, so nested renders (even a
 *  template including itself) always see the right scopes. */
function renderNodes(nodes, frames, templates, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(esc(textOf(lookup(frames, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(frames, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(frames, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, frames, templates, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(frames, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = Object.create(null);
          vars[n.name] = xs[k];
          vars.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
          frames.push(vars);
          renderNodes(n.body, frames, templates, depth, out);
          frames.pop();
        }
        break;
      }
      case 'include': {
        const t = templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, frames, templates, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

/** Whether `target` opens with a scheme ([A-Za-z][A-Za-z0-9+.-]*:). */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** A page's link record as templates read it. */
function linkOf(s, ctx) {
  return s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date, ctx) };
}

/** A post's card, as lists show it. */
function cardOf(s, ctx) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date, ctx),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOfRange(s.text, s.bodyStart, s.text.length) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it (its card is computed once, in run()). */
function pageOf(s, ctx) {
  const c = s.card;
  return {
    ...c,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null, ctx),
    older: linkOf(s.older ?? null, ctx),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const ctx = { slugCache: new Map(), dateCache: new Map() };
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }
  // 2. Front matter: refused sources and drafts are reported and dropped.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyStart = fm.bodyStart;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  // 3. Permalinks: each page's slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, ctx), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }
  // 4. Markdown, links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.text, s.bodyStart, s.text.length, link, ctx);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }
  // 5. Collections: the posts, newest first and then by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });
  // 6. Tags: grouped by their slug, named as first met in the posts' order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of (s.data.tags ?? [])) {
      const slug = slugify(name, ctx);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, ctx);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name, ctx);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
  // 7. Layouts: every page through its layout, the index pages and the tag pages.
  // Each source's card is computed once and shared by its page view and the lists.
  const cards = new Map();
  for (const s of kept) {
    s.card = cardOf(s, ctx);
    if (s.post) cards.set(s, s.card);
  }
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const scopeVars = Object.create(null);
    scopeVars.site = site;
    scopeVars.tags = allTags;
    scopeVars.recent = recent;
    for (const k of Object.keys(vars)) scopeVars[k] = vars[k];
    const out = [];
    renderNodes(nodes, [scopeVars], templates, 0, out);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s, ctx) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }
  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
