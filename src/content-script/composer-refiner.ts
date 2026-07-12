import { getInputText, showRefinementOverlay } from "./ui-widget";
import { getTrackedOrgId } from "../backend/network-monitor";
import { refineLocal, refineWithAPI } from "../refiner";

export function initComposerRefiner(): void {
  chrome.storage.local.get('settings').then(({ settings }) => {
    const s = (settings || {}) as { refinerEnabled?: boolean };
    if (!s.refinerEnabled) return;

    let deepInProgress = false;

    function injectComposerButtons(): void {
      if (document.getElementById('cut-composer-refine')) return;

      const composer = document.querySelector<HTMLElement>('.ProseMirror[contenteditable="true"]');
      if (!composer) return;

      const toolbar =
        (composer.closest('fieldset') as HTMLElement | null) ||
        composer.parentElement;
      if (!toolbar) return;

      const wrap = document.createElement('div');
      wrap.id = 'cut-composer-wrap';
      wrap.style.cssText = `
        display: inline-flex;
        gap: 4px;
        align-items: center;
        position: absolute;
        right: 12px;
        top: -40px;
        z-index: 200;
      `;

      if (getComputedStyle(toolbar).position === 'static') {
        toolbar.style.position = 'relative';
      }

      const refBtn = document.createElement('button');
      refBtn.id = 'cut-composer-refine';
      refBtn.title = 'Instant local refinement';
      refBtn.textContent = '✦ Refine';
      refBtn.style.cssText = `
        background: #6d28d9;
        color: #fff;
        border: none;
        padding: 5px 11px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 12px;
        font-weight: 600;
        box-shadow: 0 1px 4px rgba(0,0,0,.18);
        transition: opacity .15s;
        white-space: nowrap;
      `;

      refBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const text = getInputText();
        if (!text || text.length <= 20) return;
        refBtn.textContent = '⏳ Refining…';
        refBtn.style.opacity = '0.6';
        try {
          const result = refineLocal(text);
          showRefinementOverlay(result);
        } finally {
          refBtn.textContent = '✦ Refine';
          refBtn.style.opacity = '1';
        }
      });

      const deepBtn = document.createElement('button');
      deepBtn.id = 'cut-composer-deep';
      deepBtn.title = 'AI rewrite via your Claude session (no API key needed)';
      deepBtn.textContent = '⚡ Deep';
      deepBtn.style.cssText = `
        background: #0e7490;
        color: #fff;
        border: none;
        padding: 5px 11px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 12px;
        font-weight: 600;
        box-shadow: 0 1px 4px rgba(0,0,0,.18);
        transition: opacity .15s;
        white-space: nowrap;
      `;

      deepBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (deepInProgress) return;

        const orgId = getTrackedOrgId();
        if (!orgId) {
          const statusEl = document.getElementById('cut-refine-status') as HTMLElement | null;
          if (statusEl && document.getElementById('cut-refine-overlay')?.style.display !== 'none') {
            statusEl.textContent = 'Org ID not detected yet — try again in a moment.';
            statusEl.style.display = '';
          } else {
            deepBtn.textContent = '⚠ No session';
            setTimeout(() => { deepBtn.textContent = '⚡ Deep'; }, 2000);
          }
          return;
        }

        deepInProgress = true;
        deepBtn.textContent = '⏳ Refining…';
        deepBtn.style.opacity = '0.6';
        deepBtn.style.cursor = 'wait';
        refBtn.disabled = true;

        const text = getInputText();
        try {
          const result = await refineWithAPI(text, orgId);
          showRefinementOverlay(result);
          const statusEl = document.getElementById('cut-refine-status') as HTMLElement | null;
          if (statusEl) statusEl.style.display = 'none';
        } catch (err) {
          console.error('[CUT composer deep refine] failed:', err);
          const errMsg = err instanceof Error ? err.message : String(err);
          deepBtn.textContent = '❌ Failed';
          setTimeout(() => { deepBtn.textContent = '⚡ Deep'; }, 2500);
          try {
            const fallback = refineLocal(text);
            showRefinementOverlay(fallback);
            const statusEl = document.getElementById('cut-refine-status') as HTMLElement | null;
            if (statusEl) {
              statusEl.textContent = `AI refine failed — showing local result instead. (${errMsg})`;
              statusEl.style.display = '';
            }
          } catch { }
        } finally {
          deepBtn.style.opacity = '1';
          deepBtn.style.cursor = 'pointer';
          refBtn.disabled = false;
          deepInProgress = false;
          if (deepBtn.textContent === '⏳ Refining…') deepBtn.textContent = '⚡ Deep';
        }
      });

      wrap.appendChild(refBtn);
      wrap.appendChild(deepBtn);
      toolbar.appendChild(wrap);
    }

    injectComposerButtons();

    const observer = new MutationObserver(() => {
      if (!document.getElementById('cut-composer-refine')) {
        injectComposerButtons();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}
