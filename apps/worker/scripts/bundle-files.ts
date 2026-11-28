/**
 * Writes src/generated/files.json: the files the server reads at start-up, which a Worker has no disk for.
 * - texts: every .md guide under packages/core/src and apps/server/src, by file name (read through textFile);
 * - cases: each cases/<case>/case.json, the files it names (mandates, sources, strategy guidance) and
 *   cases/default-strategy-guidance.json, by path under the repository root (read through CaseFiles).
 * The .md and .json files stay the only copies; this runs before every Worker build.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = resolve(import.meta.dirname, "../src/generated/files.json");

function walk(dir: string, keep: (path: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const path = join(dir, d.name);
    if (d.isDirectory()) return d.name === "node_modules" ? [] : walk(path, keep);
    return keep(path) ? [path] : [];
  });
}

const texts: Record<string, string> = {};
for (const dir of ["packages/core/src", "apps/server/src"]) {
  for (const path of walk(join(ROOT, dir), (p) => p.endsWith(".md"))) {
    const name = basename(path);
    if (texts[name] !== undefined) throw new Error(`Two guides are named ${name}; textFile() finds them by name.`);
    texts[name] = readFileSync(path, "utf8");
  }
}

const cases: Record<string, string> = {};
const add = (path: string) => {
  if (!existsSync(path)) return;
  cases[relative(ROOT, path)] = readFileSync(path, "utf8");
};
const casesDir = join(ROOT, "cases");
add(join(casesDir, "default-strategy-guidance.json"));
for (const d of readdirSync(casesDir, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  const file = join(casesDir, d.name, "case.json");
  if (!existsSync(file)) continue;
  add(file);
  const config = JSON.parse(readFileSync(file, "utf8")) as { mandates?: Record<string, { file: string }>; sources?: Record<string, { file: string }>; strategyGuidance?: string };
  for (const entry of [...Object.values(config.mandates ?? {}), ...Object.values(config.sources ?? {})]) add(join(casesDir, d.name, entry.file));
  if (config.strategyGuidance) add(join(casesDir, d.name, config.strategyGuidance));
}

mkdirSync(resolve(OUT, ".."), { recursive: true });
writeFileSync(OUT, JSON.stringify({ texts, cases }));
console.log(`Bundled ${Object.keys(texts).length} guides and ${Object.keys(cases).length} case files into ${relative(ROOT, OUT)}.`);
