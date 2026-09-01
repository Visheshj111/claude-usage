import { resolveOrgId } from "./org-id";
import { TRACK } from "./state";
import { findDOMExportMessages, isUserMessage, extractDOMText, extractTitle } from "./message-scanner";
import { showExportDialog } from "../shared/export-dialog";

async function fetchConversationFromAPI(
  conversationId: string,
  orgId: string
): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(
      `https://claude.ai/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=True&rendering_mode=messages&render_all_tools=true`,
      { credentials: "include", headers: { "Content-Type": "application/json" } }
    );
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function extractAPIMessageText(msg: Record<string, unknown>): string {
  const parts: string[] = [];
  const content = msg.content;
  if (!Array.isArray(content)) return "";

  for (const block of content) {
    if (typeof block !== "object" || !block) continue;
    const b = block as Record<string, unknown>;

    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else if (b.type === "tool_use" && typeof b.name === "string") {
      parts.push(`[Tool: ${b.name}]`);
      if (b.input && typeof b.input === "object") {
        parts.push("```json\n" + JSON.stringify(b.input, null, 2) + "\n```");
      }
    } else if (b.type === "tool_result" && b.content) {
      const toolContent = Array.isArray(b.content) ? b.content : [b.content];
      for (const tc of toolContent) {
        if (typeof tc === "object" && tc !== null && (tc as Record<string, unknown>).type === "tool_use") {
          parts.push(extractAPIMessageText(tc as Record<string, unknown>));
        } else if (typeof tc === "string") {
          parts.push(tc);
        } else if (typeof tc === "object" && tc !== null && typeof (tc as Record<string, unknown>).text === "string") {
          parts.push((tc as Record<string, unknown>).text as string);
        }
      }
    }
  }

  return parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

export async function exportChat(
  percentage: number = 100,
  format: 'md' | 'txt' | 'json' = 'md'
): Promise<{ success: boolean; content?: string; title?: string; error?: string }> {
  const url = location.href;
  if (!url.includes("claude.ai") || !url.includes("/chat/")) {
    return { success: false, error: "Not on a chat page" };
  }

  const conversationId = url.match(/\/chat\/([a-f0-9-]+)/)?.[1];
  const orgId = await resolveOrgId();

  if (conversationId && orgId) {
    const data = await fetchConversationFromAPI(conversationId, orgId);
    if (data && Array.isArray(data.chat_messages) && data.chat_messages.length > 0) {
      const title = (typeof data.name === "string" && data.name) ||
        TRACK.conversationTitle || extractTitle() || "Claude Chat";
      const timestamp = new Date().toISOString().slice(0, 10);

      const chatMessages = data.chat_messages as Record<string, unknown>[];
      const startIndex = Math.max(0, Math.floor(chatMessages.length * (1 - percentage / 100)));
      const messagesToExport = chatMessages.slice(startIndex);

      const extracted = messagesToExport.map(msg => ({
        sender: msg.sender === "human" ? "User" : "Claude",
        text: extractAPIMessageText(msg)
      })).filter(m => m.text);

      const content = formatMessages(title, timestamp, extracted, format);
      return { success: true, content, title };
    }
  }

  const title = TRACK.conversationTitle || extractTitle() || "Claude Chat";
  const timestamp = new Date().toISOString().slice(0, 10);

  const domMessages = findDOMExportMessages();
  if (domMessages.length === 0) {
    return { success: false, error: "No messages found" };
  }

  const startIndex = Math.max(0, Math.floor(domMessages.length * (1 - percentage / 100)));
  const messagesToExport = domMessages.slice(startIndex);

  const extracted = messagesToExport.map(el => ({
    sender: isUserMessage(el) ? "User" : "Claude",
    text: extractDOMText(el) || ""
  })).filter(m => m.text);

  const content = formatMessages(title, timestamp, extracted, format);
  return { success: true, content, title };
}

function formatMessages(title: string, timestamp: string, messages: { sender: string; text: string }[], format: 'md' | 'txt' | 'json'): string {
  if (format === 'json') {
    return JSON.stringify({ title, timestamp, messages }, null, 2);
  }
  
  const lines: string[] = [];
  if (format === 'md') {
    lines.push(`# ${title}`, `*Exported on ${timestamp}*`, "");
  } else {
    lines.push(`Title: ${title}`, `Exported on: ${timestamp}`, "");
  }

  for (const msg of messages) {
    if (format === 'md') {
      lines.push(`**${msg.sender}**: ${msg.text}`, "");
    } else {
      lines.push(`${msg.sender}: ${msg.text}`, "");
    }
  }
  
  return lines.join("\n");
}

export async function handleWidgetExport(): Promise<void> {
  const container = document.getElementById("cut-container") || document.body;
  const isDark = container.classList.contains("cut-dark") || document.documentElement.classList.contains("dark");
  
  const result = await showExportDialog(container, isDark);
  if (!result) return; // User cancelled

  exportChat(result.percentage, result.format).then((exportResult) => {
    if (!exportResult.success || !exportResult.content) {
      if (exportResult.error) alert(`Export failed: ${exportResult.error}`);
      return;
    }
    downloadFile(exportResult.content, exportResult.title ?? "claude-chat", result.format);
  });
}

function downloadFile(content: string, name: string, ext: string): void {
  const blob = new Blob([content], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name.replace(/[^a-zA-Z0-9\- ]/g, "").trim()}.${ext}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
