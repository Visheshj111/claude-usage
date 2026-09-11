import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sendRuntimeMessage } = vi.hoisted(() => ({
  sendRuntimeMessage: vi.fn(),
}));

vi.mock('../org-id', () => ({ sendRuntimeMessage }));

let destroyComposerRefiner: (() => void) | null = null;

async function settle(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

describe('composer prompt refiner', () => {
  beforeEach(() => {
    vi.resetModules();
    sendRuntimeMessage.mockReset();
    document.body.innerHTML = `
      <fieldset>
        <div class="ProseMirror" contenteditable="true">write a release note</div>
      </fieldset>
    `;
    vi.stubGlobal('chrome', {
      storage: {
        local: { get: vi.fn().mockResolvedValue({ settings: { refinerEnabled: true } }) },
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      runtime: { openOptionsPage: vi.fn() },
    });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
  });

  afterEach(() => {
    destroyComposerRefiner?.();
    destroyComposerRefiner = null;
    vi.unstubAllGlobals();
  });

  it('uses an explicit official-refinement request, reviews it, and never changes the draft on failure', async () => {
    sendRuntimeMessage.mockResolvedValueOnce({
      ok: true,
      result: {
        original: 'write a release note',
        refined: 'Write a concise release note. Include the customer impact and release date.',
        originalTokenEstimate: 5,
        refinedTokenEstimate: 18,
        tokenDelta: 13,
        method: 'claude',
        changed: true,
      },
    });

    const module = await import('../composer-refiner');
    destroyComposerRefiner = module.destroyComposerRefiner;
    const { initComposerRefiner } = module;
    initComposerRefiner();
    await settle();

    const composer = document.querySelector<HTMLElement>('.ProseMirror')!;
    const button = document.querySelector<HTMLButtonElement>('#cut-composer-refiner button')!;
    expect(button).toBeTruthy();

    button.click();
    await settle();
    expect(sendRuntimeMessage).toHaveBeenCalledWith({ type: 'REFINE_PROMPT', prompt: 'write a release note' });
    expect(composer.textContent).toBe('write a release note');
    expect(document.querySelector('#cut-refined-text')?.textContent).toContain('customer impact');

    document.querySelector<HTMLButtonElement>('#cut-refine-accept')!.click();
    expect(composer.textContent).toBe('Write a concise release note. Include the customer impact and release date.');
    expect(document.querySelector('#cut-refine-overlay')).toBeNull();

    composer.textContent = 'short draft';
    sendRuntimeMessage.mockResolvedValueOnce({ ok: false, error: 'Anthropic is rate-limiting this key. Try again shortly.' });
    button.click();
    await settle();

    expect(composer.textContent).toBe('short draft');
    expect(document.querySelector('#cut-refine-message')?.textContent).toContain('rate-limiting');
  });
});
