/** Canonicalize HTTP media types without discarding representation parameters. */
function canonicalContentType(value: string): string | undefined {
  const media = /^[\t ]*([!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+)[\t ]*/.exec(value);
  if (!media) { return undefined; }
  let remaining = value.slice(media[0].length);
  const parameters = new Map<string, string>();
  while (remaining) {
    const parameter = /^;[\t ]*([!#$%&'*+.^_`|~0-9A-Za-z-]+)=([!#$%&'*+.^_`|~0-9A-Za-z-]+|"(?:[\t\x20\x21\x23-\x5B\x5D-\x7E\x80-\xFF]|\\[\t\x20-\x7E\x80-\xFF])*")[\t ]*/.exec(remaining);
    if (!parameter) { return undefined; }
    const name = parameter[1].toLowerCase();
    // Duplicate parameters are ambiguous; do not guess which one a server used.
    if (parameters.has(name)) { return undefined; }
    let contents = parameter[2];
    if (contents.startsWith('"')) { contents = contents.slice(1, -1).replace(/\\([\t\x20-\x7E\x80-\xFF])/g, '$1'); }
    // Charset names are case-insensitive. Unknown values, profiles and multipart
    // boundaries remain case-sensitive and must all survive the comparison.
    parameters.set(name, name === 'charset' ? contents.toLowerCase() : contents);
    remaining = remaining.slice(parameter[0].length);
  }
  // RFC 8259 defines no charset parameter for application/json and requires
  // UTF-8 for interoperable exchange. Its explicit UTF-8 spelling adds no
  // information; do not extend this default to other types or encodings.
  if (media[1].toLowerCase() === 'application/json' && parameters.get('charset') === 'utf-8') {
    parameters.delete('charset');
  }
  return JSON.stringify([media[1].toLowerCase(), [...parameters].sort(([a], [b]) => a.localeCompare(b))]);
}

/** Compare equivalent HTTP spellings, keeping malformed/ambiguous values opaque. */
export function equalContentTypes(left: string | undefined, right: string | undefined): boolean {
  if (left === right) { return true; }
  if (typeof left !== 'string' || typeof right !== 'string') { return false; }
  const canonical = canonicalContentType(left);
  return canonical !== undefined && canonical === canonicalContentType(right);
}
