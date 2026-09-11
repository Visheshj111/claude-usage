import { sendRuntimeMessage } from "./org-id";
import type { RefinementResult } from "../refiner";

const CONTROL_ID = "cut-composer-refiner";
const DIALOG_ID = "cut-refine-overlay";

const COMPOSER_SELECTORS = [
  'div.ProseMirror[contenteditable="true"]',
  '[data-testid="user-input"][contenteditable="true"]',
  'div[contenteditable="true"][role="textbox"]',
];

interface RefinementResponse {
  ok: boolean;
  result?: RefinementResult;
  error?: string;
}

interface ActiveRefinement {
  composer: HTMLElement;
  result: RefinementResult;
  replaceConfirmed: boolean;
}

let initialized = false;
let refinerEnabled = true;
let refinementInProgress = false;
let activeRefinement: ActiveRefinement | null = null;
let composerObserver: MutationObserver | null = null;
let ensureQueued = false;
let settingsChangeHandler: ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void) | null = null;
let escapeKeydownHandler: ((event: KeyboardEvent) => void) | null = null;
let colorSchemeQuery: MediaQueryList | null = null;

function isVisible(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

function findComposer(): HTMLElement | null {
  for (const selector of COMPOSER_SELECTORS) {
    const candidates = document.querySelectorAll<HTMLElement>(selector);
    for (const candidate of candidates) {
      if (isVisible(candidate)) return candidate;
    }
  }
  return null;
}

function readComposerText(composer: HTMLElement): string {
  return composer.innerText || composer.textContent || "";
}

function getControlHost(composer: HTMLElement): HTMLElement {
  return composer.closest<HTMLElement>("fieldset")
    ?? composer.closest<HTMLElement>('[data-testid="composer"]')
    ?? composer.parentElement
    ?? composer;
}

function syncTheme(): void {
  const isDark = document.documentElement.classList.contains("dark")
    || window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.getElementById(CONTROL_ID)?.classList.toggle("cut-dark", isDark);
  document.getElementById(DIALOG_ID)?.classList.toggle("cut-dark", isDark);
}

function setControlBusy(busy: boolean): void {
  const button = document.querySelector<HTMLButtonElement>(`#${CONTROL_ID} button`);
  if (!button) return;
  button.disabled = busy;
  button.textContent = busy ? "Refining…" : "✦ Refine";
  button.setAttribute("aria-busy", String(busy));
}

function removeControl(): void {
  const control = document.getElementById(CONTROL_ID);
  const host = control?.parentElement as HTMLElement | null;
  control?.remove();

  if (host?.dataset.cutRefinerPositioned === "true") {
    host.style.position = host.dataset.cutRefinerOriginalPosition ?? "";
    delete host.dataset.cutRefinerPositioned;
    delete host.dataset.cutRefinerOriginalPosition;
  }
}

function hideDialog(): void {
  document.getElementById(DIALOG_ID)?.remove();
  activeRefinement = null;
}

function openSettings(): void {
  try {
    chrome.runtime.openOptionsPage();
  } catch {
    // The extension context may have been invalidated during a hot reload.
  }
}

function createDialog(): HTMLElement {
  document.getElementById(DIALOG_ID)?.remove();

  const overlay = document.createElement("div");
  overlay.id = DIALOG_ID;
  overlay.setAttribute("role", "presentation");
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) hideDialog();
  });
  document.body.appendChild(overlay);
  syncTheme();
  return overlay;
}

function showMessageDialog(title: string, message: string, openSettingsButton = false): void {
  const overlay = createDialog();
  overlay.innerHTML = `
    <section id="cut-refine-card" role="dialog" aria-modal="true" aria-labelledby="cut-refine-title">
      <div class="cut-refine-header">
        <span class="cut-refine-title" id="cut-refine-title"></span>
        <button class="cut-refine-close" type="button" aria-label="Close">×</button>
      </div>
      <div class="cut-refine-message" id="cut-refine-message"></div>
      <div class="cut-refine-footer cut-refine-footer-message">
        <button class="cut-refine-btn-secondary" type="button" id="cut-refine-dismiss">Close</button>
        ${openSettingsButton ? '<button class="cut-refine-btn-primary" type="button" id="cut-refine-open-settings">Open settings</button>' : ""}
      </div>
    </section>
  `;

  const card = overlay.querySelector<HTMLElement>("#cut-refine-card");
  const titleElement = card?.querySelector<HTMLElement>("#cut-refine-title");
  const messageElement = card?.querySelector<HTMLElement>("#cut-refine-message");
  if (titleElement) titleElement.textContent = title;
  if (messageElement) messageElement.textContent = message;
  card?.querySelector(".cut-refine-close")?.addEventListener("click", hideDialog);
  card?.querySelector("#cut-refine-dismiss")?.addEventListener("click", hideDialog);
  card?.querySelector("#cut-refine-open-settings")?.addEventListener("click", openSettings);
  card?.querySelector<HTMLButtonElement>(".cut-refine-close")?.focus();
}

function sizeSummary(result: RefinementResult): string {
  if (result.tokenDelta === 0) return "Similar estimated size";
  const amount = Math.abs(result.tokenDelta);
  return `≈ ${amount} ${amount === 1 ? "token" : "tokens"} ${result.tokenDelta > 0 ? "more" : "fewer"}`;
}

function replaceComposerText(composer: HTMLElement, text: string): void {
  composer.focus();

  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(composer);
  range.collapse(false);
  selection?.removeAllRanges();
  selection?.addRange(range);

  let inserted = false;
  try {
    document.execCommand("selectAll", false);
    inserted = document.execCommand("insertText", false, text);
  } catch {
    inserted = false;
  }

  if (!inserted) {
    const replacementRange = document.createRange();
    replacementRange.selectNodeContents(composer);
    replacementRange.deleteContents();

    const fragment = document.createDocumentFragment();
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      if (index > 0) fragment.appendChild(document.createElement("br"));
      fragment.appendChild(document.createTextNode(line));
    });
    replacementRange.insertNode(fragment);
  }

  composer.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    inputType: "insertText",
    data: text,
  }));
  composer.dispatchEvent(new Event("change", { bubbles: true }));
  composer.focus();
}

function showReviewDialog(composer: HTMLElement, result: RefinementResult): void {
  activeRefinement = { composer, result, replaceConfirmed: false };
  const overlay = createDialog();
  overlay.innerHTML = `
    <section id="cut-refine-card" role="dialog" aria-modal="true" aria-labelledby="cut-refine-title">
      <div class="cut-refine-header">
        <span class="cut-refine-title" id="cut-refine-title">Refined with Claude</span>
        <span class="cut-refine-size" id="cut-refine-size"></span>
        <button class="cut-refine-close" type="button" aria-label="Close">×</button>
      </div>
      <p class="cut-refine-note" id="cut-refine-note"></p>
      <div class="cut-refine-body">
        <div class="cut-refine-col">
          <div class="cut-refine-col-label">Your draft <span class="cut-refine-tokens" id="cut-orig-tokens"></span></div>
          <div class="cut-refine-text" id="cut-orig-text"></div>
        </div>
        <div class="cut-refine-divider"></div>
        <div class="cut-refine-col">
          <div class="cut-refine-col-label">Ready to send <span class="cut-refine-tokens" id="cut-refined-tokens"></span></div>
          <div class="cut-refine-text cut-refine-text-refined" id="cut-refined-text"></div>
        </div>
      </div>
      <div class="cut-refine-footer">
        <button class="cut-refine-btn-secondary" type="button" id="cut-refine-dismiss">Discard</button>
        <div class="cut-refine-footer-right">
          <button class="cut-refine-btn-primary" type="button" id="cut-refine-accept">Replace draft</button>
        </div>
      </div>
      <div class="cut-refine-status" id="cut-refine-status" hidden></div>
    </section>
  `;

  const card = overlay.querySelector<HTMLElement>("#cut-refine-card");
  if (!card) return;
  card.querySelector<HTMLElement>("#cut-refine-size")!.textContent = sizeSummary(result);
  card.querySelector<HTMLElement>("#cut-refine-note")!.textContent = result.changed
    ? "Review the suggested prompt before replacing the draft in Claude."
    : "Claude returned the draft unchanged.";
  card.querySelector<HTMLElement>("#cut-orig-tokens")!.textContent = `≈ ${result.originalTokenEstimate} tokens`;
  card.querySelector<HTMLElement>("#cut-refined-tokens")!.textContent = `≈ ${result.refinedTokenEstimate} tokens`;
  card.querySelector<HTMLElement>("#cut-orig-text")!.textContent = result.original;
  card.querySelector<HTMLElement>("#cut-refined-text")!.textContent = result.refined;

  card.querySelector(".cut-refine-close")?.addEventListener("click", hideDialog);
  card.querySelector("#cut-refine-dismiss")?.addEventListener("click", hideDialog);
  card.querySelector<HTMLButtonElement>("#cut-refine-accept")?.addEventListener("click", () => {
    const current = activeRefinement;
    if (!current) return;

    const status = card.querySelector<HTMLElement>("#cut-refine-status");
    const accept = card.querySelector<HTMLButtonElement>("#cut-refine-accept");
    if (readComposerText(current.composer) !== current.result.original && !current.replaceConfirmed) {
      current.replaceConfirmed = true;
      if (status) {
        status.textContent = "Your draft changed while Claude was refining it. Click “Replace anyway” to overwrite it.";
        status.hidden = false;
      }
      if (accept) accept.textContent = "Replace anyway";
      return;
    }

    replaceComposerText(current.composer, current.result.refined);
    hideDialog();
  });
  card.querySelector<HTMLButtonElement>("#cut-refine-accept")?.focus();
}

async function requestRefinement(): Promise<void> {
  if (refinementInProgress) return;

  const composer = findComposer();
  if (!composer) {
    showMessageDialog("Composer unavailable", "Claude's message box was not found. Wait for it to load and try again.");
    return;
  }

  const draft = readComposerText(composer);
  if (!draft.trim()) {
    showMessageDialog("Write a draft first", "Add the prompt you want Claude to improve, then choose Refine.");
    return;
  }

  refinementInProgress = true;
  setControlBusy(true);

  try {
    const response = await sendRuntimeMessage<RefinementResponse>({ type: "REFINE_PROMPT", prompt: draft });
    if (!response) {
      showMessageDialog("Refinement unavailable", "The extension could not reach its background service. Reload Claude and try again.");
      return;
    }
    if (!response.ok || !response.result) {
      const message = response.error || "Claude could not refine this prompt right now. Try again.";
      showMessageDialog(
        message.startsWith("Add an Anthropic API key") ? "Connect Anthropic" : "Refinement unavailable",
        message,
        message.startsWith("Add an Anthropic API key"),
      );
      return;
    }

    showReviewDialog(composer, response.result);
  } finally {
    refinementInProgress = false;
    setControlBusy(false);
  }
}

function ensureControl(): void {
  if (!refinerEnabled) {
    removeControl();
    return;
  }

  const composer = findComposer();
  if (!composer) return;
  const host = getControlHost(composer);
  const existing = document.getElementById(CONTROL_ID);

  if (existing?.parentElement === host) {
    syncTheme();
    return;
  }
  existing?.remove();

  if (getComputedStyle(host).position === "static") {
    host.dataset.cutRefinerOriginalPosition = host.style.position;
    host.dataset.cutRefinerPositioned = "true";
    host.style.position = "relative";
  }

  const control = document.createElement("div");
  control.id = CONTROL_ID;
  control.setAttribute("role", "toolbar");
  const button = document.createElement("button");
  button.type = "button";
  button.title = "Refine this draft with Claude";
  button.setAttribute("aria-label", "Refine this draft with Claude");
  button.textContent = "✦ Refine";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void requestRefinement();
  });

  control.appendChild(button);
  host.appendChild(control);
  syncTheme();
}

function queueEnsureControl(): void {
  if (ensureQueued) return;
  ensureQueued = true;
  queueMicrotask(() => {
    ensureQueued = false;
    if (!initialized) return;
    ensureControl();
  });
}

function updateRefinerEnabled(settings: { refinerEnabled?: boolean } | undefined): void {
  refinerEnabled = settings?.refinerEnabled !== false;
  if (refinerEnabled) queueEnsureControl();
  else {
    hideDialog();
    removeControl();
  }
}

export function initComposerRefiner(): void {
  if (initialized) return;
  initialized = true;

  chrome.storage.local.get("settings").then(({ settings }) => {
    updateRefinerEnabled(settings as { refinerEnabled?: boolean } | undefined);
  }).catch(() => updateRefinerEnabled(undefined));

  settingsChangeHandler = (changes, areaName) => {
    if (areaName === "local" && changes.settings) {
      updateRefinerEnabled(changes.settings.newValue as { refinerEnabled?: boolean } | undefined);
    }
  };
  chrome.storage.onChanged.addListener(settingsChangeHandler);

  composerObserver = new MutationObserver(queueEnsureControl);
  composerObserver.observe(document.documentElement, { childList: true, subtree: true });

  escapeKeydownHandler = (event) => {
    if (event.key === "Escape" && document.getElementById(DIALOG_ID)) {
      event.preventDefault();
      hideDialog();
    }
  };
  document.addEventListener("keydown", escapeKeydownHandler);
  colorSchemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
  colorSchemeQuery.addEventListener("change", syncTheme);
  queueEnsureControl();
}

/** Used when the content-script context is torn down and by DOM-level tests. */
export function destroyComposerRefiner(): void {
  initialized = false;
  refinerEnabled = true;
  refinementInProgress = false;
  ensureQueued = false;

  composerObserver?.disconnect();
  composerObserver = null;
  if (settingsChangeHandler) {
    chrome.storage.onChanged.removeListener(settingsChangeHandler);
    settingsChangeHandler = null;
  }
  if (escapeKeydownHandler) {
    document.removeEventListener("keydown", escapeKeydownHandler);
    escapeKeydownHandler = null;
  }
  colorSchemeQuery?.removeEventListener("change", syncTheme);
  colorSchemeQuery = null;

  hideDialog();
  removeControl();
}
