/**
 * The wire protocol between the three entry points.
 *
 * `main.js`, `pane.js` and `graph.js` are separate ES modules loaded independently by Studio Pro,
 * so they are separate module instances with no shared memory. `ui.messagePassing` is the only
 * channel between them, and it has two sharp edges this module exists to blunt:
 *
 *   1. `sendMessage` is a *broadcast* — every other entry point's handler sees it — and the
 *      `onResponse` callback fires for whichever entry point calls `sendResponse` **first**
 *      (index.d.ts:3040-3071). If two entry points answered, the winner would be a race. So:
 *      only `main` ever answers, and every message carries a `kind` so the others can ignore it.
 *   2. A handler "will react only to messages that are sent after the handler is registered".
 *      A pane that opens before `main` finishes constructing would broadcast into the void and
 *      wait forever, so `request()` retries.
 */

import type {
    AppGraph,
    EgoGraph,
    IndexStatus,
    ModuleSummary,
    NodeSummary,
    ViewState
} from "./types.js";

/** Messages a UI entry point sends to `main` and expects an answer to. */
export type Request =
    | { readonly kind: "mf:status" }
    | { readonly kind: "mf:search"; readonly query: string; readonly limit: number }
    | { readonly kind: "mf:ego"; readonly focus: string }
    | { readonly kind: "mf:app-graph" }
    | { readonly kind: "mf:modules" }
    | { readonly kind: "mf:view" }
    | { readonly kind: "mf:set-view"; readonly patch: Partial<ViewState> }
    | { readonly kind: "mf:node"; readonly qualifiedName: string }
    | { readonly kind: "mf:open"; readonly qualifiedName: string; readonly elementId: string | null }
    | { readonly kind: "mf:rescan" };

/** Maps each request to what `main` sends back, so `request()` can be typed end to end. */
export interface ResponseFor {
    "mf:status": IndexStatus;
    "mf:search": readonly NodeSummary[];
    "mf:ego": EgoGraph | null;
    "mf:app-graph": AppGraph;
    "mf:modules": readonly ModuleSummary[];
    "mf:view": ViewState;
    "mf:set-view": ViewState;
    "mf:node": NodeSummary | null;
    "mf:open": { readonly ok: boolean; readonly error?: string };
    "mf:rescan": IndexStatus;
}

/** Unsolicited messages `main` broadcasts. Nobody responds to these. */
export type Push =
    | { readonly kind: "mf:push-status"; readonly status: IndexStatus }
    /** The active editor changed. A suggestion, not a command: the pane ignores it while pinned. */
    | { readonly kind: "mf:push-focus"; readonly focus: string | null }
    /** The view state changed. The pane redraws the graph and reconciles its controls. */
    | { readonly kind: "mf:push-view"; readonly view: ViewState };

/** Narrows a broadcast to the pushes a UI entry point cares about. */
export function isPush(message: unknown): message is Push {
    return (
        typeof message === "object" &&
        message !== null &&
        "kind" in message &&
        typeof (message as { kind: unknown }).kind === "string" &&
        (message as { kind: string }).kind.startsWith("mf:push-")
    );
}

/** Narrows a broadcast to a request `main` should answer. */
export function isRequest(message: unknown): message is Request {
    return (
        typeof message === "object" &&
        message !== null &&
        "kind" in message &&
        typeof (message as { kind: unknown }).kind === "string" &&
        (message as { kind: string }).kind.startsWith("mf:") &&
        !(message as { kind: string }).kind.startsWith("mf:push-")
    );
}

/** The slice of `studioPro.ui.messagePassing` this module needs. Keeps callers easy to fake in tests. */
export interface MessageChannel {
    sendMessage<TMessage, TResponse>(
        message: TMessage,
        onResponse?: (response: TResponse) => Promise<void>
    ): Promise<void>;
    sendResponse<TResponse>(messageId: string, response: TResponse): Promise<boolean>;
}

/** How long to wait for `main` to answer before assuming the broadcast was sent too early. */
const ATTEMPT_TIMEOUT_MS = 2_000;
/** Ceiling on the retry backoff. */
const MAX_BACKOFF_MS = 4_000;

/**
 * Sends a request and resolves with `main`'s answer, retrying until one arrives.
 *
 * Retrying rather than failing is deliberate: the common cause of no answer is that the pane
 * registered its handler before `main` registered its own, which resolves itself within a second
 * or two. A pane that gave up would show an empty tree for the rest of the session.
 *
 * @param attempts Give up after this many tries and reject, so a genuine bug surfaces as an error
 *                 rather than an infinite spinner.
 */
export async function request<K extends Request["kind"]>(
    channel: MessageChannel,
    message: Extract<Request, { kind: K }>,
    attempts = 6
): Promise<ResponseFor[K]> {
    let backoff = 250;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        const answer = await attemptOnce<ResponseFor[K]>(channel, message);
        if (answer.answered) return answer.value;

        if (attempt < attempts) {
            await delay(backoff);
            backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        }
    }

    throw new Error(
        `No response to ${message.kind} after ${attempts} attempts. ` +
            `The main entry point may have failed to load — check the web view devtools.`
    );
}

async function attemptOnce<TResponse>(
    channel: MessageChannel,
    message: Request
): Promise<{ answered: true; value: TResponse } | { answered: false }> {
    return new Promise(resolve => {
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve({ answered: false });
        }, ATTEMPT_TIMEOUT_MS);

        void channel.sendMessage<Request, TResponse>(message, async response => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ answered: true, value: response });
        });
    });
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
