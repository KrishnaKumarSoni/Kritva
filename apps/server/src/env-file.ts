/**
 * Updating a .env file in place: the named keys get their new values (added at the end when missing);
 * every other line, comment and blank line stays exactly as it was.
 */

/** A value as a .env line holds it: quoted when it has spaces, quotes, # or angle brackets. */
function quoted(value: string): string {
  return /[\s"'#<>]/.test(value) ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : value;
}

export function setEnvValues(text: string, values: Record<string, string>): string {
  const pending = new Map(Object.entries(values));
  const replaced = new Set<string>();
  const lines = text.split("\n");
  // Every line that sets a key is updated, so a duplicate further down can't win over the new value.
  const out = lines.map((line) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    const key = match?.[1];
    if (!key || !(key in values)) return line;
    replaced.add(key);
    return `${key}=${quoted(values[key]!)}`;
  });
  for (const key of replaced) pending.delete(key);
  if (pending.size) {
    while (out.length && out.at(-1) === "") out.pop();
    if (out.length) out.push("");
    for (const [key, value] of pending) out.push(`${key}=${quoted(value)}`);
    out.push("");
  }
  return out.join("\n");
}
