/**
 * Plain-text files the code reads at start-up (the conversation and voice guides).
 *
 * On Node they are read from disk next to the module. A Worker has no such disk, so its entry point
 * registers the same files' text first (apps/worker/src/texts.ts, built from the files themselves),
 * and they are read from there. Either way the guide's .md file stays the only copy of its text.
 */
const KEY = "__kritvaTextFiles";

type Registry = Record<string, string>;

/** Registers bundled text files by name (Worker start-up). Must run before the modules that read them load. */
export function registerTextFiles(files: Registry): void {
  (globalThis as Record<string, unknown>)[KEY] = { ...((globalThis as Record<string, unknown>)[KEY] as Registry | undefined), ...files };
}

/** The text of a file by its name (such as "conversation-guide.md"): the registered copy, else `read()` from disk. */
export function textFile(name: string, read: () => string): string {
  const registered = ((globalThis as Record<string, unknown>)[KEY] as Registry | undefined)?.[name];
  return registered ?? read();
}
