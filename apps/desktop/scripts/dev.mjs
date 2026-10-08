import esbuild from "esbuild";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const entry = path.join(root, "src", "renderer", "app", "main.tsx");
const outdir = path.join(root, "dist", "renderer");

const copyBrandingAssets = () => {
  const sourceDir = path.join(root, "src", "renderer", "assets", "branding");
  const targetDir = path.join(outdir, "assets", "branding");
  fs.mkdirSync(targetDir, { recursive: true });
  for (const file of ["correct.mp3", "error.mp3", "logo.png"]) {
    const source = path.join(sourceDir, file);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(targetDir, file));
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
  },
  plugins: [{
    name: "copy-branding-assets",
    setup(build) {
      build.onEnd(() => copyBrandingAssets());
    },
  }],
});

await context.watch();
console.log("Renderer watch active. Ctrl+R reloads the latest renderer build.");

const electronCommand = process.platform === "win32"
  ? path.resolve(root, "..", "..", "node_modules", ".bin", "electron.cmd")
  : "electron";
const electron = spawn(electronCommand, ["."], { stdio: "inherit", shell: true });

const shutdown = async () => {
  if (!electron.killed) electron.kill();
  await context.dispose();
};

process.on("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
electron.on("exit", (code, signal) => {
  void context.dispose().finally(() => process.exit(code ?? (signal ? 1 : 0)));
});
