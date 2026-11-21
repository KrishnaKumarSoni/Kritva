/**
 * Quote matching for source references.
 *
 * A quote must be a span of its source after light normalization: case, Unicode width,
 * typographic quotes and dashes, Markdown emphasis characters and whitespace are ignored.
 * Wording is not. This keeps every extracted item tied to text the source actually contains.
 */
export function normalizeForQuoteMatch(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function quoteAppearsIn(sourceText: string, quote: string): boolean {
  const needle = normalizeForQuoteMatch(quote);
  if (needle.length === 0) return false;
  return normalizeForQuoteMatch(sourceText).includes(needle);
}
