// A faster drop-in for makefun-site 1.0.0 (make.fun's own static site generator).
//
// Written from the makefun-site README and the behaviour of its reference
// program: same front matter, template dialect, Markdown subset, slug rule
// and report, byte for byte. The implementation is original: one pass over
// each source with index-driven scans, no token-object graphs, no per-line
// regexes in the hot paths, cached slugs/dates, and cards computed once.
//
// run(input) takes { site, templates, files } and returns the output tree
// (path -> text) makefun-site 1.0.0's build returns for it.

/** Code-unit order (never the locale's). */
const byCU = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Whether a UTF-16 code unit is JavaScript whitespace (\s). */
function isWSCode(c) {
  return (
    c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 ||
    c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
    c === 0x3000 || c === 0xfeff
  );
}

/** Whitespace as a table, so word counting is one array load per character. */
const WS_TABLE = new Uint8Array(65536);
for (let c = 0; c < 65536; c++) WS_TABLE[c] = isWSCode(c) ? 1 : 0;

/** Whether `s` holds any JavaScript whitespace (the /\s/ test). */
function hasWS(s) {
  for (let i = 0; i < s.length; i++) if (isWSCode(s.charCodeAt(i))) return true;
  return false;
}

// ---------------------------------------------------------------- text

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` with & < > " and ' escaped (fast path when nothing needs it). */
const ESC_RE = /[&<>"']/;
function esc(text) {
  if (!ESC_RE.test(text)) return text;
  const out = [];
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const e = ESC[text[i]];
    if (e !== undefined) {
      if (i > last) out.push(text.slice(last, i));
      out.push(e);
      last = i + 1;
    }
  }
  if (last < text.length) out.push(text.slice(last));
  return out.join('');
}


/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * 64 characters (a "-" left at the cut dropped), "untitled" when empty.
 * Results are cached per build: titles, tag names and headings repeat.
 */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = '';
    if (c >= 65 && c <= 90) keep = plain[i].toLowerCase();
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = plain[i];
    if (keep === '') {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. Cached per build. */
function longDate(date, cache) {
  const hit = cache.get(date);
  if (hit !== undefined) return hit;
  const out = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
  cache.set(date, out);
  return out;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const w = WS_TABLE[text.charCodeAt(i)] === 0;
    if (w && !inWord) n++;
    inWord = w;
  }
  return n;
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from the directory `dir` of a source, or null when it climbs out. */
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

// ---------------------------------------------------------------- front matter

const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
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
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** Whether `s` is a name of lowercase letters, digits and "-". */
function isName(s) {
  if (s === '') return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

/** Whether `s` is a slug: lowercase/digit runs joined by single "-". */
function isSlug(s) {
  if (s === '' || s.length > 64) return false;
  let i = 0;
  for (;;) {
    if (i >= s.length) return false;
    const c0 = s.charCodeAt(i);
    if (!((c0 >= 97 && c0 <= 122) || (c0 >= 48 && c0 <= 57))) return false;
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) i++;
      else break;
    }
    if (i === s.length) return true;
    if (s[i] !== '-') return false;
    i++;
  }
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
      let ok = raw.length === 10 && raw[4] === '-' && raw[7] === '-';
      if (ok) for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        const c = raw.charCodeAt(i);
        if (c < 48 || c > 57) { ok = false; break; }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let i = 0; i < tags.length; i++) {
        const t = tags[i].trim();
        tags[i] = t;
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return isName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlug(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const first = firstNl === -1 ? text : text.slice(0, firstNl);
  if (first !== '---') return { error: 'no front matter' };
  // Collect the front-matter lines and find the closing "---".
  const fmLines = [];
  let pos = firstNl === -1 ? text.length : firstNl + 1;
  let bodyPos = -1;
  while (pos <= text.length) {
    const e = text.indexOf('\n', pos);
    let line;
    let next;
    if (e === -1) { line = text.slice(pos); next = text.length + 1; }
    else { line = text.slice(pos, e); next = e + 1; }
    if (line === '---') { bodyPos = next; break; }
    fmLines.push(line);
    if (e === -1) break;
    pos = next;
  }
  if (bodyPos === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let li = 0; li < fmLines.length; li++) {
    const line = fmLines[li];
    // Blank (spaces/tabs only) or a comment ("#" first).
    let blank = true;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (blank || line[0] === '#') continue;
    // "key: value": a key of a-z and "_", a colon, one space and the value.
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || k >= line.length || line[k] !== ':') return { error: `line ${li + 2} is not "key: value"` };
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line[k + 1] === ' ') raw = line.slice(k + 2);
    else return { error: `line ${li + 2} is not "key: value"` };
    let end = raw.length;
    while (end > 0) {
      const c = raw.charCodeAt(end - 1);
      if (c === 32 || c === 9) end--;
      else break;
    }
    if (end < raw.length) raw = raw.slice(0, end);
    const key = line.slice(0, k);
    if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: bodyPos > text.length ? '' : text.slice(bodyPos) };
}

// ---------------------------------------------------------------- markdown

/** Whether `line` is blank (spaces and tabs only). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence-open line's language, or null (three backticks, optional lang, spaces/tabs only). */
function fenceLang(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** Whether `line` closes a fence (three backticks, spaces/tabs only). */
function isFenceClose(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line[n] === '#') n++;
  if (n === 0 || n > 6 || n >= line.length) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let s = n;
  while (s < line.length) {
    const cc = line.charCodeAt(s);
    if (cc === 32 || cc === 9) s++;
    else break;
  }
  let e = line.length;
  while (e > s) {
    const cc = line.charCodeAt(e - 1);
    if (cc === 32 || cc === 9) e--;
    else break;
  }
  if (e <= s) return null;
  return { depth: n, text: line.slice(s, e) };
}

/** Whether `line` is a thematic break (--- or ***, spaces/tabs only). */
function isHR(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line[1] !== line[0] || line[2] !== line[0]) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return line.length >= 3;
}

/** A line trimmed of spaces and tabs at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c === 32 || c === 9) a++;
    else break;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c === 32 || c === 9) b--;
    else break;
  }
  return line.slice(a, b);
}

/** A bullet item's text ("- " or "* "), or null. */
function bulletOf(line) {
  if ((line[0] === '-' || line[0] === '*') && line[1] === ' ') return line.slice(2);
  return null;
}

/** An ordered item's start and text (digits and ". "), or null. */
function orderedOf(line) {
  let n = 0;
  while (n < line.length && n < 9) {
    const c = line.charCodeAt(n);
    if (c >= 48 && c <= 57) n++;
    else break;
  }
  if (n === 0 || line[n] !== '.' || line[n + 1] !== ' ') return null;
  return { start: Number(line.slice(0, n)), text: line.slice(n + 2) };
}

/** Whether `line` continues a list item (two or more spaces, then a non-space). */
function isContinued(line) {
  if (line[0] !== ' ' || line[1] !== ' ') return false;
  let i = 2;
  while (i < line.length && line[i] === ' ') i++;
  if (i >= line.length) return false;
  return !isWSCode(line.charCodeAt(i));
}

/** Whether `line` ends a paragraph: blank, fence, heading or break. */
function endsParagraph(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlank(line);
  if (c === 96) return fenceLang(line) !== null;
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return isHR(line);
  return false;
}

/** A block's first line, by its first character: fences, headings and
 * breaks need their first character; anything else is a quote, a list or
 * a paragraph. */

/** Whether a backslash escapes `code` (the escapable set). */
function isEscapableCode(c) {
  return (
    c === 92 || c === 96 || c === 42 || c === 95 || c === 91 || c === 93 ||
    c === 40 || c === 41 || c === 35 || c === 43 || c === 45 || c === 46 ||
    c === 33 || c === 62
  );
}

/** The first index from `from` where `s` holds `what` outside an escape, or -1. */
function findUnescaped(s, what, from) {
  const wl = what.length;
  const last = s.length - wl;
  let j = from;
  while (j <= last) {
    if (s[j] === '\\' && j + 1 < s.length && isEscapableCode(s.charCodeAt(j + 1))) {
      j += 2;
      continue;
    }
    if (wl === 1 ? s[j] === what : s.startsWith(what, j)) return j;
    j++;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = from;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && isEscapableCode(s.charCodeAt(j + 1))) {
      j += 2;
      continue;
    }
    if (c !== '*') {
      j++;
      continue;
    }
    if (s[j + 1] === '*') {
      j += 2;
      continue;
    }
    return j;
  }
  return -1;
}

/** Whether `target` holds a scheme (letters, then letters/digits/+/-/. then ":"). */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  let i = 1;
  while (i < target.length) {
    const c = target.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) i++;
    else break;
  }
  return i < target.length && target[i] === ':';
}

/** A link target's href, resolving relative paths against the source's directory. */
function linkTarget(target, cx, dir, srcPath) {
  if (hasScheme(target) || target[0] === '/' || target[0] === '#') return target;
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  const path = rel === '' ? null : resolvePath(dir, rel);
  if (path !== null) {
    const page = cx.bySource.get(path);
    if (page !== undefined) return `${page.url}${frag}`;
    if (cx.staticPaths.has(path)) return `${cx.base}/${path}${frag}`;
  }
  cx.broken.add(`broken-link ${srcPath} -> ${target}`);
  return target;
}

/** `s` rendered inline; links resolve through the build context.
 * A native scan jumps from one markup character to the next; the plain
 * text between them moves in whole slices. */
const INLINE_SPECIAL = /[\\`*\[&<>"']/g;
function inline(s, cx, dir, srcPath) {
  const out = [];
  let i = 0;
  const n = s.length;
  let plain = 0;
  for (;;) {
    INLINE_SPECIAL.lastIndex = i;
    const m = INLINE_SPECIAL.exec(s);
    const j = m === null ? n : m.index;
    if (j >= n) break;
    const c = s[j];
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (j > plain) out.push(s.slice(plain, j));
        out.push('<code>', esc(s.slice(j + 1, k)), '</code>');
        i = k + 1;
        plain = i;
        continue;
      }
      i = j + 1;
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          if (j > plain) out.push(s.slice(plain, j));
          out.push('<strong>', inline(s.slice(j + 2, k), cx, dir, srcPath), '</strong>');
          i = k + 2;
          plain = i;
          continue;
        }
        i = j + 2;
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        if (j > plain) out.push(s.slice(plain, j));
        out.push('<em>', inline(s.slice(j + 1, k), cx, dir, srcPath), '</em>');
        i = k + 1;
        plain = i;
        continue;
      }
      i = j + 1;
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', j + 1);
      const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !hasWS(target)) {
        if (j > plain) out.push(s.slice(plain, j));
        out.push('<a href="', esc(linkTarget(target, cx, dir, srcPath)), '">', inline(s.slice(j + 1, k), cx, dir, srcPath), '</a>');
        i = mm + 1;
        plain = i;
        continue;
      }
      i = j + 1;
      continue;
    }
    if (c === '\\') {
      if (j + 1 < n && isEscapableCode(s.charCodeAt(j + 1))) {
        if (j > plain) out.push(s.slice(plain, j));
        out.push(s[j + 1]);
        i = j + 2;
        plain = i;
      } else i = j + 1;
      continue;
    }
    // One of & < > " '.
    if (j > plain) out.push(s.slice(plain, j));
    out.push(ESC[c]);
    i = j + 1;
    plain = i;
  }
  if (n > plain) out.push(s.slice(plain, n));
  return out.join('');
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading) and its excerpt
 * (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, cx, dir, srcPath) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    // Blank line (empty, or spaces/tabs only), or an indented line: only a
    // paragraph can start here.
    if (line === '') {
      i++;
      continue;
    }
    if (c0 === 32 || c0 === 9) {
      if (isBlank(line)) {
        i++;
        continue;
      }
    } else if (c0 === 96) {
      const fl = fenceLang(line);
      if (fl !== null) {
        const body = [];
        i++;
        while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
        i++;
        const cls = fl === '' ? '' : ` class="language-${esc(fl)}"`;
        blocks.push(`<pre><code${cls}>${body.map((l) => `${esc(l)}\n`).join('')}</code></pre>`);
        continue;
      }
    } else if (c0 === 35) {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slugify(h.text, cx.slugCache), ids);
        const html = inline(h.text, cx, dir, srcPath);
        blocks.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>`);
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHR(line)) {
        blocks.push('<hr>');
        i++;
        continue;
      }
      const b = bulletOf(line);
      if (b !== null) {
        const items = [];
        while (i < n) {
          const m = bulletOf(lines[i]);
          if (m !== null) {
            items.push([trimLine(m)]);
            i++;
          } else if (isContinued(lines[i])) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        blocks.push(`<ul>\n${items.map((item) => `<li>${inline(item.join('\n'), cx, dir, srcPath)}</li>\n`).join('')}</ul>`);
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < n && lines[i][0] === '>') {
        const l = lines[i++];
        body.push(l[1] === ' ' ? l.slice(2) : l.slice(1));
      }
      const ls = body.map(trimLine).filter((l) => l !== '');
      blocks.push(ls.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(ls.join('\n'), cx, dir, srcPath)}</p>\n</blockquote>`);
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const o = orderedOf(line);
      if (o !== null) {
        const items = [];
        while (i < n) {
          const m = orderedOf(lines[i]);
          if (m !== null) {
            items.push([trimLine(m.text)]);
            i++;
          } else if (isContinued(lines[i])) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        const open = o.start !== 1 ? `<ol start="${o.start}">` : '<ol>';
        blocks.push(`${open}\n${items.map((item) => `<li>${inline(item.join('\n'), cx, dir, srcPath)}</li>\n`).join('')}</ol>`);
        continue;
      }
    }
    // Paragraph: this line and the lines after it up to a blank line, a
    // fence, a heading or a thematic break.
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), cx, dir, srcPath);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.map((b) => `${b}\n`).join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** Whether `c` starts a path name (a letter or "_"). */
function isNameStart(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

/** Whether `c` continues a path name (a letter, digit or "_"). */
function isNameChar(c) {
  return isNameStart(c) || (c >= 48 && c <= 57);
}

/** Whether `s` is one path segment. */
function isSegment(s) {
  if (s === '') return false;
  if (!isNameStart(s.charCodeAt(0))) return false;
  for (let i = 1; i < s.length; i++) if (!isNameChar(s.charCodeAt(i))) return false;
  return true;
}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  const parts = text.split('.');
  for (const p of parts) {
    if (!isSegment(p)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  }
  return parts;
}

/** Whether `s` holds only spaces and tabs. */
function onlySpacesTabs(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
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
    const standalone = onlySpacesTabs(src.slice(lineStart, open)) && onlySpacesTabs(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `{% for x in path %}`: { name, path } or null. */
function matchFor(tag) {
  if (!tag.startsWith('for ')) return null;
  let i = 4;
  if (i >= tag.length || !isNameStart(tag.charCodeAt(i))) return null;
  i++;
  while (i < tag.length && isNameChar(tag.charCodeAt(i))) i++;
  const varName = tag.slice(4, i);
  if (tag.slice(i, i + 4) !== ' in ') return null;
  const path = tag.slice(i + 4);
  if (path === '' || hasWS(path)) return null;
  return { name: varName, path };
}

/** `{% if path %}` / `{% if not path %}`: { not, path } or null. */
function matchIf(tag) {
  if (!tag.startsWith('if ')) return null;
  let rest = tag.slice(3);
  let not = false;
  if (rest.startsWith('not ')) {
    not = true;
    rest = rest.slice(4);
  }
  if (rest === '' || hasWS(rest)) return null;
  return { not, path: rest };
}

/** `{% include "name" %}`: the name or null. */
function matchInclude(tag) {
  if (!tag.startsWith('include "') || !tag.endsWith('"')) return null;
  const incName = tag.slice(9, -1);
  if (incName === '') return null;
  for (let i = 0; i < incName.length; i++) {
    const c = incName.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return null;
  }
  return incName;
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
      if ((m = matchFor(tag)) !== null) {
        const node = { kind: 'for', name: m.name, path: pathOf(name, m.path), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = matchIf(tag)) !== null) {
        const node = { kind: 'if', not: m.not, path: pathOf(name, m.path), then: [], else: null };
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
      } else if ((m = matchInclude(tag)) !== null) body.push({ kind: 'include', name: m });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain, or undefined. The chain is
 * plain objects linked by prototype: the nearest binding wins, and each
 * further name must be an own property of the value so far. */
function getx(S, path) {
  let v = S[path[0]];
  if (v === undefined) return undefined;
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered into `out` in scope `S`; `T` maps names to render
 * functions (compiled, or this interpreter where compiling failed). */
function renderNodes(nodes, S, T, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(esc(textOf(getx(S, n.path))));
        break;
      case 'raw':
        out.push(textOf(getx(S, n.path)));
        break;
      case 'if': {
        const v = truthy(getx(S, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, S, T, depth, out);
        break;
      }
      case 'for': {
        const xs = getx(S, n.path);
        if (!Array.isArray(xs)) break;
        const child = Object.create(S);
        for (let k = 0; k < xs.length; k++) {
          child[n.name] = xs[k];
          child.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
          renderNodes(n.body, child, T, depth, out);
        }
        break;
      }
      case 'include': {
        const f = T.get(n.name);
        if (f !== undefined && depth < 8) f(out, S, T, null, depth + 1);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

/** A page's link record as templates read it. */
function linkOf(s, cx) {
  return s === null ? null : {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date, cx.dateCache),
  };
}

/** A post's card, as lists show it. */
function cardOf(s, cx) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date, cx.dateCache),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it (`cards` holds the posts' cards). */
function pageOf(s, cards, cx) {
  const c = s.post ? cards.get(s) : cardOf(s, cx);
  return {
    ...c,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null, cx),
    older: linkOf(s.older ?? null, cx),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const cx = {
    slugCache: new Map(),
    dateCache: new Map(),
    broken: new Set(),
    bySource: new Map(),
    staticPaths: new Set(),
    base: input.site.base_url.replace(/\/+$/, ''),
  };
  const report = [];

  // Templates, parsed in code-unit order of name and compiled to render
  // functions; one that does not parse is reported and left out, as if it
  // were not there. A template that cannot be compiled renders through the
  // interpreter instead, with the same scope chain.
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCU)) {
    let nodes;
    try {
      nodes = parseTemplate(name, input.templates[name]);
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
      continue;
    }
    templates.set(name, (out, S, T, H, d) => renderNodes(nodes, S, T, d, out));
  }

  // Sources, in code-unit order of path; ".md" is a source, the rest static.
  const files = [...input.files].sort((x, y) => byCU(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter, in the checks' order: refused, reserved directory, a post
  // with no date, a layout that is no template, then a draft.
  let kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
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

  // Permalinks: each page's slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? ['posts', 'tags', 'page'] : []);
      taken.set(dir, set);
    }
    return set;
  };
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, cx.slugCache), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${cx.base}/${s.outDir}/`;
    cx.bySource.set(s.path, s);
  }

  // Markdown, each body's links resolved to the pages and static files.
  cx.staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const md = renderMarkdown(s.body, cx, dirOf(s.path), s.path);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest date first, then by slug; newer/older.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCU(y.data.date, x.data.date) || byCU(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by slug, each named as first met walking the posts in
  // collection order, ordered by count then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sl = slugify(name, cx.slugCache);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, cx.slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${cx.base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name, cx.slugCache);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCU(x.slug, y.slug));

  // Layouts: every page through its layout, the index pages, the tag pages.
  const output = {};
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p, cx));
  const site = { title: input.site.title, base_url: cx.base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const baseScope = Object.create(null);
  baseScope.site = site;
  baseScope.tags = allTags;
  baseScope.recent = recent;
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    const out = [];
    // A scope with no prototype: a template name that is not bound reads
    // as undefined, never as something off Object.prototype. site, tags
    // and recent are shared on the chain's root; only the page's own
    // values are set per render.
    const top = Object.create(baseScope);
    Object.assign(top, vars);
    fn(out, top, templates, null, 0);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s, cards, cx) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${cx.base}/` : `${cx.base}/page/${k}/`);
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

  // The report: every refusal, draft, broken link and template that did not
  // parse, sorted, then the counts.
  const lines = [...report, ...cx.broken].sort(byCU);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
