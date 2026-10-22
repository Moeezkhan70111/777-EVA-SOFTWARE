import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// @erp/domain IS BUNDLED INTO THE RENDERER, SO IT MUST NOT TOUCH NODE.
//
// apps/desktop/scripts/build-renderer.mjs runs esbuild over the renderer with a BROWSER target,
// and the renderer imports @erp/domain. A node built-in anywhere in this package therefore fails
// the renderer bundle -- not the type check, the BUNDLE, which is a different step with different
// output:
//
//   X [ERROR] Could not resolve "node:crypto"
//       ../../packages/domain/dist/productIdentity.js:1:19
//
// That is a real release failure from 2026-10-23. deriveProductVariantId was written here,
// beside the QR identity rules, because that is where it belongs by subject -- and it imported
// node:crypto for SHA-1. `tsc` was perfectly happy; the release build was not, and it stopped
// after the tag had already been pushed. The function moved to @erp/data, which is main-process
// only.
//
// This test exists because the type checker cannot see this class of mistake and the error
// appears only in a packaging run, which is the slowest and latest place to find anything.
//
// IF THIS FAILS: the file named needs a browser-safe implementation, or it belongs in @erp/data
// (main process) rather than here. Do not add a bundler shim to make a node built-in work in the
// renderer -- the point of this package is that it runs in both places unchanged.

const SRC = import.meta.dirname.endsWith("dist")
  ? path.resolve(import.meta.dirname, "../src")
  : import.meta.dirname;

/** Every TypeScript source in this package that is not a test. */
function sourceFiles(): string[] {
  return fs
    .readdirSync(SRC)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts"))
    .map((name) => path.join(SRC, name));
}

test("no file in @erp/domain imports a node built-in", () => {
  const offenders: string[] = [];

  for (const file of sourceFiles()) {
    const text = fs.readFileSync(file, "utf8");
    // Covers `from "node:x"`, `import "node:x"`, `require("node:x")` and dynamic import().
    const matches = text.match(/["']node:[a-z_/]+["']/g);
    if (matches !== null) {
      offenders.push(`${path.basename(file)} -> ${[...new Set(matches)].join(", ")}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `@erp/domain is bundled into the renderer and must stay browser-safe. Offending files:\n  ${offenders.join("\n  ")}`
  );
});

test("the bare node module names are refused too, not only the node: prefix", () => {
  // `import crypto from "crypto"` resolves the same built-in without the prefix, and esbuild
  // fails on it in just the same way. Checked separately because the pattern above cannot see it.
  const bare = ["crypto", "fs", "path", "os", "child_process", "node:sqlite", "electron"];
  const offenders: string[] = [];

  for (const file of sourceFiles()) {
    const text = fs.readFileSync(file, "utf8");
    for (const name of bare) {
      if (new RegExp(`from\\s+["']${name}["']`).test(text) || new RegExp(`require\\(["']${name}["']\\)`).test(text)) {
        offenders.push(`${path.basename(file)} -> ${name}`);
      }
    }
  }

  assert.deepEqual(offenders, [], `browser-unsafe imports in @erp/domain:\n  ${offenders.join("\n  ")}`);
});

test("the guard can actually see an offending import", () => {
  // A check that silently matches nothing would pass for ever while the invariant rotted. This
  // proves the pattern fires on the exact line that broke the 0.3.4 release.
  const brokenLine = 'import crypto from "node:crypto";';
  assert.match(brokenLine, /["']node:[a-z_/]+["']/);
  assert.ok(sourceFiles().length > 10, "the file list is not empty or accidentally filtered away");
});
