import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { diskCaseFiles, loadCaseRuntime, snapshotCaseFiles } from "../src/main-helpers.ts";

const ROOT = resolve(import.meta.dirname, "../../..");

/** Every file under cases/, as the Worker's bundle holds them: by path under the repository root. */
function snapshot(): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, d.name);
      if (d.isDirectory()) walk(path);
      else files[relative(ROOT, path)] = readFileSync(path, "utf8");
    }
  };
  walk(join(ROOT, "cases"));
  return files;
}

describe("Case files on Cloudflare", () => {
  it("the bundled snapshot of cases/ loads the same configuration as the disk", () => {
    const fromDisk = loadCaseRuntime(ROOT, null, diskCaseFiles);
    const fromSnapshot = loadCaseRuntime("/kritva", null, snapshotCaseFiles("/kritva", snapshot()));
    expect(fromSnapshot.mandates).toEqual(fromDisk.mandates);
    expect(fromSnapshot.examples).toEqual(fromDisk.examples);
    expect(fromSnapshot.listings).toEqual(fromDisk.listings);
    expect([...fromSnapshot.guidanceByCase]).toEqual([...fromDisk.guidanceByCase]);
    expect(fromSnapshot.defaultGuidance).toEqual(fromDisk.defaultGuidance);
    expect(fromDisk.listings.length).toBeGreaterThan(0);
  });

  it("lists only directories and reports missing files", () => {
    const files = snapshotCaseFiles("/kritva", { "cases/a/case.json": "{}", "cases/b/x/y.json": "{}", "cases/top.json": "{}" });
    expect(files.dirs("/kritva/cases")).toEqual(["a", "b"]);
    expect(files.exists("/kritva/cases/a/case.json")).toBe(true);
    expect(files.exists("/kritva/cases/c/case.json")).toBe(false);
    expect(() => files.read("/kritva/cases/c/case.json")).toThrow(/not bundled/);
  });
});
