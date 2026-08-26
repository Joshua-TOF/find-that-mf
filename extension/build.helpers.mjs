// Adapted from the @mendix/create-extension template (MIT).
// Unchanged except where noted, so it stays easy to diff against future generator releases.
import { existsSync as pathExists } from "node:fs";
import fs from "node:fs/promises";

async function ensureExtensionDirectoryExists(appDir, extensionDirectoryName) {
    if (appDir.trim() !== "" && pathExists(appDir)) {
        const extDir = `${appDir}/${extensionDirectoryName}`;

        if (!pathExists(extDir)) {
            await fs.mkdir(extDir);
        }

        return extDir;
    }
}

async function copyExtensionAssetsToApplication(appExtensionDirPath, outDir) {
    const extensionName = outDir.split("/").pop();
    const deployedExtensionPath = `${appExtensionDirPath}/${extensionName}`;

    if (pathExists(deployedExtensionPath)) {
        await fs.rm(deployedExtensionPath, { recursive: true, force: true });
    }

    await fs.mkdir(deployedExtensionPath);
    await fs.cp(outDir, deployedExtensionPath, { recursive: true });
}

export const copyToAppPlugin = (appDir, outDir, extensionDirectoryName) => ({
    name: "copy-to-app",
    setup(build) {
        build.onEnd(async result => {
            if (!result.errors.length) {
                const appExtensionDirPath = await ensureExtensionDirectoryExists(appDir, extensionDirectoryName);

                if (appExtensionDirPath) {
                    // Changed from the template: awaited, so a --watch rebuild cannot race the next build.
                    await copyExtensionAssetsToApplication(appExtensionDirPath, outDir);
                    console.log(`Deployed to ${appExtensionDirPath}`);
                } else {
                    console.error("Could not find Mendix application directory:", appDir);
                    console.info("Skipping copying the extension to application directory");
                }
            }
        });
    }
});

// Added: the generator only copies the manifest. The tab icon has to sit beside the entry-point
// bundles too, because TabInfo.icon resolves relative to the deployed extension directory.
export const copyStaticPlugin = (outDir, files) => ({
    name: "copy-static",
    setup(build) {
        build.onEnd(async result => {
            if (result.errors.length) return;
            for (const name of files) {
                try {
                    await fs.copyFile(`src/${name}`, `${outDir}/${name}`);
                } catch (error) {
                    console.error(`Expected src/${name} to exist`, error);
                }
            }
        });
    }
});

export const commonConfig = {
    // Added: without this React resolves `process.env.NODE_ENV` to undefined and its development
    // build ships into Studio Pro - bigger, slower, and with StrictMode double-invoking every
    // effect, which showed up as the graph fetching and re-laying-out twice for every change.
    define: { "process.env.NODE_ENV": '"production"' },
    target: "es2023",
    platform: "browser",
    format: "esm",
    bundle: true,
    splitting: true,
    treeShaking: true,
    logLevel: "info",
    assetNames: "assets/[ext]/[name]-[hash]",
    external: ["@mendix/component-framework", "@mendix/model-access-sdk"],
    loader: {
        ".png": "file",
        ".svg": "file",
        ".gif": "file",
        ".ttf": "file",
        ".woff": "file",
        ".woff2": "file"
    },
    sourcemap: true
};
