export interface DayUsage {
  messagesSent: number;
  messagesReceived: number;
  charsSent: number;
  charsReceived: number;
  tokensSent: number;
  tokensReceived: number;
  conversations: number;
}

export interface PeriodUsage extends DayUsage {
  conversationIds: string[];
}

export interface ConversationEntry {
  title: string;
  startedAt: string;
  totalMessages: number;
  messagesSent: number;
  messagesReceived: number;
  charsSent: number;
  charsReceived: number;
  tokensSent: number;
  tokensReceived: number;
}

export interface SessionData {
  startTime: number;
  messagesSent: number;
  messagesReceived: number;
  tokensSent: number;
  tokensReceived: number;
  charsSent: number;
  charsReceived: number;
  conversations: number;
  elapsed?: number;
}

export type HourlyUsage = Record<string, number[]>;
