// Putting a string on the clipboard from a page that is very often not on a
// secure origin.
//
// `copyText` is the decision and is unit-tested. `clipboardPorts` and
// `legacyClipboardWrite` are wiring — they read `navigator` and build a DOM
// node, neither of which a test in this repo can reach — so they are kept to
// the minimum that reading them end to end is enough.

/** What the caller must do next: nothing, or reveal the manual field. */
export type CopyOutcome = "copied" | "manual";

export interface CopyPorts {
  /**
   * `navigator.clipboard.writeText`, or null where the browser did not expose
   * one. Null is the common case here, not the exotic one: the async clipboard
   * exists only in a secure context — https, localhost or 127.0.0.1 — and this
   * dashboard is normally reached at http://192.168.x.x over a LAN.
   */
  writeAsync: ((text: string) => Promise<void>) | null;
  /** The `document.execCommand("copy")` route. Returns whether it took. */
  writeLegacy: (text: string) => boolean;
}

/**
 * Copy `text`, by whichever route this browser allows.
 *
 * **Returns synchronously when there is no async clipboard, and that is the
 * whole point of the signature.** `document.execCommand("copy")` is only
 * permitted inside the task the user's click started; a single `await` before
 * it returns control to the event loop and Safari refuses. So the insecure
 * origin path — the one that matters, since it is why this function exists —
 * must reach `writeLegacy` with no microtask in between, and cannot be an
 * `async function`. Callers hand the union to `Promise.resolve`.
 *
 * The async route is still tried first where it exists: it is the supported
 * API, it does not need a throwaway element, and it works when the legacy one
 * has been disabled. When it rejects — which a secure origin still does if the
 * document is not focused — the legacy route gets its turn anyway.
 */
export function copyText(text: string, ports: CopyPorts): CopyOutcome | Promise<CopyOutcome> {
  const legacy = (): CopyOutcome => (ports.writeLegacy(text) ? "copied" : "manual");
  if (ports.writeAsync === null) return legacy();
  try {
    return ports.writeAsync(text).then(
      (): CopyOutcome => "copied",
      // Past the await the gesture is gone, so this attempt may well be
      // refused as well. It costs nothing to make, and a refusal lands on the
      // manual field, which is where a browser this strict was heading anyway.
      legacy,
    );
  } catch {
    // Some hardened browsers throw from writeText rather than rejecting.
    return legacy();
  }
}

export function copyNotice(outcome: CopyOutcome): string {
  return outcome === "copied"
    ? "Stream URL copied."
    : "This browser won't let the page copy — the URL is in the field, already selected.";
}

/** The ports as this browser actually provides them. */
export function clipboardPorts(): CopyPorts {
  const clip: Clipboard | undefined = navigator.clipboard;
  return {
    writeAsync: clip ? (text) => clip.writeText(text) : null,
    writeLegacy: legacyClipboardWrite,
  };
}

/**
 * The pre-`navigator.clipboard` copy: select a throwaway textarea, then ask the
 * document to copy the selection. Deprecated, unfailingly available, and the
 * only thing that works on an insecure origin.
 *
 * The styling is load-bearing. `display:none` and `visibility:hidden` both make
 * the selection silently empty, so the element has to be genuinely on screen —
 * `position:fixed` with zero opacity keeps it out of sight and out of the
 * layout's way. `setSelectionRange` is there for iOS, which ignores `select()`
 * on a readonly field by itself.
 */
export function legacyClipboardWrite(text: string): boolean {
  const field = document.createElement("textarea");
  // A property assignment, not markup — `value` is never parsed as HTML.
  field.value = text;
  field.setAttribute("readonly", "");
  field.setAttribute("aria-hidden", "true");
  field.style.position = "fixed";
  field.style.top = "0";
  field.style.left = "0";
  field.style.opacity = "0";
  document.body.append(field);
  let copied = false;
  try {
    field.select();
    field.setSelectionRange(0, text.length);
    // Deprecated, and staying: the replacement does not exist on the origins
    // this branch is here for.
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  field.remove();
  return copied;
}
