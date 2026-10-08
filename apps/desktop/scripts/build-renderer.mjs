import esbuild from "esbuild";
import path from "node:path";
import fs from "node:fs";

const root = process.cwd();
const entry = path.join(root, "src", "renderer", "app", "main.tsx");
const outdir = path.join(root, "dist", "renderer");

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outdir,
  entryNames: "app",
  sourcemap: false,
  minify: false,
  loader: {
    ".ts": "ts",
    ".tsx": "tsx",
    ".css": "css",
    ".woff2": "dataurl",
    ".woff": "dataurl"
  }
});

// The preload runs in Electron's sandbox, where `require` cannot load project files, so it
// is bundled (with the shared IPC channel registry inlined) after tsc has type-checked it.
await esbuild.build({
  entryPoints: [path.join(root, "src", "preload.cts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node22",
  outfile: path.join(root, "dist", "preload.cjs"),
  external: ["electron"],
  sourcemap: false,
  minify: false,
});

// Copy everything under src/renderer/assets (branding sounds and logo, machine artwork) to
// dist, keeping the same folder paths, so the renderer can reference "./assets/<folder>/<file>".
// Copied as a tree rather than file by file: a new asset needs no build-script change.
const assetsSrcDir = path.join(root, "src", "renderer", "assets");
const assetsDstDir = path.join(outdir, "assets");
if (fs.existsSync(assetsSrcDir)) {
  fs.cpSync(assetsSrcDir, assetsDstDir, { recursive: true });
  console.log(`Copied assets to ${path.relative(root, assetsDstDir)}`);
}
