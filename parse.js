// Fast Markdown renderer: byte-for-byte compatible with marked 18.1.3
// default options (gfm: true, breaks: false, pedantic: false, async: false).
// Written from scratch as a default-specialized implementation of the same
// block/inline lexing algorithm. No dependencies, no options, no extensions.
//
// Layout:
//   1. small string helpers (escape, entities, urls, cells, trimming)
//   2. regex tables: block rules, inline rules (GFM), shared "other" regexes
//   3. block tokenizer, inline tokenizer, lexer state machine
//   4. renderer (block + inline) and the exported parse() entry point.

// ---------------------------------------------------------------- helpers

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/;
const ESC_RE_G = /[&<>"']/g;
// & is left alone when it already starts something entity-like.
const ESC_NO_ENC_RE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESC_NO_ENC_RE_G = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function esc(s, encode) {
  if (encode) {
    if (ESC_RE.test(s)) return s.replace(ESC_RE_G, c => ESC_MAP[c]);
  } else if (ESC_NO_ENC_RE.test(s)) {
    return s.replace(ESC_NO_ENC_RE_G, c => ESC_MAP[c]);
  }
  return s;
}

const NUM_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUM_REF_G = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Decode numeric character references only; named entities pass through.
function unescapeEntities(s) {
  if (!NUM_REF.test(s)) return s;
  return s.replace(NUM_REF_G, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}

function cleanUrl(href) {
  try { return encodeURI(href).replace(/%25/g, '%'); } catch { return null; }
}

// Split one table row on unescaped pipes; pad/truncate to `count` cells.
function splitCells(row, count) {
  const t = row.replace(/\|/g, (ch, off, str) => {
    let odd = false, p = off;
    while (--p >= 0 && str[p] === '\\') odd = !odd;
    return odd ? '|' : ' |';
  });
  const cells = t.split(' |');
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// Strip `count` trailing chars equal to `ch` (or not equal when `invert`).
function rtrim(s, ch, invert) {
  const n = s.length;
  if (n === 0) return '';
  let k = 0;
  for (; k < n;) {
    const c = s.charAt(n - k - 1);
    if (c === ch && !invert) k++;
    else if (c !== ch && invert) k++;
    else break;
  }
  return s.slice(0, n - k);
}

// Drop trailing blank lines of a code/html block, unless there is at most
// one trailing blank line (then the raw text is kept verbatim).
function trimBlankTail(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  for (; t >= 0 && /^[ \t]*$/.test(lines[t]);) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}

// Expand tabs to spaces, tracking the column `col` (default 0).
function expandTabs(s, col = 0) {
  let out = '', n = col;
  for (const ch of s) {
    if (ch === '\t') { const w = 4 - n % 4; out += ' '.repeat(w); n += w; }
    else { out += ch; n++; }
  }
  return out;
}

// Normalize a link-reference label: collapse whitespace, fold case.
function normLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Find the index of the closing bracket in `s` for the opener at its start
// (skipping backslash escapes). -1 = no bracket at all, -2 = unclosed.
function closingBracket(s, pair) {
  if (s.indexOf(pair[0]) === -1 && s.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === pair[0]) depth++;
    else if (s[i] === pair[1]) { depth--; if (depth < 0) return i; }
  }
  return depth > 0 ? -2 : -1;
}

// Regex composer: build a RegExp from a pattern (string or RegExp) and apply
// string/regex replacements whose values are pattern sources. A doubled
// caret "^^" in a replacement becomes a single "^" anchor.
const CARET_RE = /(^|[^\[])\^/g;
function rx(pattern, flags = '') {
  let src = typeof pattern === 'string' ? pattern : pattern.source;
  const api = {
    replace(search, repl) {
      let rep = typeof repl === 'string' ? repl : repl.source;
      rep = rep.replace(CARET_RE, '$1');
      src = src.replace(search, rep);
      return api;
    },
    get() { return new RegExp(src, flags); },
  };
  return api;
}

// Memoize indent-dependent regex factories (indent clamped to 0..3).
function memoIndent(fn) {
  const cache = [];
  return n => {
    const k = Math.max(0, Math.min(3, n - 1));
    return cache[k] || (cache[k] = fn(k));
  };
}

// First line of `s` without allocating a split array.
function firstLine(s) {
  const i = s.indexOf('\n');
  return i === -1 ? s : s.slice(0, i);
}

// Necessary condition for the setext-heading regex to match: some line
// before the first blank line is an === / --- underline. Scans lines
// manually; far cheaper than running the setext regex (or a guard regex)
// over the whole block.
function setextGuard(src) {
  let i = src.indexOf('\n');
  if (i === -1) return false;
  i++;
  while (i < src.length) {
    let j = i;
    while (j < src.length && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9)) j++;
    if (j >= src.length || src.charCodeAt(j) === 10) return false; // blank line
    let k = i, sp = 0;
    while (sp < 3 && src.charCodeAt(k) === 32) { k++; sp++; }
    const c = src.charCodeAt(k);
    if (c === 61 || c === 45) {
      let m = k + 1;
      while (m < src.length) {
        const ch = src.charCodeAt(m);
        if (ch === 10) break;
        if (ch !== c && ch !== 32 && ch !== 9) break;
        m++;
      }
      if (m >= src.length || src.charCodeAt(m) === 10) return true;
    }
    const nl = src.indexOf('\n', i);
    if (nl === -1) return false;
    i = nl + 1;
  }
  return false;
}

// Necessary condition for the GFM table regex: the second line starts
// (after at most 3 spaces) with |, - or :.
function tableGuard(src) {
  const nl = src.indexOf('\n');
  if (nl < 0) return false;
  let i = nl + 1, sp = 0;
  while (sp < 3 && src.charCodeAt(i) === 32) { i++; sp++; }
  const c = src.charCodeAt(i);
  return c === 124 || c === 45 || c === 58;
}

// ------------------------------------------------------- shared "other" re

const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

const O = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: a => new RegExp(`^( {0,3}${a})((?:[ \t][^\n]*)?(?:\n|$))`),
  nextBulletRegex: memoIndent(n => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\n|$))`)),
  hrRegex: memoIndent(n => new RegExp(`^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`)),
  fencesBeginRegex: memoIndent(n => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`)),
  headingBeginRegex: memoIndent(n => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`)),
  htmlBeginRegex: memoIndent(n => new RegExp(`^ {0,${n}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')),
  blockquoteBeginRegex: memoIndent(n => new RegExp(`^ {0,${n}}>`)),
};

// ---------------------------------------------------------- block regexes

const HR_SRC = '^ {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const HEADING_SRC = ' {0,3}#{1,6}(?:\\s|$)';
const HTML_OPEN_SRC = ' {0,3}(?:</?(?:' + BLOCK_TAGS + ')(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';
const FENCES_SRC = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
const BULLET = / {0,3}(?:[*+-]|\d{1,9}[.)])/;

// Paragraph body: lines that do not start a new block construct.
const PARA_BODY = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
function paraRegex(listSrc) {
  return rx(PARA_BODY)
    .replace('hr', new RegExp(HR_SRC))
    .replace('heading', HEADING_SRC)
    .replace('|lheading', '')
    .replace('|table', '')
    .replace('blockquote', ' {0,3}>')
    .replace('fences', FENCES_SRC)
    .replace('list', listSrc)
    .replace('html', HTML_OPEN_SRC)
    .get();
}

// Setext heading: text lines then a === or --- underline.
const SETEXT_SRC = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const SETEXT_TABLE = / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/;
function setextRegex() {
  return rx(SETEXT_SRC)
    .replace(/bull/g, BULLET)
    .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
    .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
    .replace(/blockquote/g, / {0,3}>/)
    .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
    .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
    .replace(/html/g, / {0,3}<[^\n>]+>\n/)
    .replace(/table/g, SETEXT_TABLE)
    .get();
}

const HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const BLOCK_HTML = rx('^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))', 'i')
  .replace('comment', HTML_COMMENT)
  .replace('tag', BLOCK_TAGS)
  .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .get();

// Link reference definition.
const LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const DEF = rx(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', LABEL)
  .replace('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .get();

// GFM table: header line, delimiter line, optional body rows.
const TABLE = rx("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)")
  .replace('hr', new RegExp(HR_SRC))
  .replace('heading', HEADING_SRC)
  .replace('blockquote', ' {0,3}>')
  .replace('code', /(?: {4}| {0,3}\t)[^\n]/)
  .replace('fences', FENCES_SRC)
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace('html', HTML_OPEN_SRC)
  .get();

const BLOCK = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  hr: new RegExp(HR_SRC),
  html: BLOCK_HTML,
  def: DEF,
  table: TABLE,
  lheading: setextRegex(),
  list: rx(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g, BULLET).get(),
  blockquote: rx(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/).replace('paragraph', paraRegex(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/)).get(),
  paragraph: rx(PARA_BODY)
    .replace('hr', new RegExp(HR_SRC))
    .replace('heading', HEADING_SRC)
    .replace('|lheading', '')
    .replace('table', TABLE)
    .replace('blockquote', ' {0,3}>')
    .replace('fences', FENCES_SRC)
    .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
    .replace('html', HTML_OPEN_SRC)
    .get(),
  text: /^[^\n]+/,
};

// --------------------------------------------------------- inline regexes

const PUNCT = /[\p{P}\p{S}]/u;              // any punctuation / symbol
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;      // punctuation, symbol or space
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u; // word character
const TILDE_PUNCT = /(?!~)[\p{P}\p{S}]/u;
const TILDE_PUNCT_SPACE = /(?!~)[\s\p{P}\p{S}]/u;
const TILDE_NOT_PUNCT_SPACE = /(?:[^\s\p{P}\p{S}]|~)/u;

const EMAIL_LOCAL = /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/;
const SCHEME = /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/;
const EMAIL_GFM = /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EMAIL_PLAIN = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const PROTOCOL = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;

// Label / href / title pieces shared by link and reflink rules.
const BRACKETS = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const LABEL_INLINE = rx(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/).replace('brackets', BRACKETS).get();
const LABEL_INLINE_LOOSE = rx(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/).replace('brackets', BRACKETS).get();
const REF_LABEL = /(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const HREF = /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/;
const TITLE = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/;

const INLINE = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  // left delimiter for * / _ emphasis runs
  emLDelim: rx(/^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/, 'u').replace(/punct/g, TILDE_PUNCT).get(),
  // right-delimiter scanners for * and _ (with tilde-aware classes)
  emRDelimAst: rx('^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)', 'gu')
    .replace(/notPunctSpace/g, TILDE_NOT_PUNCT_SPACE).replace(/punctSpace/g, TILDE_PUNCT_SPACE).replace(/punct/g, TILDE_PUNCT).get(),
  emRDelimUnd: rx('^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)', 'gu')
    .replace(/notPunctSpace/g, NOT_PUNCT_SPACE).replace(/punctSpace/g, PUNCT_SPACE).replace(/punct/g, PUNCT).get(),
  delLDelim: rx(/^~~?(?:((?!~)punct)|[^\s~])/, 'u').replace(/punct/g, PUNCT).get(),
  delRDelim: rx('^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)', 'gu')
    .replace(/notPunctSpace/g, NOT_PUNCT_SPACE).replace(/punctSpace/g, PUNCT_SPACE).replace(/punct/g, PUNCT).get(),
  autolink: rx(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/).replace('scheme', SCHEME).replace('email', EMAIL_LOCAL).get(),
  tag: rx("^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>")
    .replace('comment', rx(HTML_COMMENT).replace('(?:-->|$)', '-->').get())
    .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
    .get(),
  link: rx(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
    .replace('label', LABEL_INLINE).replace('href', HREF).replace('title', TITLE).get(),
  reflink: rx(/^!?\[(label)\]\[(ref)\]/).replace('label', LABEL_INLINE).replace('ref', LABEL).get(),
  nolink: rx(/^!?\[(ref)\](?:\[\])?/).replace('ref', LABEL).get(),
  reflinkSearch: rx('reflink|nolink(?!\\()', 'g')
    .replace('reflink', rx(/^!?\[(label)\]\[(ref)\]/).replace('label', LABEL_INLINE_LOOSE).replace('ref', REF_LABEL).get())
    .replace('nolink', rx(/^!?\[(ref)\](?:\[\])?/).replace('ref', REF_LABEL).get())
    .get(),
  url: rx(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
    .replace('emailProtocol', rx(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).replace(/email/g, EMAIL_PLAIN).get())
    .replace('protocol', PROTOCOL)
    .replace('email', EMAIL_GFM)
    .get(),
  backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
  punctuation: /^((?![*_])[\s\p{P}\p{S}])/u,
  anyPunct: /\\([\p{P}\p{S}])/gu,
  anyPunctOutsideCode: /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu,
  blockSkip: rx(/link|(?<!`)()code|html/, 'g')
    .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
    .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
    .replace('html', /<(?! )[^<>]*?>/)
    .get(),
  text: rx(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
    .replace('protocol', PROTOCOL)
    .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
    .replace('wwwStart', '(?<![^\\s*_~(])www\\.')
    .get(),
};

// ------------------------------------------------------ block tokenizer

class Tok {
  constructor(lexer) { this.lexer = lexer; }

  space(src) {
    const m = BLOCK.newline.exec(src);
    if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
  }

  code(src) {
    const m = BLOCK.code.exec(src);
    if (m) {
      const raw = trimBlankTail(m[0]);
      const text = raw.replace(O.codeRemoveIndent, '');
      return { type: 'code', raw, codeBlockStyle: 'indented', text };
    }
  }

  fences(src) {
    const m = BLOCK.fences.exec(src);
    if (m) {
      const raw = m[0];
      let text = m[3] || '';
      // Remove up to the opening fence's indent from each content line.
      const ind = raw.match(O.indentCodeCompensation);
      if (ind !== null) {
        const w = ind[1];
        text = text.split('\n').map(line => {
          const sp = line.match(O.beginningSpace);
          if (sp === null) return line;
          return line.slice(Math.min(sp[0].length, w.length));
        }).join('\n');
      }
      const lang = m[2] ? m[2].trim().replace(INLINE.anyPunct, '$1') : m[2];
      return { type: 'code', raw, lang, text };
    }
  }

  heading(src) {
    const m = BLOCK.heading.exec(src);
    if (m) {
      let text = m[2].trim();
      if (O.endingHash.test(text)) {
        const stripped = rtrim(text, '#');
        if (!stripped || O.endingSpaceTabChar.test(stripped)) text = stripped.trim();
      }
      return { type: 'heading', raw: rtrim(m[0], '\n'), depth: m[1].length, text, tokens: this.lexer.inline(text) };
    }
  }

  hr(src) {
    const m = BLOCK.hr.exec(src);
    if (m) return { type: 'hr', raw: rtrim(m[0], '\n') };
  }

  blockquote(src) {
    const m = BLOCK.blockquote.exec(src);
    if (m) {
      const lines = rtrim(m[0], '\n').split('\n');
      let raw = '', text = '';
      const tokens = [];
      let rest = lines;
      while (rest.length > 0) {
        let inQuote = false;
        const chunk = [];
        let p = 0;
        for (; p < rest.length; p++) {
          if (O.blockquoteStart.test(rest[p])) { chunk.push(rest[p]); inQuote = true; }
          else if (!inQuote) chunk.push(rest[p]);
          else break;
        }
        rest = rest.slice(p);
        const chunkRaw = chunk.join('\n');
        const stripped = chunkRaw
          .replace(O.blockquoteMarkerWhitespace, (g, mark, ws) => mark + expandTabs(ws, mark.length))
          .replace(O.blockquoteSetextReplace, '\n    $1')
          .replace(O.blockquoteSetextReplace2, '');
        raw = raw ? raw + '\n' + chunkRaw : chunkRaw;
        text = text ? text + '\n' + stripped : stripped;
        const top = this.lexer.state.top;
        this.lexer.state.top = true;
        this.lexer.blockTokens(stripped, tokens, true);
        this.lexer.state.top = top;
        if (rest.length === 0) break;
        const last = tokens[tokens.length - 1];
        if (last?.type === 'code' || last?.type === 'heading' || last?.type === 'hr' || last?.type === 'html' || last?.type === 'table') break;
        if (last?.type === 'blockquote') {
          const inner = last;
          const joined = inner.raw + '\n' + rest.join('\n').replace(O.blockquoteSetextReplace2, '');
          const retok = this.blockquote(joined);
          tokens[tokens.length - 1] = retok;
          const tail = joined.substring(retok.raw.length).replace(/^\n/, '');
          const tailLines = tail ? tail.split('\n').length : 0;
          const consumed = tailLines ? rest.slice(0, -tailLines) : rest;
          if (consumed.length > 0) {
            raw = raw + '\n' + consumed.join('\n');
            text = text.substring(0, text.length - inner.text.length) + retok.text;
          } else {
            text = text.substring(0, text.length - inner.text.length) + retok.text;
          }
          rest = rest.slice(consumed.length);
          if (rest.length > 0 && O.blockquoteStart.test(rest[0])) continue;
          break;
        } else if (last?.type === 'list') {
          const inner = last;
          const joined = inner.raw + '\n' + rest.join('\n');
          const retok = this.list(joined);
          tokens[tokens.length - 1] = retok;
          const extra = retok.raw.length > inner.raw.length
            ? joined.slice(inner.raw.length + 1, retok.raw.length).split('\n').length : 0;
          if (extra > 0) {
            const extraLines = rest.slice(0, extra).join('\n');
            raw = raw + '\n' + extraLines;
            text = text + '\n' + extraLines;
          }
          rest = rest.slice(extra);
          continue;
        }
      }
      return { type: 'blockquote', raw, tokens, text };
    }
  }

  list(src) {
    const m = BLOCK.list.exec(src);
    if (m) {
      const full = src;
      const at = () => full.length - src.length;
      const marker = m[1].trim();
      const ordered = marker.length > 1;
      const list = { type: 'list', raw: '', ordered, start: ordered ? +marker.slice(0, -1) : '', loose: false, items: [] };
      const markerRe = ordered ? `\\d{1,9}\\${marker.slice(-1)}` : `\\${marker}`;
      const itemRe = O.listItemRegex(markerRe);
      let sawDoubleBlank = false;
      for (; src;) {
        let emptyItem = false, itemText = '';
        let t = itemRe.exec(src);
        if (!t || BLOCK.hr.test(src)) break;
        const start = at();
        src = src.substring(t[0].length);
        const itemFirst = t[2].split('\n', 1)[0];
        const markerLen = t[1].length;
        let content = itemFirst.replace(O.leadingSpaceTab, v => expandTabs(v, markerLen));
        let nextLine = firstLine(src);
        let contentEmpty = !content.trim();
        let indent;
        if (contentEmpty) indent = markerLen + 1;
        else {
          indent = content.search(O.nonSpaceChar);
          indent = indent > 4 ? 1 : indent;
          itemText = content.slice(indent);
          indent += markerLen;
        }
        if (contentEmpty && O.blankLine.test(nextLine)) {
          src = src.substring(nextLine.length + 1);
          emptyItem = true;
        }
        if (!emptyItem) {
          const nextBullet = O.nextBulletRegex(indent);
          const hrRe = O.hrRegex(indent);
          const fencesRe = O.fencesBeginRegex(indent);
          const headingRe = O.headingBeginRegex(indent);
          const htmlRe = O.htmlBeginRegex(indent);
          const quoteRe = O.blockquoteBeginRegex(indent);
          for (; src;) {
            const line = firstLine(src);
            let expanded;
            nextLine = line;
            const lc0 = line.charCodeAt(0);
            expanded = (lc0 === 32 || lc0 === 9) ? line.replace(O.leadingSpaceTab, v => expandTabs(v)) : line;
            // Guard: none of the six break rules can match unless the first
            // non-space char (within the item indent) starts one of them.
            let sp2 = 0;
            while (sp2 < indent && line.charCodeAt(sp2) === 32) sp2++;
            const lc = line.charCodeAt(sp2);
            const mayBreak = lc === 96 || lc === 126 || lc === 35 || lc === 60 || lc === 62 ||
              lc === 42 || lc === 43 || lc === 45 || lc === 95 || (lc >= 48 && lc <= 57);
            if (mayBreak && (fencesRe.test(line) || headingRe.test(line) || htmlRe.test(line) || quoteRe.test(line) || nextBullet.test(line) || hrRe.test(line))) break;
            if (expanded.search(O.nonSpaceChar) >= indent || !line.trim()) {
              itemText += '\n' + expanded.slice(indent);
            } else {
              if (contentEmpty || content.replace(O.tabCharGlobal, '    ').search(O.nonSpaceChar) >= 4 ||
                  fencesRe.test(content) || headingRe.test(content) || htmlRe.test(content) || hrRe.test(content)) break;
              const setext = /^ {0,3}(?:=+|-+) *$/.test(line) && BLOCK.lheading.test(content + '\n' + line)
                ? '    ' + expanded.replace(/^ {0,3}/, '') : line;
              itemText += '\n' + setext;
            }
            contentEmpty = !line.trim();
            src = src.substring(line.length + 1);
            content = expanded.slice(indent);
          }
        }
        const itemRaw = full.slice(start, at());
        if (!list.loose) {
          if (sawDoubleBlank) list.loose = true;
          else if (O.doubleBlankLine.test(itemRaw)) sawDoubleBlank = true;
        }
        list.items.push({ type: 'list_item', raw: itemRaw, task: !!O.listIsTask.test(itemText), loose: false, text: itemText, tokens: [] });
      }
      const lastItem = list.items[list.items.length - 1];
      if (!lastItem) return;
      lastItem.raw = lastItem.raw.trimEnd();
      lastItem.text = lastItem.text.trimEnd();
      list.raw = full.slice(0, at()).trimEnd();
      for (const item of list.items) {
        this.lexer.state.top = false;
        item.tokens = this.lexer.blockTokens(item.text, []);
        if (!list.loose) {
          const spaces = item.tokens.filter(tok => tok.type === 'space');
          if (spaces.length > 0 && spaces.some(tok => O.anyLine.test(tok.raw))) list.loose = true;
        }
      }
      for (const item of list.items) {
        const first = item.tokens[0];
        if (item.task && (first?.type === 'text' || first?.type === 'paragraph')) {
          item.text = item.text.replace(O.listReplaceTask, '');
          first.raw = first.raw.replace(O.listReplaceTask, '');
          first.text = first.text.replace(O.listReplaceTask, '');
          for (let i = this.lexer.inlineQueue.length - 1; i >= 0; i--) {
            if (O.listIsTask.test(this.lexer.inlineQueue[i].src)) {
              this.lexer.inlineQueue[i].src = this.lexer.inlineQueue[i].src.replace(O.listReplaceTask, '');
              break;
            }
          }
          const cb = O.listTaskCheckbox.exec(item.raw);
          if (cb) {
            const box = { type: 'checkbox', raw: cb[0] + ' ', checked: cb[0] !== '[ ]' };
            item.checked = box.checked;
            if (item.loose || list.loose) {
              if (first && (first.type === 'paragraph' || first.type === 'text') && 'tokens' in first && first.tokens) {
                first.raw = box.raw + first.raw;
                first.text = box.raw + first.text;
                first.tokens.unshift(box);
              } else {
                item.tokens.unshift({ type: 'paragraph', raw: box.raw, text: box.raw, tokens: [box] });
              }
            } else {
              item.tokens.unshift(box);
            }
          }
        } else if (item.task) {
          item.task = false;
        }
      }
      if (list.loose) {
        for (const item of list.items) {
          item.loose = true;
          for (const tok of item.tokens) if (tok.type === 'text') tok.type = 'paragraph';
        }
      }
      return list;
    }
  }

  html(src) {
    const m = BLOCK.html.exec(src);
    if (m) {
      const raw = trimBlankTail(m[0]);
      return { type: 'html', block: true, raw, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style', text: raw };
    }
  }

  def(src) {
    const m = BLOCK.def.exec(src);
    if (m) {
      if (!O.startAngleBracket.test(m[2]) && closingBracket(m[2], '()') !== -1) return;
      const tag = normLabel(m[1]);
      const href = m[2] ? m[2].replace(O.hrefBrackets, '$1').replace(INLINE.anyPunct, '$1') : '';
      const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(INLINE.anyPunct, '$1') : m[3];
      return { type: 'def', tag, raw: rtrim(m[0], '\n'), href, title };
    }
  }

  table(src) {
    const m = BLOCK.table.exec(src);
    if (!m || !O.tableDelimiter.test(m[2])) return;
    const header = splitCells(m[1]);
    const aligns = m[2].replace(O.tableAlignChars, '').split('|');
    const bodyLines = m[3]?.trim() ? m[3].replace(O.tableRowBlankLine, '').split('\n') : [];
    const table = { type: 'table', raw: rtrim(m[0], '\n'), header: [], align: [], rows: [] };
    if (header.length === aligns.length) {
      for (const a of aligns) {
        if (O.tableAlignRight.test(a)) table.align.push('right');
        else if (O.tableAlignCenter.test(a)) table.align.push('center');
        else if (O.tableAlignLeft.test(a)) table.align.push('left');
        else table.align.push(null);
      }
      for (let i = 0; i < header.length; i++) {
        table.header.push({ text: header[i], tokens: this.lexer.inline(header[i]), header: true, align: table.align[i] });
      }
      for (const line of bodyLines) {
        table.rows.push(splitCells(line, table.header.length).map((cell, i) => ({ text: cell, tokens: this.lexer.inline(cell), header: false, align: table.align[i] })));
      }
      return table;
    }
  }

  lheading(src) {
    const m = BLOCK.lheading.exec(src);
    if (m) {
      const text = m[1].trim();
      return { type: 'heading', raw: rtrim(m[0], '\n'), depth: m[2].charAt(0) === '=' ? 1 : 2, text, tokens: this.lexer.inline(text) };
    }
  }

  paragraph(src) {
    const m = BLOCK.paragraph.exec(src);
    if (m) {
      const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
      return { type: 'paragraph', raw: m[0], text, tokens: this.lexer.inline(text) };
    }
  }

  text(src) {
    const m = BLOCK.text.exec(src);
    if (m) return { type: 'text', raw: m[0], text: m[0], tokens: this.lexer.inline(m[0]) };
  }
}

// ------------------------------------------- emphasis masking (emStrongMask)

// Scan `src` for the last delimiter run of each kind whose preceding char is
// not blank. Used to bail out of emphasis/del scans that cannot close.
function scanDelims(src) {
  const last = { '*': -1, '_': -1 };
  let lastTilde = -1;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < src.length && src[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') lastTilde = i; else last[ch] = i;
    }
    i = j - 1;
  }
  return { src, star: last, tilde: lastTilde };
}

// Mask link/code/html spans so emphasis scanning does not see their
// delimiters. Reference links that resolve are masked too (their text is
// replaced by filler of equal length, keeping offsets intact).
function maskSrc(lex, src) {
  let s = src;
  if (lex.tokens.links && src.includes('[')) {
    const re = INLINE.reflinkSearch;
    const fill = m => {
      const open = m.lastIndexOf('[');
      if (!Object.hasOwn(lex.tokens.links, normLabel(m.slice(open + 1, -1)))) return m;
      if (open > 1 && m.charAt(0) !== '!') {
        const inner = m.slice(1, open - 1);
        if (linkInText(lex, inner)) return '[' + inner.replace(re, fill) + '][' + 'a'.repeat(m.length - open - 2) + ']';
      }
      return '[' + 'a'.repeat(m.length - 2) + ']';
    };
    s = s.replace(re, fill);
  }
  // Mask code spans / inline links / raw html so emphasis scanning does not
  // see their delimiters. Only needed when one of those can occur.
  if (src.includes('`') || src.includes('\\')) {
    s = s.replace(INLINE.anyPunctOutsideCode, (m, ticks, punct) => {
      if (punct) return '+'.repeat(m.length);
      if (ticks) return ticks + m.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks;
      return m;
    });
  }
  if (src.includes('[') || src.includes('<') || src.includes('`')) {
    s = s.replace(INLINE.blockSkip, m => '[' + 'a'.repeat(m.length - 2) + ']');
  }
  return s;
}

// ---------------------------------------------------- inline tokenizer

// Does `src` contain a link (inline or reference) that is not an image?
function linkInText(lex, src) {
  if (!src.includes('[')) return false;
  const linkRe = INLINE.link;
  for (const m of src.matchAll(INLINE.blockSkip)) {
    if (linkRe.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of src.matchAll(INLINE.reflinkSearch)) {
    const s = m[0], open = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !Object.hasOwn(lex.tokens.links, normLabel(s.slice(open + 1, -1)))) &&
        !(open > 1 && linkInText(lex, s.slice(1, open - 1)))) return true;
  }
  return false;
}

class InlineTok {
  constructor(lexer) { this.lexer = lexer; }

  escape(src) {
    const m = INLINE.escape.exec(src);
    if (m) return { type: 'escape', raw: m[0], text: m[1] };
  }

  tag(src) {
    const m = INLINE.tag.exec(src);
    if (m) {
      const st = this.lexer.state;
      if (!st.inLink && O.startATag.test(m[0])) st.inLink = true;
      else if (st.inLink && O.endATag.test(m[0])) st.inLink = false;
      if (!st.inRawBlock && O.startPreScriptTag.test(m[0])) st.inRawBlock = true;
      else if (st.inRawBlock && O.endPreScriptTag.test(m[0])) st.inRawBlock = false;
      return { type: 'html', raw: m[0], inLink: st.inLink, inRawBlock: st.inRawBlock, block: false, text: m[0] };
    }
  }

  // True when a `<...>` tag/autolink starting inside the link label would
  // run past the label's end: such a link is not a link at all.
  linkInsideHtml(src, label, imgOffset) {
    if (!label.includes('<')) return false;
    for (let i = 0; i < label.length; i++) {
      if (label[i] === '\\') { i++; continue; }
      if (label[i] === '`') {
        const code = INLINE.code.exec(label.slice(i));
        if (code) { i += code[0].length - 1; continue; }
      }
      if (label[i] !== '<') continue;
      const rest = src.slice(imgOffset + i);
      const tag = INLINE.tag.exec(rest) || INLINE.autolink.exec(rest);
      if (tag) {
        if (tag[0].length > label.length - i) return true;
        i += tag[0].length - 1;
      }
    }
    return false;
  }

  makeLink(match, ref, raw, lex) {
    const label = match[1].replace(O.outputLinkReplace, '$1');
    const isImage = match[0].charAt(0) === '!';
    const st = lex.state;
    const wasInLink = st.inLink, wasEmitted = st.linkEmitted, wasRawBlock = st.inRawBlock;
    st.inLink = true; st.linkEmitted = false;
    const tokens = lex.inlineTokens(label);
    const emittedInside = st.linkEmitted;
    st.linkEmitted = wasEmitted; st.inLink = wasInLink;
    if (!isImage) {
      if (emittedInside) { st.inRawBlock = wasRawBlock; return undefined; }
      st.linkEmitted = true;
    }
    return { type: isImage ? 'image' : 'link', raw, href: ref.href, title: ref.title || null, text: label, tokens };
  }

  link(src) {
    const lex = this.lexer;
    if (lex.state.linkParenPossible === false) return;
    const m = INLINE.link.exec(src);
    if (m) {
      const imgOff = m[0].charAt(0) === '!' ? 2 : 1;
      if (this.linkInsideHtml(src, m[1], imgOff)) return;
      let href = m[2].trim();
      if (O.startAngleBracket.test(href)) {
        if (!O.endAngleBracket.test(href)) return;
        const cut = rtrim(href.slice(0, -1), '\\');
        if ((href.length - cut.length) % 2 === 0) return;
      } else {
        const close = closingBracket(m[2], '()');
        if (close === -2) return;
        if (close > -1) {
          const cutAt = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + close;
          m[2] = m[2].substring(0, close);
          m[0] = m[0].substring(0, cutAt).trim();
          m[3] = '';
        }
      }
      const cut2 = rtrim(m[0].slice(0, -1), '\\');
      if ((m[0].length - cut2.length) % 2 === 0) return;
      let url = m[2], title = '';
      title = m[3] ? m[3].slice(1, -1) : '';
      url = url.trim();
      if (O.startAngleBracket.test(url)) url = url.slice(1, -1);
      return this.makeLink(m, {
        href: url && url.replace(INLINE.anyPunct, '$1'),
        title: title && title.replace(INLINE.anyPunct, '$1'),
      }, m[0], lex);
    }
  }

  reflink(src) {
    const lex = this.lexer;
    const m = INLINE.reflink.exec(src) || INLINE.nolink.exec(src);
    if (m) {
      const imgOff = m[0].charAt(0) === '!' ? 2 : 1;
      if (this.linkInsideHtml(src, m[1], imgOff)) return;
      const ref = lex.tokens.links[normLabel(m[2] || m[1])];
      if (!ref) {
        const ch = m[0].charAt(0);
        return { type: 'text', raw: ch, text: ch };
      }
      return this.makeLink(m, ref, m[0], lex);
    }
  }

  emStrong(src, masked, prevChar = '') {
    const lex = this.lexer;
    const m = INLINE.emLDelim.exec(src);
    if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return;
    const delim = m[0][0];
    const sameAsPrev = prevChar === delim;
    const full = masked;
    let i = full.length - src.length;
    const pos = i;
    for (; i > 0 && full[i - 1] === delim;) i--;
    const beforeRun = [...full.slice(Math.max(0, i - 2), i)].at(-1) ?? '';
    const beforeIsPunct = beforeRun === '*' || beforeRun === '_' || !!INLINE.punctuation.exec(beforeRun);
    if (i < pos) prevChar = beforeRun;
    const prevIsPunct = i < pos ? beforeIsPunct : !!INLINE.punctuation.exec(prevChar);
    if (m[4] && prevChar.match(O.unicodeAlphaNumeric)) return;
    const after = m[1] || m[3] || '';
    if (!after || !prevChar || prevIsPunct) {
      const runLen = [...m[0]].length - 1;
      let len = runLen, used = 0, openers = 0;
      const total = pos - i + runLen;
      const canOpen = !!beforeRun.trim() && (!!after || (delim === '*' && !beforeIsPunct));
      if (delim !== '*' && delim !== '_') return;
      const rdelim = delim === '*' ? INLINE.emRDelimAst : INLINE.emRDelimUnd;
      const lastCloser = lex.maskStar(masked, delim);
      const startIdx = full.length - src.length + runLen;
      if (lastCloser < startIdx) return;
      let rest = full.slice(-src.length + runLen);
      const limit = lastCloser - startIdx;
      rdelim.lastIndex = 0;
      let r;
      while ((r = rdelim.exec(rest)) !== null && !(r.index > limit)) {
        const g = r[1] || r[2] || r[3] || r[4] || r[5] || r[6];
        if (!g) continue;
        const glen = [...g].length;
        if (r[3] || r[4]) { len += glen; continue; }
        else if (r[5] || r[6] || canOpen) {
          if (sameAsPrev && (r[5] || r[6])) break;
          if (total % 3 && !((total + glen) % 3)) { used += glen; continue; }
        }
        if ((len -= glen) > 0) continue;
        const take = Math.min(glen, glen + len + used);
        const firstLen = [...r[0]][0].length;
        const raw = src.slice(0, runLen + r.index + firstLen + take);
        if (Math.min(runLen, take) % 2) {
          const inner = raw.slice(1, -1);
          return { type: 'em', raw, text: inner, tokens: lex.inlineTokens(inner) };
        }
        const inner = raw.slice(2, -2);
        return { type: 'strong', raw, text: inner, tokens: lex.inlineTokens(inner) };
      }
    }
  }

  codespan(src) {
    const m = INLINE.code.exec(src);
    if (m) {
      let text = m[2].replace(O.newLineCharGlobal, ' ');
      const hasNonSpace = O.nonSpaceChar.test(text);
      const padded = O.startingSpaceChar.test(text) && O.endingSpaceChar.test(text);
      if (hasNonSpace && padded) text = text.substring(1, text.length - 1);
      return { type: 'codespan', raw: m[0], text };
    }
  }

  br(src) {
    const m = INLINE.br.exec(src);
    if (m) return { type: 'br', raw: m[0] };
  }

  del(src, masked, prevChar = '') {
    const lex = this.lexer;
    const m = INLINE.delLDelim.exec(src);
    if (!m) return;
    if (!(m[1] || '') || !prevChar || INLINE.punctuation.exec(prevChar)) {
      const runLen = [...m[0]].length - 1;
      let openers = runLen;
      const rdelim = INLINE.delRDelim;
      const lastCloser = lex.maskTilde(masked);
      const startIdx = masked.length - src.length + runLen;
      if (lastCloser < startIdx) return;
      let rest = masked.slice(-src.length + runLen);
      const limit = lastCloser - startIdx;
      rdelim.lastIndex = 0;
      let r;
      while ((r = rdelim.exec(rest)) !== null && !(r.index > limit)) {
        const g = r[1] || r[2] || r[3] || r[4] || r[5] || r[6];
        if (!g) continue;
        const glen = [...g].length;
        if (glen !== runLen) continue;
        if (r[3] || r[4]) { openers += glen; continue; }
        if ((openers -= glen) > 0) continue;
        const take = Math.min(glen, glen + openers);
        const firstLen = [...r[0]][0].length;
        const raw = src.slice(0, runLen + r.index + firstLen + take);
        const inner = raw.slice(runLen, -runLen);
        return { type: 'del', raw, text: inner, tokens: lex.inlineTokens(inner) };
      }
    }
  }

  autolink(src) {
    const m = INLINE.autolink.exec(src);
    if (m) {
      let text, href;
      if (m[2] === '@') { text = m[1]; href = 'mailto:' + text; }
      else { text = m[1]; href = text; }
      return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
    }
  }

  url(src) {
    const m = INLINE.url.exec(src);
    if (m) {
      let text, href;
      if (m[2] === '@') { text = m[0]; href = 'mailto:' + text; }
      else {
        let cur;
        do { cur = m[0]; m[0] = INLINE.backpedal.exec(m[0])?.[0] ?? ''; } while (cur !== m[0]);
        text = m[0];
        href = m[1] === 'www.' ? 'http://' + m[0] : m[0];
      }
      return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
    }
  }

  inlineText(src) {
    const m = INLINE.text.exec(src);
    if (m) {
      const inRaw = this.lexer.state.inRawBlock;
      return { type: 'text', raw: m[0], text: inRaw ? m[0] : unescapeEntities(m[0]), escaped: inRaw };
    }
  }
}

// ------------------------------------------------------------------ lexer

class Lex {
  constructor() {
    this.tokens = [];
    this.tokens.links = Object.create(null);
    this.inlineQueue = [];
    this.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
    this.maskStack = [];
    this.tok = new Tok(this);
    this.itok = new InlineTok(this);
  }

  lex(src) {
    src = src.replace(O.carriageReturn, '\n');
    this.blockTokens(src, this.tokens);
    for (let i = 0; i < this.inlineQueue.length; i++) {
      const q = this.inlineQueue[i];
      this.state.inRawBlock = false;
      this.inlineTokens(q.src, q.tokens);
    }
    this.inlineQueue = [];
    return this.tokens;
  }

  blockTokens(src, tokens = [], nested = false) {
    let guard = Infinity;
    for (; src;) {
      if (src.length < guard) guard = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      // First-char guards: each block rule can only match when the first
      // (up to 3-space indented) character is one of a small set.
      const c0 = src.charCodeAt(0);
      let sp = 0;
      while (sp < 3 && src.charCodeAt(sp) === 32) sp++;
      const c = src.charCodeAt(sp);
      let r;
      if ((c0 === 32 || c0 === 9 || c0 === 10) && (r = this.tok.space(src))) {
        src = src.substring(r.raw.length);
        const prev = tokens[tokens.length - 1];
        if (r.raw.length === 1 && prev !== undefined) prev.raw += '\n';
        else tokens.push(r);
        continue;
      }
      if ((c0 === 32 || c0 === 9) && (r = this.tok.code(src))) {
        src = src.substring(r.raw.length);
        const prev = tokens[tokens.length - 1];
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.raw;
          prev.text += '\n' + r.text;
          this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
        } else tokens.push(r);
        continue;
      }
      if ((c === 96 || c === 126) && (r = this.tok.fences(src))) { src = src.substring(r.raw.length); tokens.push(r); continue; }
      if (c === 35 && (r = this.tok.heading(src))) { src = src.substring(r.raw.length); tokens.push(r); continue; }
      if ((c === 45 || c === 95 || c === 42) && (r = this.tok.hr(src))) { src = src.substring(r.raw.length); tokens.push(r); continue; }
      if (c === 62 && (r = this.tok.blockquote(src))) { src = src.substring(r.raw.length); tokens.push(r); continue; }
      if ((c === 42 || c === 43 || c === 45 || (c >= 48 && c <= 57)) && (r = this.tok.list(src))) { src = src.substring(r.raw.length); tokens.push(r); continue; }
      if (c === 60 && (r = this.tok.html(src))) { src = src.substring(r.raw.length); tokens.push(r); continue; }
      if (c === 91 && (r = this.tok.def(src))) {
        src = src.substring(r.raw.length);
        const prev = tokens[tokens.length - 1];
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.raw;
          prev.text += '\n' + r.raw;
          this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
        } else {
          if (!this.tokens.links[r.tag]) this.tokens.links[r.tag] = { href: r.href, title: r.title };
          tokens.push(r);
        }
        continue;
      }
      if (tableGuard(src) && (r = this.tok.table(src))) { src = src.substring(r.raw.length); tokens.push(r); continue; }
      if (setextGuard(src) && (r = this.tok.lheading(src))) { src = src.substring(r.raw.length); tokens.push(r); continue; }
      if (this.state.top && (r = this.tok.paragraph(src))) {
        const prev = tokens[tokens.length - 1];
        if (nested && prev?.type === 'paragraph') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.raw;
          prev.text += '\n' + r.text;
          this.inlineQueue.pop();
          this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
        } else tokens.push(r);
        nested = false;
        src = src.substring(r.raw.length);
        continue;
      }
      if ((r = this.tok.text(src))) {
        src = src.substring(r.raw.length);
        const prev = tokens[tokens.length - 1];
        if (prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.raw;
          prev.text += '\n' + r.text;
          this.inlineQueue.pop();
          this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
        } else tokens.push(r);
        continue;
      }
      if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    this.state.top = true;
    return tokens;
  }

  inline(src, tokens = []) {
    this.inlineQueue.push({ src, tokens });
    return tokens;
  }

  inlineTokens(src, tokens = []) {
    const saved = this.state.linkParenPossible;
    this.state.linkParenPossible = saved && src.includes(')');
    try {
      const masked = (src.includes('*') || src.includes('_') || src.includes('~')) ? maskSrc(this, src) : src;
      this.maskStack.push({ src: masked, scan: null });
      try {
        return this.inlineLoop(src, masked, tokens);
      } finally {
        this.maskStack.pop();
      }
    } finally {
      this.state.linkParenPossible = saved;
    }
  }

  maskStar(masked, ch) {
    const top = this.maskStack[this.maskStack.length - 1];
    if (top && top.src === masked) {
      if (!top.scan) top.scan = scanDelims(masked);
      return top.scan.star[ch];
    }
    return scanDelims(masked).star[ch];
  }

  maskTilde(masked) {
    const top = this.maskStack[this.maskStack.length - 1];
    if (top && top.src === masked) {
      if (!top.scan) top.scan = scanDelims(masked);
      return top.scan.tilde;
    }
    return scanDelims(masked).tilde;
  }

  inlineLoop(src, masked, tokens) {
    let wasText = false, prevChar = '', guard = Infinity;
    for (; src;) {
      if (src.length < guard) guard = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      if (!wasText) prevChar = '';
      wasText = false;
      // First-char guards: each inline rule can only match at a position
      // starting with one of a small set of characters.
      const c0 = src.charCodeAt(0);
      const c1 = src.charCodeAt(1);
      const isLinkStart = c0 === 91 || (c0 === 33 && c1 === 91);
      let t;
      if (c0 === 92 && (t = this.itok.escape(src))) { src = src.substring(t.raw.length); tokens.push(t); continue; }
      if (c0 === 60 && (t = this.itok.tag(src))) { src = src.substring(t.raw.length); tokens.push(t); continue; }
      if (isLinkStart && (t = this.itok.link(src))) { src = src.substring(t.raw.length); tokens.push(t); continue; }
      if (isLinkStart && (t = this.itok.reflink(src))) {
        src = src.substring(t.raw.length);
        const prev = tokens[tokens.length - 1];
        if (t.type === 'text' && prev?.type === 'text') { prev.raw += t.raw; prev.text += t.text; }
        else tokens.push(t);
        continue;
      }
      if ((c0 === 42 || c0 === 95) && (t = this.itok.emStrong(src, masked, prevChar))) { src = src.substring(t.raw.length); tokens.push(t); continue; }
      if (c0 === 96 && (t = this.itok.codespan(src))) { src = src.substring(t.raw.length); tokens.push(t); continue; }
      if ((c0 === 32 || c0 === 92) && (t = this.itok.br(src))) { src = src.substring(t.raw.length); tokens.push(t); continue; }
      if (c0 === 126 && (t = this.itok.del(src, masked, prevChar))) { src = src.substring(t.raw.length); tokens.push(t); continue; }
      if (c0 === 60 && (t = this.itok.autolink(src))) { src = src.substring(t.raw.length); tokens.push(t); continue; }
      if (!this.state.inLink && (c0 >= 48 && c0 <= 57 || c0 >= 65 && c0 <= 90 || c0 >= 97 && c0 <= 122 || c0 === 46 || c0 === 95 || c0 === 43 || c0 === 45) && (t = this.itok.url(src))) { src = src.substring(t.raw.length); tokens.push(t); continue; }
      if ((t = this.itok.inlineText(src))) {
        src = src.substring(t.raw.length);
        if (t.raw.slice(-1) !== '_') prevChar = t.raw.slice(-1);
        wasText = true;
        const prev = tokens[tokens.length - 1];
        if (prev?.type === 'text') { prev.raw += t.raw; prev.text += t.text; }
        else tokens.push(t);
        continue;
      }
      if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    return tokens;
  }
}

// --------------------------------------------------------------- renderer

function renderInline(tokens, textMode) {
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'escape': out += textMode ? t.text : esc(t.text); break;
      case 'html': out += t.text; break;
      case 'link': {
        if (textMode) { out += renderInline(t.tokens, true); break; }
        const inner = t.autolink ? esc(t.text, true) : renderInline(t.tokens, false);
        const href = cleanUrl(t.href);
        if (href === null) { out += inner; break; }
        let s = '<a href="' + esc(href, t.autolink) + '"';
        if (t.title) s += ' title="' + esc(t.title) + '"';
        out += s + '>' + inner + '</a>';
        break;
      }
      case 'image': {
        let alt = t.text;
        if (t.tokens) alt = renderInline(t.tokens, true);
        if (textMode) { out += alt; break; }
        const href = cleanUrl(t.href);
        if (href === null) { out += esc(alt); break; }
        let s = '<img src="' + esc(href) + '" alt="' + esc(alt) + '"';
        if (t.title) s += ' title="' + esc(t.title) + '"';
        out += s + '>';
        break;
      }
      case 'checkbox': out += textMode ? t.raw : '<input ' + (t.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> '; break;
      case 'strong': out += textMode ? renderInline(t.tokens, true) : '<strong>' + renderInline(t.tokens, false) + '</strong>'; break;
      case 'em': out += textMode ? renderInline(t.tokens, true) : '<em>' + renderInline(t.tokens, false) + '</em>'; break;
      case 'codespan': out += textMode ? t.text : '<code>' + esc(t.text, true) + '</code>'; break;
      case 'br': out += textMode ? '' : '<br>'; break;
      case 'del': out += textMode ? renderInline(t.tokens, true) : '<del>' + renderInline(t.tokens, false) + '</del>'; break;
      case 'text':
        if (textMode) { out += t.text; break; }
        out += t.tokens ? renderInline(t.tokens, false) : (t.escaped ? t.text : esc(t.text));
        break;
    }
  }
  return out;
}

function renderBlock(tokens) {
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'space': break;
      case 'hr': out += '<hr>\n'; break;
      case 'heading': out += '<h' + t.depth + '>' + renderInline(t.tokens, false) + '</h' + t.depth + '>\n'; break;
      case 'code': {
        const lang = (t.lang || '').match(O.notSpaceStart)?.[0];
        const body = t.text ? t.text.replace(O.endingNewline, '') + '\n' : '';
        const inner = t.escaped ? body : esc(body, true);
        out += lang ? '<pre><code class="language-' + esc(lang) + '">' + inner + '</code></pre>\n'
                    : '<pre><code>' + inner + '</code></pre>\n';
        break;
      }
      case 'table': {
        let head = '';
        for (const c of t.header) head += tableCell(c);
        let rows = '';
        for (const row of t.rows) {
          let cells = '';
          for (const c of row) cells += tableCell(c);
          rows += '<tr>\n' + cells + '</tr>\n';
        }
        out += '<table>\n<thead>\n<tr>\n' + head + '</tr>\n</thead>\n' + (rows ? '<tbody>' + rows + '</tbody>' : '') + '</table>\n';
        break;
      }
      case 'blockquote': out += '<blockquote>\n' + renderBlock(t.tokens) + '</blockquote>\n'; break;
      case 'list': {
        let items = '';
        for (const it of t.items) items += '<li>' + renderBlock(it.tokens) + '</li>\n';
        const tag = t.ordered ? 'ol' : 'ul';
        const start = t.ordered && t.start !== 1 ? ' start="' + t.start + '"' : '';
        out += '<' + tag + start + '>\n' + items + '</' + tag + '>\n';
        break;
      }
      case 'checkbox': out += '<input ' + (t.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> '; break;
      case 'html': out += t.text; break;
      case 'def': break;
      case 'paragraph': out += '<p>' + renderInline(t.tokens, false) + '</p>\n'; break;
      case 'text': out += t.tokens ? renderInline(t.tokens, false) : (t.escaped ? t.text : esc(t.text)); break;
    }
  }
  return out;
}

function tableCell(c) {
  const tag = c.header ? 'th' : 'td';
  return (c.align ? '<' + tag + ' align="' + c.align + '">' : '<' + tag + '>') + renderInline(c.tokens, false) + '</' + tag + '>\n';
}

// ------------------------------------------------------------------ export

/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  if (typeof markdown !== 'string') throw new Error('marked(): input parameter is of type ' + Object.prototype.toString.call(markdown) + ', string expected');
  return renderBlock(new Lex().lex(markdown));
}
