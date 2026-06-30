/**
 * Shared library-changed signal (non-premium).
 *
 * `LIBRARY_CHANGED_EVENT` is the native (Tauri) event name the desktop shell
 * fires after a dictation save so any open window can refresh its library. It
 * lived in the overlay capture module historically, but the base app only
 * *listens* for it — so it is hoisted here, into a non-premium domain module,
 * to decouple the public base from the overlay subtree (the overlay UI is being
 * extracted to a private surface; the base must not import from it).
 *
 * The value is a bare event-name string — a cross-process contract carried on
 * the shell's event bus. The extracted overlay surface re-declares the SAME
 * literal independently; this is a non-copyrightable fragment shared by
 * contract, NOT a shared import, so it does not link the two sides.
 */

export const LIBRARY_CHANGED_EVENT = "library-changed";
