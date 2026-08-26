import * as esbuild from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import parseArgs from "minimist";
import { copyToAppPlugin, copyStaticPlugin, commonConfig } from "./build.helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

// The extension directory name inside the app. "extensions" for Mendix 11; "webextensions" for 10.
// This extension targets 11.x only, so "extensions" is not conditional.
const extensionDirectoryName = "extensions";

// Where to deploy after each build. An env var keeps the path out of source control and lets
// several test apps share one checkout.
//   PowerShell:  $env:MX_APP_DIR = "C:\Mendix\SomeApp"
const appDir = (process.env.MX_APP_DIR ?? path.resolve(here, "..", "testapp")).replaceAll("\\", "/");

const outDir = "dist/find-that-mf";

// These `out` names MUST match the entry point names in src/manifest.json. Studio Pro looks the
// UI entry points up by name (UISpec.uiEntrypoint), so a mismatch fails silently at open time.
const entryPoints = [
    { in: "src/main/index.ts", out: "main" },
    { in: "src/ui/pane.tsx", out: "pane" }
];

// esbuild does not clean its outdir, and `splitting: true` names chunks by content hash, so every
// change to shared code leaves an orphaned chunk-*.js behind. They are inert but they accumulate
// and get deployed. Cleaning once at startup is enough; --watch rebuilds reuse the same hashes.
await fs.rm(outDir, { recursive: true, force: true });

const args = parseArgs(process.argv.slice(2));
const buildContext = await esbuild.context({
    ...commonConfig,
    outdir: outDir,
    plugins: [
        copyStaticPlugin(outDir, ["manifest.json"]),
        copyToAppPlugin(appDir, outDir, extensionDirectoryName)
    ],
    entryPoints
});

if ("watch" in args) {
    console.log(`Watching. Deploying to ${appDir}/${extensionDirectoryName}`);
    await buildContext.watch();
} else {
    await buildContext.rebuild();
    await buildContext.dispose();
}
