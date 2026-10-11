import esbuild from "esbuild";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const entry = path.join(root, "src", "renderer", "app", "main.tsx");
const outdir = path.join(root, "dist", "renderer");

// Same asset copy as build-renderer.mjs: the whole src/renderer/assets tree, so branding
// sounds, the logo and machine artwork all resolve at "./assets/<folder>/<file>".
const copyAssets = () => {
  const assetsSrcDir = path.join(root, "src", "renderer", "assets");
  if (fs.existsSync(assetsSrcDir)) {
    fs.cpSync(assetsSrcDir, path.join(outdir, "assets"), { recursive: true });
  }
};

// Bundle the sandboxed preload once per dev session (same settings as the production build).
await esbuild.build({
  entryPoints: [path.join(root, "src", "preload.cts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node22",
  outfile: path.join(root, "dist", "preload.cjs"),
  external: ["electron"],
  sourcemap: true,
});

const context = await esbuild.context({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outdir,
  entryNames: "app",
  sourcemap: true,
  minify: false,
  loader: {
    ".ts": "ts",
    ".tsx": "tsx",
    ".css": "css",
    ".woff2": "dataurl",
    ".woff": "dataurl",
  },
  plugins: [{
    name: "copy-assets",
    setup(build) {
      build.onEnd(() => copyAssets());
    },
  }],
});

await context.watch();
console.log("Renderer watch active. Ctrl+R reloads the latest renderer build.");

const electronCommand = process.platform === "win32"
  ? path.resolve(root, "..", "..", "node_modules", ".bin", "electron.cmd")
  : "electron";
// Quoted because shell: true runs the command through cmd.exe, which splits an unquoted
// path on spaces (e.g. a Windows user folder such as "C:\Users\D E L L").
const electron = spawn(`"${electronCommand}"`, ["."], { stdio: "inherit", shell: true });

const shutdown = async () => {
  if (!electron.killed) electron.kill();
  await context.dispose();
};

process.on("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
electron.on("exit", (code, signal) => {
  void context.dispose().finally(() => process.exit(code ?? (signal ? 1 : 0)));
});
