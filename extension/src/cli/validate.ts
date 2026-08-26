/**
 * Runs the scanner and the index over a real app, headlessly.
 *
 * `mx dump-mpr` emits the same `$Type`/`$ID` metamodel that `studioPro.app.model` serves, so the
 * whole analysis can be pointed at a genuine `.mpr` with no Studio Pro and no clicking. That makes
 * it usable as a CI gate, and — more usefully during development — as a way to see what the graph
 * says about a large real app before trusting the pane.
 *
 * Usage:
 *   npm run build:cli
 *   node dist/cli/validate.js <path-to-mpr> [--mx "C:\\Program Files\\Mendix\\11.12.0\\modeler\\mx.exe"]
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GraphIndex } from "../graph/index.js";
import { collectReferences, kindOf } from "../graph/scan.js";
import { SCANNED_UNIT_TYPES, type GraphNode, type ScannedUnitType } from "../graph/types.js";

const DEFAULT_MX = "C:\\Program Files\\Mendix\\11.12.0\\modeler\\mx.exe";

interface Dump {
    units: Record<string, unknown>[];
}

function main(): number {
    const args = process.argv.slice(2);
    const mprPath = args.find(arg => !arg.startsWith("--"));
    if (mprPath === undefined) {
        console.error("Usage: node dist/cli/validate.js <path-to-mpr> [--mx <path-to-mx.exe>]");
        return 2;
    }

    const mxIndex = args.indexOf("--mx");
    const mxPath = mxIndex >= 0 ? (args[mxIndex + 1] ?? DEFAULT_MX) : DEFAULT_MX;

    if (!fs.existsSync(mprPath)) {
        console.error(`No such project: ${mprPath}`);
        return 2;
    }
    if (!fs.existsSync(mxPath)) {
        console.error(`No mx.exe at ${mxPath}. Pass --mx to point somewhere else.`);
        return 2;
    }

    // dump-mpr writes the whole model to stdout, which is tens of megabytes on a real app -- well
    // past the default pipe buffer, hence the explicit maxBuffer.
    const raw = execFileSync(mxPath, ["dump-mpr", path.resolve(mprPath)], {
        encoding: "utf8",
        maxBuffer: 512 * 1024 * 1024
    });

    const dump = JSON.parse(raw) as Dump;
    const index = buildIndex(dump);
    report(index);
    return audit(dump, index);
}

/**
 * Completeness audit: brute-force every reported orphan's qualified name against the raw model.
 *
 * The scanner recognises references by property *name*, so it is exactly as complete as that
 * allowlist. This catches the case the allowlist misses - a property that holds a microflow name
 * without saying so, like `Mappings$ValueMappingElement.converter`. If a document the scanner
 * called unused turns out to be named somewhere in the model, that is a bug in the allowlist, not
 * a dead microflow, and it must not be reported as one.
 *
 * @returns 1 when suspected misses were found, so this can gate CI.
 */
function audit(dump: Dump, index: GraphIndex): number {
    const orphans = index.orphanReport(true).orphans.map(summary => summary.node.qualifiedName);
    if (orphans.length === 0) return 0;

    const wanted = new Set(orphans);
    const misses = new Map<string, Set<string>>();

    for (const unit of dump.units) {
        const owner = typeof unit["$QualifiedName"] === "string" ? unit["$QualifiedName"] : "";
        const seen = new WeakSet<object>();

        const walk = (value: unknown, path: string): void => {
            if (value === null || typeof value !== "object" || seen.has(value)) return;
            seen.add(value);

            if (Array.isArray(value)) {
                for (const item of value) walk(item, path + "[]");
                return;
            }

            for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
                // A document naming itself is not a reference to itself.
                if (key === "$QualifiedName" || key === "$Type" || key === "$ID") continue;
                const next = path === "" ? key : path + "." + key;

                if (typeof child === "string") {
                    if (wanted.has(child) && child !== owner) {
                        const where = misses.get(child) ?? new Set<string>();
                        where.add(next);
                        misses.set(child, where);
                    }
                    continue;
                }
                walk(child, next);
            }
        };

        walk(unit, "");
    }

    if (misses.size === 0) {
        console.log("Completeness audit: no suspected misses. Every orphan really is unreferenced.");
        return 0;
    }

    console.log("Completeness audit: SUSPECTED MISSES");
    console.log("  These were reported as unused but their names appear in the model, which means");
    console.log("  the reference-property allowlist in src/graph/scan.ts does not cover the site.");
    for (const [name, paths] of misses) {
        console.log("  " + name);
        for (const path of paths) console.log("      at ." + path);
    }
    return 1;
}

function buildIndex(dump: Dump): GraphIndex {
    const scanned = new Set<string>(SCANNED_UNIT_TYPES as readonly string[]);
    const nodes: GraphNode[] = [];
    const bodies = new Map<string, Record<string, unknown>>();

    for (const unit of dump.units) {
        const type = unit["$Type"];
        if (typeof type !== "string" || !scanned.has(type)) continue;

        // dump-mpr carries `$QualifiedName` directly; the web API derives the same value by
        // joining UnitInfo's moduleName and name.
        const qualified = unit["$QualifiedName"];
        const name = unit["name"];
        const qualifiedName =
            typeof qualified === "string" && qualified !== ""
                ? qualified
                : typeof name === "string" && name !== ""
                  ? name
                  : null;
        if (qualifiedName === null) continue;

        const moduleName = qualifiedName.includes(".") ? qualifiedName.split(".")[0]! : "";
        if (moduleName === "System") continue;

        nodes.push({
            qualifiedName,
            id: String(unit["$ID"]),
            name: qualifiedName.split(".").pop() ?? qualifiedName,
            module: moduleName,
            type: type as ScannedUnitType,
            kind: kindOf(type),
            scanned: false
        });
        bodies.set(qualifiedName, unit);
    }

    const index = new GraphIndex();
    index.setNodes(nodes);

    for (const [qualifiedName, unit] of bodies) {
        const markAsUsed = unit["markAsUsed"];
        const documentation = unit["documentation"];
        index.applyUnitScan(
            qualifiedName,
            collectReferences(unit, qualifiedName, candidate => index.has(candidate)),
            typeof markAsUsed === "boolean" ? markAsUsed : undefined,
            typeof documentation === "string" && documentation.trim() !== ""
                ? documentation.trim()
                : undefined
        );
    }

    return index;
}

function report(index: GraphIndex): void {
    const line = "-".repeat(72);
    console.log(`${index.nodeCount} documents, ${index.edgeCount} references`);

    console.log(`\n${line}\nReferences by referencing document kind`);
    const byKind = new Map<string, number>();
    for (const node of index.allNodes()) {
        const out = index.calleesOf(node.qualifiedName).length;
        if (out > 0) byKind.set(node.kind, (byKind.get(node.kind) ?? 0) + out);
    }
    for (const [kind, count] of [...byKind].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${kind.padEnd(18)}${count}`);
    }

    console.log(`\n${line}\nReferences by property path`);
    const byPath = new Map<string, number>();
    for (const node of index.allNodes()) {
        for (const edge of index.calleesOf(node.qualifiedName)) {
            // Collapse array indices so `objects[3]` and `objects[7]` count as one shape.
            const shape = edge.path.replace(/\[\d+\]/g, "[]");
            byPath.set(shape, (byPath.get(shape) ?? 0) + 1);
        }
    }
    for (const [shape, count] of [...byPath].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(count).padStart(4)}  ${shape}`);
    }

    console.log(`\n${line}\nModules`);
    for (const moduleEntry of index.moduleSummaries()) {
        console.log(
            `  ${moduleEntry.name.padEnd(26)}${String(moduleEntry.nodeCount).padStart(4)} docs` +
                `${moduleEntry.orphanCount > 0 ? `, ${moduleEntry.orphanCount} unused` : ""}`
        );
    }

    const report = index.orphanReport(true);
    console.log(
        `\n${line}\nUnused: ${report.orphans.length} uncalled, ` +
            `${report.markedAsUsed.length} uncalled but marked as used`
    );
    for (const summary of report.orphans) {
        console.log(`  [unused] ${summary.node.qualifiedName}`);
    }
    for (const summary of report.markedAsUsed) {
        console.log(`  [marked] ${summary.node.qualifiedName}`);
    }

    console.log(`${line}${os.EOL}`);
}

process.exit(main());
