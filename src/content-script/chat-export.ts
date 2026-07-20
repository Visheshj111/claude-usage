import { resolveOrgId } from "./org-id";
import { TRACK } from "./state";
import { findDOMExportMessages, isUserMessage, extractDOMText, extractTitle } from "./message-scanner";

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

export async function exportChat(): Promise<{ success: boolean; markdown?: string; title?: string; error?: string }> {
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
      const lines: string[] = [`# ${title}`, `*Exported on ${timestamp}*`, ""];

      const chatMessages = data.chat_messages as Record<string, unknown>[];
      for (const msg of chatMessages) {
        const sender = msg.sender === "human" ? "User" : "Claude";
        const text = extractAPIMessageText(msg);
        if (!text) continue;
        lines.push(`**${sender}**: ${text}`, "");
      }

      return { success: true, markdown: lines.join("\n"), title };
    }
  }

  const title = TRACK.conversationTitle || extractTitle() || "Claude Chat";
  const timestamp = new Date().toISOString().slice(0, 10);
  const lines: string[] = [`# ${title}`, `*Exported on ${timestamp}*`, ""];

  const domMessages = findDOMExportMessages();
  if (domMessages.length === 0) {
    return { success: false, error: "No messages found" };
  }

  for (const el of domMessages) {
    const role = isUserMessage(el) ? "User" : "Claude";
    const text = extractDOMText(el);
    if (!text) continue;
    lines.push(`**${role}**: ${text}`, "");
  }

  return { success: true, markdown: lines.join("\n"), title };
}

export function handleWidgetExport(): void {
  exportChat().then((result) => {
    if (!result.success || !result.markdown) {
      return;
    }
    downloadFile(result.markdown, result.title ?? "claude-chat", "md");
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
