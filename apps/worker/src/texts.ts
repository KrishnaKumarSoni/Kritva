/**
 * Registers the bundled guides before any server module reads them (textFile in @kritva/core).
 * index.ts imports this first; it imports only the tiny text-files module, not the rest of core.
 */
import { registerTextFiles } from "@kritva/core/text-files";
import files from "./generated/files.json" with { type: "json" };

registerTextFiles(files.texts);

export const bundledCases: Record<string, string> = files.cases;
