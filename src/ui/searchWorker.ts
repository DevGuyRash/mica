/** Dependency-free worker program shared by the production lightbox and the
 * large-document contract fixture. It intentionally uses only the Web Worker
 * surface available in every supported Obsidian WebView. */
export const SEARCH_WORKER_SOURCE = String.raw`
const advance = (text, index, unicode) => {
  if (!unicode || index >= text.length) return index + 1;
  const first = text.charCodeAt(index);
  return first >= 0xd800 && first <= 0xdbff && index + 1 < text.length ? index + 2 : index + 1;
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

const regexMatches = (doc, needle, flags) => {
  const regex = regexFor(needle, flags);
  const matches = [];
  let match;
  while ((match = regex.exec(doc)) !== null) {
    matches.push(match);
    if (match[0].length === 0) regex.lastIndex = advance(doc, regex.lastIndex, regex.unicode || regex.unicodeSets);
  }
  return matches;
};

const literalMatches = (doc, needle, matchCase) => {
  const escaped = Array.from(needle, (char) => '.+*?^$()[]{}|\\'.includes(char) ? '\\' + char : char).join('');
  const matches = [];
  if (!needle) return matches;
  const regex = new RegExp(escaped, matchCase ? 'gu' : 'giu');
  let match;
  while ((match = regex.exec(doc)) !== null) matches.push(match);
  return matches;
};

self.onmessage = (event) => {
  const request = event.data;
  try {
    const matches = request.regex
      ? regexMatches(request.doc, request.needle, request.flags)
      : literalMatches(request.doc, request.needle, request.matchCase);
    if (request.type === 'scan') {
      const ranges = new Uint32Array(matches.length * 2);
      matches.forEach((match, index) => {
        ranges[index * 2] = match.index;
        ranges[index * 2 + 1] = match.index + match[0].length;
      });
      self.postMessage({ id: request.id, ok: true, type: 'scan', ranges: ranges.buffer }, [ranges.buffer]);
      return;
    }
    const target = request.target ?? -1;
    const replacement = request.replacement ?? '';
    let cursor = 0;
    const parts = [];
    matches.forEach((match, index) => {
      const end = match.index + match[0].length;
      parts.push(request.doc.slice(cursor, match.index));
      const replace = target < 0 || target === index;
      parts.push(replace && request.regex ? expandReplacement(replacement, match, request.doc) : replace ? replacement : match[0]);
      cursor = end;
    });
    parts.push(request.doc.slice(cursor));
    self.postMessage({ id: request.id, ok: true, type: 'replace', text: parts.join('') });
  } catch (error) {
    self.postMessage({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
`;
