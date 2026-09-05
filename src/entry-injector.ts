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
  console.error('[CUT] INJECTOR: Attempting to inject watcher.js');
  try {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('dist/watcher.js');
    script.id = 'cut-watcher';
    script.onload = () => {
      console.error('[CUT] INJECTOR: watcher.js onload fired!');
      script.remove();
    };
    script.onerror = (e) => {
      console.error('[CUT] INJECTOR: watcher.js failed to load!', e);
    };
    document.documentElement.appendChild(script);
    console.error('[CUT] INJECTOR: appended script tag to documentElement');
  } catch(e) {
    console.error('[CUT] INJECTOR: synchronous inject failed', e);
    document.addEventListener('DOMContentLoaded', () => {
      try {
        const s = document.createElement('script');
        s.src = chrome.runtime.getURL('dist/watcher.js');
        s.id = 'cut-watcher';
        s.onload = () => s.remove();
        document.documentElement.appendChild(s);
        console.error('[CUT] INJECTOR: appended script tag to documentElement on DOMContentLoaded');
      } catch(e) {
        console.error('[CUT] INJECTOR: DOMContentLoaded inject failed', e);
      }
    });
  }
}

injectWatcher();
