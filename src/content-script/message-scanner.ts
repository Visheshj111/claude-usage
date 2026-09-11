import { sendRuntimeMessage } from './org-id';
import { TRACK } from './state';
import { updateUI } from './ui-widget';
import { runDetection } from '../backend/tracker';
import { SESSION } from '../config';


export const MESSAGE_SELECTORS = [
  '[data-testid="user-message"]',
  '[data-testid="assistant-message"]',
  '[data-message-author-role="user"]',
  '[data-message-author-role="assistant"]',
  '[data-message-id]',
  'article[data-testid^="message"]',
];

export const TITLE_SELECTORS = [
  'h1[data-testid="conversation-title"]',
  '[data-testid="chat-title"]',
  ".conversation-title",
  "h1",
];

const messageElementIds = new WeakMap<Element, string>();
let messageElementIdSeq = 0;

let _tokenDivisor = 4;
export function setTokenEstimationDivisor(divisor: number): void {
  _tokenDivisor = Math.max(1, divisor);
}

export function stableMessageId(el: Element): string {
  const explicitId = el.getAttribute("data-message-id") || el.getAttribute("data-testid");
  if (explicitId) return explicitId;
  const existingId = messageElementIds.get(el);
  if (existingId) return existingId;
  const nextId = `synthetic-${++messageElementIdSeq}`;
  messageElementIds.set(el, nextId);
  return nextId;
}

export function processPage(): void {
  const url = location.href;
  const match = url.match(/\/chat\/([a-f0-9-]+)/);

  if (match && match[1] !== TRACK.conversationId) {
    TRACK.conversationId = match[1];
    TRACK.isNewConversation = !TRACK.knownConversations.has(TRACK.conversationId);
    TRACK.knownConversations.add(TRACK.conversationId);
    TRACK.lastUserChars = 0;
    TRACK.lastAssistantChars = 0;
    TRACK.lastUserCount = 0;
    TRACK.lastAssistantCount = 0;
    TRACK.conversationTitle = extractTitle();
    scanMessages();
  } else if (!match) {
    TRACK.conversationId = null;
  }
}

export function extractTitle(): string {
  for (const sel of TITLE_SELECTORS) {
    const el = document.querySelector(sel);
    if (el && el.textContent?.trim()) return el.textContent.trim();
  }
  const metaTitle = document.querySelector("title");
  if (metaTitle) {
    const t = metaTitle.textContent?.replace(/ - Claude$/, "").trim() ?? "";
    if (t) return t;
  }
  return TRACK.conversationTitle || "New Chat";
}

export function checkUrlChange(): void {
  const current = location.href;
  if (current !== TRACK.lastUrl) {
    TRACK.lastUrl = current;
    onUrlChanged();
  }
}

export function onUrlChanged(): void {
  TRACK.conversationTitle = extractTitle();
  processPage();
  runDetection("navigation");
}

export function ensureSession(): void {
  if (!TRACK.sessionStarted) {
    TRACK.sessionStarted = true;
    sendRuntimeMessage({ type: "UPDATE_SESSION", data: { action: "start" } })
      .then(() => {
        if (TRACK.lastUserCount > 0 || TRACK.lastAssistantCount > 0) {
          scanMessages();
        }
      })
      .catch(() => {});
    startActivityMonitor();
  }
}

function startActivityMonitor(): void {
  let inactiveSince = 0;
  const INACTIVITY_TIMEOUT = SESSION.inactivityTimeoutMs;

  const resetInactivity = () => { inactiveSince = 0; };

  (["mousemove", "keydown", "click", "scroll", "touchstart"] as const).forEach((ev) => {
    window.addEventListener(ev, resetInactivity, { passive: true });
  });

  TRACK.sessionCheckTimer = setInterval(() => {
    const now = Date.now();
    if (inactiveSince === 0) {
      inactiveSince = now;
    } else if (now - inactiveSince > INACTIVITY_TIMEOUT) {
      void sendRuntimeMessage({ type: "UPDATE_SESSION", data: { action: "stop" } });
      TRACK.sessionStarted = false;
      clearInterval(TRACK.sessionCheckTimer!);
    }
  }, 60000);
}

export function scanMessages(): void {
  if (!TRACK.conversationId) return;

  const messages = findMessageElements();
  let userChars = 0, assistantChars = 0, userCount = 0, assistantCount = 0;

  for (const msg of messages) {
    const isUser = isUserMessage(msg);
    const text = extractText(msg);
    const len = text.length;
    if (isUser) { userChars += len; userCount++; }
    else { assistantChars += len; assistantCount++; }
  }

  const du = userChars - TRACK.lastUserChars;
  const da = assistantChars - TRACK.lastAssistantChars;
  const dcu = userCount - TRACK.lastUserCount;
  const dca = assistantCount - TRACK.lastAssistantCount;

  if (du > 0 || da > 0) {
    const data = {
      conversationId: TRACK.conversationId,
      conversationTitle: TRACK.conversationTitle,
      messagesSent: dcu,
      messagesReceived: dca,
      charsSent: du,
      charsReceived: da,
      tokensSent: Math.round(du / _tokenDivisor),
      tokensReceived: Math.round(da / _tokenDivisor),
      isNewConversation: TRACK.isNewConversation,
      convTotalMessagesSent: userCount,
      convTotalMessagesReceived: assistantCount,
      convTotalCharsSent: userChars,
      convTotalCharsReceived: assistantChars,
    };
    void sendRuntimeMessage({ type: "UPDATE_USAGE", data });
    void sendRuntimeMessage({ type: "UPDATE_SESSION", data: { action: "update", ...data } });
    TRACK.isNewConversation = false;
  }

  TRACK.lastUserChars = userChars;
  TRACK.lastAssistantChars = assistantChars;
  TRACK.lastUserCount = userCount;
  TRACK.lastAssistantCount = assistantCount;
}

export function findMessageElements(): Element[] {
  const results: Element[] = [];
  const seen = new Set<string>();
  for (const sel of MESSAGE_SELECTORS) {
    for (const el of document.querySelectorAll(sel)) {
      const id = stableMessageId(el);
      if (!seen.has(id)) { seen.add(id); results.push(el); }
    }
  }
  results.sort((a, b) =>
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1
  );
  return results;
}

export function isUserMessage(el: Element): boolean {
  const testId = el.getAttribute("data-testid") || "";
  const role = el.getAttribute("data-message-author-role") || "";
  return testId.includes("user") || role === "user";
}

export function extractText(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  for (const c of clone.querySelectorAll("code")) c.textContent = " " + c.textContent + " ";
  for (const b of clone.querySelectorAll("button")) b.remove();
  return clone.textContent?.trim() ?? "";
}

export function startObserver(): void {
  if (TRACK.observer) TRACK.observer.disconnect();
  TRACK.observer = new MutationObserver(() => {
    if (TRACK.scanDebounce) clearTimeout(TRACK.scanDebounce);
    TRACK.scanDebounce = setTimeout(() => {
      TRACK.conversationTitle = extractTitle();
      scanMessages();
      updateUI();
    }, 400);
  });
  TRACK.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}

export function findDOMExportMessages(): Element[] {
  const selectors = [
    '[data-message-author-role="user"]',
    '[data-message-author-role="assistant"]',
    '[data-testid="user-message"]',
    '[data-testid="assistant-message"]',
    'article[data-testid^="message"]',
    '[data-message-id]',
    'div[class*="message"]',
  ];
  const results: Element[] = [];
  const seen = new Set<string>();
  for (const sel of selectors) {
    for (const el of document.querySelectorAll(sel)) {
      const id = stableMessageId(el);
      if (!seen.has(id)) { seen.add(id); results.push(el); }
    }
  }
  results.sort((a, b) =>
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1
  );
  return results;
}

export function extractDOMText(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  for (const b of clone.querySelectorAll("button")) b.remove();
  for (const pre of clone.querySelectorAll("pre")) {
    const code = pre.querySelector("code");
    if (code) {
      pre.textContent = "\n```\n" + code.textContent + "\n```\n";
    }
  }
  return clone.textContent?.trim().replace(/\n{3,}/g, "\n\n") ?? "";
}
