"use client";

/**
 * ChatPanel — minimal conversation interface for the ULTRON agent.
 *
 * Shows the conversation history, a state line (thinking/speaking), the
 * live-growing streaming bubble, and an input box. Enter sends; nothing
 * else. Lazy-rendered only when the chat is open so it costs nothing
 * while hidden.
 */

import { useEffect, useRef, useState } from "react";
import type { ChatTurn } from "@/lib/agent/useUltronAgent";

interface ChatPanelProps {
  history: ChatTurn[];
  streamingText: string | null; // live-growing assistant reply (null when idle)
  state: "idle" | "thinking" | "speaking" | "paused";
  error: string | null;
  onSend: (text: string) => void;
  onClear: () => void;
  onClose: () => void;
}

export default function ChatPanel({
  history,
  streamingText,
  state,
  error,
  onSend,
  onClear,
  onClose,
}: ChatPanelProps) {
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to newest message
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [history, streamingText, state]);

  const busy = state !== "idle";

  function submit() {
    const text = draft.trim();
    if (!text || busy) return;
    onSend(text);
    setDraft("");
  }

  const stateLine =
    state === "thinking"
      ? "PROCESSING…"
      : state === "speaking"
        ? "SPEAKING…"
        : state === "paused"
          ? "PAUSED — SAY “CONTINUE”"
          : history.length === 0
            ? "AWAITING INPUT"
            : "STANDBY";

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <span className="chat-title">U.L.T.R.O.N. // CONSOLE</span>
        <div className="chat-header-actions">
          <button type="button" className="chat-icon-btn" onClick={onClear} title="Clear conversation">
            ⌫
          </button>
          <button type="button" className="chat-icon-btn" onClick={onClose} title="Close console">
            ✕
          </button>
        </div>
      </div>

      <div className="chat-state" data-state={state}>
        <span className="chat-state-dot" />
        {stateLine}
      </div>

      <div className="chat-messages" ref={listRef}>
        {history.length === 0 && !streamingText && !error && (
          <div className="chat-empty">
            <div className="chat-empty-title">SPEAK, OR TYPE BELOW</div>
            <div className="chat-empty-sub">Gemini · Groq · OpenRouter — automatic failover</div>
          </div>
        )}

        {history.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`}>
            <span className="chat-msg-label">
              {m.role === "user" ? "YOU" : "ULTRON"}
            </span>
            <span className="chat-msg-text">{m.content}</span>
          </div>
        ))}

        {streamingText !== null && (
          <div className="chat-msg assistant streaming">
            <span className="chat-msg-label">ULTRON</span>
            <span className="chat-msg-text">
              {streamingText}
              <span className="chat-cursor">▌</span>
            </span>
          </div>
        )}

        {error && (
          <div className="chat-msg system error">
            <span className="chat-msg-label">SYSTEM</span>
            <span className="chat-msg-text">{error}</span>
          </div>
        )}
      </div>

      <div className="chat-input-row">
        <input
          className="chat-input"
          value={draft}
          placeholder={busy ? "One moment…" : "Type a command, sir…"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          disabled={busy}
          autoFocus
        />
        <button
          type="button"
          className="chat-send"
          onClick={submit}
          disabled={busy || !draft.trim()}
        >
          {state === "thinking" ? "…" : "SEND"}
        </button>
      </div>
    </div>
  );
}
