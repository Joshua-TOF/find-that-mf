/**
 * Tests for the diagnostics channel.
 *
 * The behaviour worth pinning is the silence: the log lands in the user's app root, next to their
 * `.mpr`, so a working install must leave nothing behind. It is easy to "fix" a debugging problem
 * later by making the writes unconditional again, and these tests are what should object.
 */

import { describe, expect, it } from "vitest";

import { createDiagnostics, type FileWriter } from "../src/graph/diagnostics.js";

/** Records every write instead of touching a disk. */
class FakeFiles implements FileWriter {
    readonly writes: { path: string; content: string }[] = [];

    async putFile(path: string, content: string): Promise<void> {
        this.writes.push({ path, content });
    }

    get last(): string {
        return this.writes[this.writes.length - 1]?.content ?? "";
    }
}

const STARTED_AT = Date.UTC(2026, 0, 2, 3, 4, 5);

describe("createDiagnostics", () => {
    it("writes nothing when a session goes well", async () => {
        const files = new FakeFiles();
        const diagnostics = createDiagnostics(files, STARTED_AT, "main");

        diagnostics.log("loaded");
        diagnostics.log("sweep complete");
        await diagnostics.step("panes.register", async () => "ok");
        await diagnostics.flush();

        expect(files.writes).toEqual([]);
    });

    it("flushes the whole buffer once something fails", async () => {
        const files = new FakeFiles();
        const diagnostics = createDiagnostics(files, STARTED_AT, "main");

        // Everything before the failure is the interesting part of a failure report.
        diagnostics.log("loaded");
        diagnostics.log("sweep complete");
        diagnostics.fail("panes.register", new Error("boom"));
        await diagnostics.flush();

        expect(files.writes).toHaveLength(1);
        expect(files.writes[0]?.path).toBe("find-that-mf.main.log");
        expect(files.last).toContain("loaded");
        expect(files.last).toContain("sweep complete");
        expect(files.last).toContain("FAIL panes.register: boom");
    });

    it("stamps the file with an absolute session start", async () => {
        const files = new FakeFiles();
        const diagnostics = createDiagnostics(files, STARTED_AT, "pane");

        diagnostics.fail("anything", new Error("boom"));
        await diagnostics.flush();

        // Every other stamp is relative, so without this a file left over from an earlier session
        // reads exactly like the current one.
        expect(files.last.split("\n")[0]).toBe("session started 2026-01-02T03:04:05.000Z");
    });

    it("keeps going when a failing step is caught", async () => {
        const files = new FakeFiles();
        const diagnostics = createDiagnostics(files, STARTED_AT, "main");

        const result = await diagnostics.step("doomed", async () => {
            throw new Error("nope");
        });
        await diagnostics.flush();

        // `step` swallows so one failed registration cannot abort the rest of startup...
        expect(result).toBeUndefined();
        // ...but the failure still reaches the log.
        expect(files.last).toContain("FAIL doomed: nope");
    });

    it("survives a writer that throws", async () => {
        const broken: FileWriter = {
            async putFile(): Promise<void> {
                throw new Error("app.files is unavailable");
            }
        };
        const diagnostics = createDiagnostics(broken, STARTED_AT, "main");

        diagnostics.fail("something", new Error("boom"));
        await expect(diagnostics.flush()).resolves.toBeUndefined();
    });

    it("does nothing at all without a writer", async () => {
        const diagnostics = createDiagnostics(undefined, STARTED_AT, "main");

        diagnostics.log("loaded");
        diagnostics.fail("something", new Error("boom"));
        await expect(diagnostics.flush()).resolves.toBeUndefined();
    });
});
