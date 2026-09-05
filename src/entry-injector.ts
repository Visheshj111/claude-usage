/**
 * Injector — runs at `document_start` in the isolated world.
 * Injects a <script src="chrome-extension://.../watcher.js"> into the
 * page's MAIN world to wrap window.fetch before any API calls happen.
 *
 * Uses a src-based script rather than inline text to comply with
 * claude.ai's Content Security Policy (which blocks inline scripts).
 * The watcher.js file is listed in web_accessible_resources so the
 * extension can load it into the page.
 *
 * The injected script:
 *   1. Wraps window.fetch
 *   2. Reads SSE response bodies for Claude quota fields
 *      (message_limit, usage_metadata)
 *   3. Dispatches CustomEvent('cut-quota') on window
 *
 * The main content script (entry-content.ts, document_idle)
 * listens for these events and pipes them into handleNetworkQuota.
 */

function injectWatcher(): void {
  // Disabled: using Manifest V3 world: "MAIN" instead to ensure we run before Claude caches fetch.
}

injectWatcher();
