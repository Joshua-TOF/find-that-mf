/**
 * A log file, because there is no other way to see what an extension did.
 *
 * Studio Pro gives a web extension no console you can read without attaching a WebView2 debugger
 * from VS Code, and its own `log.txt` records only that extensions were loaded, never what they
 * did or what they threw. `app.files.putFile` is the one channel that leaves a readable trace, so
 * that is what this uses.
 *
 * **Nothing is written unless something goes wrong.** Every line is buffered in memory; the first
 * `fail()` of a session opens the tap and flushes the whole buffer, so a failure report still
 * carries the full run-up to it. A clean session leaves no file behind. This matters because the
 * log lands in the user's app root, next to their `.mpr`, and a debugging aid has no business
 * showing up there during ordinary use.
 *
 * Set `VERBOSE` to trace a run that misbehaves without throwing - a wrong answer rather than an
 * error. An opt-in marker file would be tidier than a compile-time constant, but `app.files` will
 * happily `putFile` an arbitrary path at the app root and then neither `getFile` nor `getFiles`
 * can see it again - reads appear to be limited to the subtrees Mendix knows about. With no way to
 * read a marker back, there is nothing to opt in with.
 *
 * One file per entry point, not one shared file: the entry points are separate module instances
 * with separate buffers, so pointing them at the same path means each `putFile` overwrites the
 * other's content and whichever wrote last wins.
 *
 * Deliberately not inside `.mendix-cache`: `putFile` does not create intermediate directories,
 * so a path into a directory that may not exist yet fails silently and no log ever appears.
 */

function logPathFor(label: string): string {
    return `find-that-mf.${label}.log`;
}

/** Batches writes: one `putFile` per line would be a round trip per log call. */
const FLUSH_DELAY_MS = 400;
/** Keeps a long session from growing the file without bound. */
const MAX_LINES = 2_000;
/**
 * Write the log even when nothing failed.
 *
 * Off by default so a working install stays invisible. Flip it to trace a run that goes wrong
 * without throwing, then flip it back - deliberately a source edit rather than a setting, because
 * there is no way to read a setting back (see above).
 */
const VERBOSE = false;

export interface FileWriter {
    putFile(path: string, content: string): Promise<void>;
}

export interface Diagnostics {
    log(message: string): void;
    /** Records a thrown error with its stack, and returns the message for reuse. */
    fail(context: string, error: unknown): string;
    /** Wraps a step so one failed registration cannot abort the rest of startup. */
    step<T>(name: string, action: () => Promise<T>): Promise<T | undefined>;
    flush(): Promise<void>;
}

/**
 * @param startedAt Milliseconds since the epoch, passed in rather than read here so the module has
 *                  no ambient clock dependency and timestamps are relative to a known origin.
 */
export function createDiagnostics(
    files: FileWriter | undefined,
    startedAt: number,
    label: string
): Diagnostics {
    const path = logPathFor(label);
    const lines: string[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let writing = false;
    let dirty = false;
    /** Set by the first `fail()`. Until then nothing reaches disk. */
    let failed = false;

    const stamp = (): string => {
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(3);
        return `+${elapsed.padStart(8)}s`;
    };

    const write = async (): Promise<void> => {
        if (files === undefined || writing) return;
        // Silence on success: buffer only. The lines stay in memory, so if a failure comes later
        // the flush it triggers still includes everything that led up to it.
        if (!failed && !VERBOSE) return;
        writing = true;
        dirty = false;
        try {
            // An absolute timestamp, because every other stamp is relative to session start
            // and a leftover file from an earlier session is otherwise indistinguishable from
            // this one.
            const header = `session started ${new Date(startedAt).toISOString()}`;
            await files.putFile(path, [header, ...lines].join("\n") + "\n");
        } catch {
            // Nothing useful to do: the diagnostics channel failing must never take the extension
            // down with it.
        } finally {
            writing = false;
            if (dirty) schedule();
        }
    };

    const schedule = (): void => {
        if (timer !== undefined) return;
        timer = setTimeout(() => {
            timer = undefined;
            void write();
        }, FLUSH_DELAY_MS);
    };

    const log = (message: string): void => {
        lines.push(`${stamp()} [${label}] ${message}`);
        if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
        dirty = true;
        schedule();
    };

    const fail = (context: string, error: unknown): string => {
        failed = true;
        const message = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error && error.stack !== undefined ? error.stack : "";
        log(`FAIL ${context}: ${message}`);
        // The interesting part of a minified stack is the top few frames; the rest is framework.
        for (const frame of stack.split("\n").slice(1, 6)) log(`       ${frame.trim()}`);
        return message;
    };

    return {
        log,
        fail,
        async step<T>(name: string, action: () => Promise<T>): Promise<T | undefined> {
            log(`-> ${name}`);
            try {
                const result = await action();
                log(`   ok ${name}`);
                return result;
            } catch (error) {
                fail(name, error);
                return undefined;
            }
        },
        flush: write
    };
}
