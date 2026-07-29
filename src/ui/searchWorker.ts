/** Dependency-free worker program shared by the production lightbox and the
 * large-document contract fixture. It intentionally uses only the Web Worker
 * surface available in every supported Obsidian WebView. */
export const SEARCH_WORKER_SOURCE = String.raw`
const advance = (text, index, unicode) => {
  if (!unicode || index >= text.length) return index + 1;
  const first = text.charCodeAt(index);
  const second = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
  return first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff ? index + 2 : index + 1;
};

const regexFor = (needle, flags) => {
  const normalized = flags.includes('g') ? flags : flags + 'g';
  return new RegExp(needle, normalized);
};

const expandReplacement = (replacement, match, input) => replacement.replace(
  /\$(\$|&|\x60|'|<([^>]+)>|(\d{1,2}))/g,
  (token, kind, groupName, digits) => {
    if (kind === '$') return '$';
    if (kind === '&') return match[0];
    if (kind === '\x60') return input.slice(0, match.index);
    if (kind === "'") return input.slice(match.index + match[0].length);
    if (groupName !== undefined) return match.groups === undefined ? token : (match.groups[groupName] ?? '');
    if (digits !== undefined) {
      let n = Number(digits);
      if (n > 0 && n < match.length) return match[n] ?? '';
      if (digits.length === 2) {
        n = Number(digits[0]);
        if (n > 0 && n < match.length) return (match[n] ?? '') + digits[1];
      }
    }
    return token;
  },
);

const literalRegex = (needle, matchCase) => {
  if (!needle) return null;
  const escaped = Array.from(needle, (char) => '.+*?^$()[]{}|\\'.includes(char) ? '\\' + char : char).join('');
  return new RegExp(escaped, matchCase ? 'gu' : 'giu');
};

const visitMatches = (doc, regex, firstOnly, visit) => {
  if (regex === null) return;
  let match;
  while ((match = regex.exec(doc)) !== null) {
    visit(match);
    if (firstOnly) break;
    if (match[0].length === 0) regex.lastIndex = advance(doc, regex.lastIndex, regex.unicode || regex.unicodeSets);
  }
};

self.onmessage = (event) => {
  const request = event.data;
  try {
    const firstOnly = request.global === false;
    const regex = request.regex
      ? regexFor(request.needle, request.flags)
      : literalRegex(request.needle, request.matchCase);
    if (request.type === 'scan') {
      const offsets = [];
      const replacement = request.replacement ?? '';
      const replacements = [];
      visitMatches(request.doc, regex, firstOnly, (match) => {
        offsets.push(match.index, match.index + match[0].length);
        replacements.push(request.regex ? expandReplacement(replacement, match, request.doc) : replacement);
      });
      const ranges = new Uint32Array(offsets);
      self.postMessage({ id: request.id, ok: true, type: 'scan', ranges: ranges.buffer, replacements }, [ranges.buffer]);
      return;
    }
    const target = request.target ?? -1;
    const replacement = request.replacement ?? '';
    let cursor = 0;
    let index = 0;
    const parts = [];
    visitMatches(request.doc, regex, firstOnly, (match) => {
      const end = match.index + match[0].length;
      parts.push(request.doc.slice(cursor, match.index));
      const replace = target < 0 || target === index;
      parts.push(replace && request.regex ? expandReplacement(replacement, match, request.doc) : replace ? replacement : match[0]);
      cursor = end;
      index++;
    });
    parts.push(request.doc.slice(cursor));
    self.postMessage({ id: request.id, ok: true, type: 'replace', text: parts.join('') });
  } catch (error) {
    self.postMessage({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
`;
