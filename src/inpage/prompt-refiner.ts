// src/inpage/prompt-refiner.ts

export async function initPromptRefiner() {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings || !settings.refinerEnabled || !settings.anthropicApiKey) {
    return;
  }

  const apiKey = settings.anthropicApiKey;
  let originalPrompt = "";
  let isRefining = false;

  const observer = new MutationObserver(() => {
    // Claude's composer is a contenteditable div with the ProseMirror class
    const composer = document.querySelector('.ProseMirror[contenteditable="true"]');
    if (!composer) return;

    // Claude usually wraps the composer and buttons in a flex container
    const container = composer.closest('fieldset') || composer.parentElement;
    if (!container) return;

    if (document.getElementById('claude-usage-refiner-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'claude-usage-refiner-btn';
    btn.innerHTML = '✨ Refine';
    btn.style.cssText = `
      position: absolute;
      right: 12px;
      top: -36px;
      z-index: 100;
      background: #8e24aa;
      color: white;
      border: none;
      padding: 6px 12px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      transition: all 0.2s ease;
    `;
    
    // Ensure container can position the absolute button
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }
    
    container.appendChild(btn);

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (btn.innerHTML === '↺ Revert') {
        replaceComposerText(composer as HTMLElement, originalPrompt);
        btn.innerHTML = '✨ Refine';
        originalPrompt = "";
        return;
      }

      const text = composer.textContent || '';
      if (!text.trim() || isRefining) return;

      isRefining = true;
      originalPrompt = text;
      btn.innerHTML = '⏳ Refining...';
      btn.style.opacity = '0.7';
      btn.style.cursor = 'wait';

      try {
        const refined = await callAnthropic(apiKey, text);
        if (refined) {
          replaceComposerText(composer as HTMLElement, refined);
          btn.innerHTML = '↺ Revert';
        } else {
          btn.innerHTML = '❌ Error';
          setTimeout(() => {
            btn.innerHTML = '✨ Refine';
          }, 2000);
        }
      } catch (err) {
        console.error("Refiner Error:", err);
        btn.innerHTML = '❌ Error';
        setTimeout(() => {
          btn.innerHTML = '✨ Refine';
        }, 2000);
      } finally {
        isRefining = false;
        btn.style.opacity = '1';
        btn.style.cursor = 'pointer';
      }
    });
  });

  // Observe body for the composer to appear (e.g. after SPA navigation)
  observer.observe(document.body, { childList: true, subtree: true });
}

async function callAnthropic(apiKey: string, text: string): Promise<string | null> {
  const prompt = `Rewrite the following prompt to be more concise and clear, preserving the original intent perfectly. Only return the rewritten text, nothing else. Do not add quotes around the output.\n\nPrompt: ${text}`;
  
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerously-allow-browser': 'true',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!res.ok) {
      console.error("Anthropic API error:", await res.text());
      return null;
    }

    const data = await res.json();
    let result = data.content?.[0]?.text || null;
    if (result) {
      result = result.trim();
    }
    return result;
  } catch (e) {
    console.error(e);
    return null;
  }
}

function replaceComposerText(composer: HTMLElement, newText: string) {
  composer.focus();
  
  // Select all existing text
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(composer);
  selection?.removeAllRanges();
  selection?.addRange(range);
  
  // Insert new text (this triggers ProseMirror's input events so the model knows text changed)
  document.execCommand('insertText', false, newText);
}
