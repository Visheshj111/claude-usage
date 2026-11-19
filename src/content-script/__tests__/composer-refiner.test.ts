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
      runtime: { id: 'test-extension' },
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

  it('opens Settings through the background from the missing-key dialog', async () => {
    sendRuntimeMessage.mockResolvedValueOnce({ ok: false, error: 'Add an Anthropic API key in Settings.' });
    const module = await import('../composer-refiner');
    destroyComposerRefiner = module.destroyComposerRefiner;
    module.initComposerRefiner();
    await settle();
    document.querySelector<HTMLButtonElement>('#cut-composer-refiner button')!.click();
    await settle();
    sendRuntimeMessage.mockResolvedValueOnce({ success: true });
    document.querySelector<HTMLButtonElement>('#cut-refine-open-settings')!.click();
    await settle();
    expect(sendRuntimeMessage).toHaveBeenLastCalledWith({ type: 'OPEN_SETTINGS' });
    expect(document.querySelector('.ProseMirror')?.textContent).toBe('write a release note');
  });

  it('shows navigation failures without losing the draft', async () => {
    sendRuntimeMessage.mockResolvedValueOnce({ ok: false, error: 'Add an Anthropic API key in Settings.' });
    const module = await import('../composer-refiner');
    destroyComposerRefiner = module.destroyComposerRefiner;
    module.initComposerRefiner();
    await settle();
    document.querySelector<HTMLButtonElement>('#cut-composer-refiner button')!.click();
    await settle();
    sendRuntimeMessage.mockResolvedValueOnce(null);
    document.querySelector<HTMLButtonElement>('#cut-refine-open-settings')!.click();
    await settle();
    expect(document.querySelector('#cut-refine-message')?.textContent).toMatch(/reload/i);
    expect(document.querySelector('.ProseMirror')?.textContent).toBe('write a release note');
  });

  it('traps keyboard focus inside a dialog and restores the refiner on close', async () => {
    const module = await import('../composer-refiner');
    destroyComposerRefiner = module.destroyComposerRefiner;
    module.initComposerRefiner();
    await settle();
    document.querySelector('.ProseMirror')!.textContent = '';
    const trigger = document.querySelector<HTMLButtonElement>('#cut-composer-refiner button')!;
    trigger.click();
    await settle();
    const dismiss = document.querySelector<HTMLButtonElement>('#cut-refine-dismiss')!;
    dismiss.focus();
    dismiss.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(document.querySelector('.cut-refine-close'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.activeElement).toBe(trigger);
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
        method: 'ai',
        provider: 'openrouter',
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
    expect(document.querySelector('#cut-refine-title')?.textContent).toContain('OpenRouter');

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

  it('offers settings for a missing provider key without changing the draft', async () => {
    sendRuntimeMessage.mockResolvedValue({ ok: false, error: 'Add an API key in extension settings to refine prompts.' });
    const module = await import('../composer-refiner');
    destroyComposerRefiner = module.destroyComposerRefiner;
    module.initComposerRefiner();
    await settle();
    document.querySelector<HTMLButtonElement>('#cut-composer-refiner button')!.click();
    await settle();
    expect(document.querySelector('.ProseMirror')?.textContent).toBe('write a release note');
    const settings = document.querySelector<HTMLButtonElement>('#cut-refine-open-settings');
    expect(settings).not.toBeNull();
    sendRuntimeMessage.mockResolvedValueOnce({ success: true });
    settings!.click();
    await settle();
    expect(sendRuntimeMessage).toHaveBeenLastCalledWith({ type: 'OPEN_SETTINGS' });
  });
});
