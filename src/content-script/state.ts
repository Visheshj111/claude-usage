// ── Per-response token stats (from SSE message_start) ──
export interface MessageStats {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  timestamp: number;
}
export let lastMessageStats: MessageStats | null = null;

export function setLastMessageStats(value: MessageStats | null): void {
  lastMessageStats = value;
}

// ── tracking state ──
export const TRACK = {
  conversationId: null as string | null,
  conversationTitle: "New Chat",
  knownConversations: new Set<string>(),
  lastUrl: location.href,
  isNewConversation: false,
  observer: null as MutationObserver | null,
  urlCheckInterval: null as ReturnType<typeof setInterval> | null,
  scanDebounce: null as ReturnType<typeof setTimeout> | null,
  lastUserChars: 0,
  lastAssistantChars: 0,
  lastUserCount: 0,
  lastAssistantCount: 0,
  sessionStarted: false,
  sessionCheckTimer: null as ReturnType<typeof setInterval> | null,
  uiUpdateInterval: null as ReturnType<typeof setInterval> | null,
};
