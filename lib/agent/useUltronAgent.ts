"use client";

/**
 * ULTRON Agent hook — client side of the AI pipeline.
 *
 * STREAMING PIPELINE:
 *   text → POST /api/chat (text stream: Gemini→Groq→OpenRouter)
 *        → deltas append to the live reply bubble immediately
 *        → sentence splitter feeds a TTS queue (Fish Audio, browser fallback)
 *        → speaks sentence-by-sentence with prefetch (no dead air)
 *
 * PAUSE / RESUME:
 *   pauseSpeaking()  — barge-in: halts playback AND pauses the LLM stream
 *   resumeSpeaking() — replays the remaining sentences + resumes the stream
 *
 * The hook also exposes the audio element / utterance so the UI can attach
 * a Web Audio analyser for the orb's mouth waveform.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export type AgentState = "idle" | "thinking" | "speaking" | "paused";

const MAX_HISTORY = 16;

/** Split streamed text into speakable sentences (handles abbreviations roughly). */
function splitSentences(buffer: string): { speakable: string[]; rest: string } {
  const speakable: string[] = [];
  const re = /[^.!?]*[.!?]+(?:\s|$)/g;
  let match: RegExpExecArray | null;
  let consumed = 0;
  while ((match = re.exec(buffer)) !== null) {
    const candidate = match[0].trim();
    const isAbbrev = /\b(?:mr|mrs|ms|dr|st|vs|etc|e\.g|i\.e|approx|no\.)$/i.test(
      candidate,
    );
    if (candidate.length >= 3 && !isAbbrev) {
      speakable.push(candidate);
      consumed = re.lastIndex;
    }
  }
  return { speakable, rest: buffer.slice(consumed) };
}

export function useUltronAgent() {
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [state, setState] = useState<AgentState>("idle");
  const [error, setError] = useState<string | null>(null);

  // ─── Shared refs (stable across renders) ───────────────────────────────────
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const ttsQueueRef = useRef<string[]>([]); // pending sentences
  const prefetchRef = useRef<{ text: string; url: string } | null>(null);
  const ttsModeRef = useRef<"fish" | "browser">("fish");
  const pausedRef = useRef(false);
  const streamingRef = useRef(false); // LLM stream in flight?
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const bufferRef = useRef(""); // undelivered sentence tail
  const fullTextRef = useRef(""); // full streamed reply
  const turnActiveRef = useRef(false); // a turn (ask/speakOnce) is in flight
  const queueRunningRef = useRef(false);
  const browserResolveRef = useRef<(() => void) | null>(null);
  const historyAtStartRef = useRef<ChatTurn[]>([]);

  useEffect(() => {
    return () => {
      streamingRef.current = false;
      try {
        void readerRef.current?.cancel();
      } catch {
        /* already closed */
      }
      if (audioRef.current) audioRef.current.pause();
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  // ─── Fish Audio TTS → object URL ────────────────────────────────────────────
  const fetchFishTTS = useCallback(async (text: string): Promise<string | null> => {
    if (ttsModeRef.current === "browser") return null;
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(15_000),
      });        if (!res.ok) {
          ttsModeRef.current = "browser"; // permanent fallback for this session
          return null;
        }
      const blob = await res.blob();
      return URL.createObjectURL(blob);
    } catch {
      ttsModeRef.current = "browser";
      return null;
    }
  }, []);

  /** Browser built-in TTS with external pause/resume control. */
  const speakWithBrowser = useCallback(
    (text: string, onDone?: () => void) => {
      if (typeof window === "undefined" || !("speechSynthesis" in window)) {
        onDone?.();
        return;
      }
      try {
        const u = new SpeechSynthesisUtterance(text.slice(0, 600));
        u.rate = 1.02;
        u.pitch = 0.85;
        const voices = window.speechSynthesis.getVoices();
        const en = voices.filter((v) => v.lang.toLowerCase().startsWith("en"));
        if (en.length > 0) {
          u.voice =
            en.find((v) => /male|daniel|david|george|alex|guy|james/i.test(v.name)) ??
            en[0];
        }
        u.onend = () => onDone?.();
        u.onerror = () => onDone?.();
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(u);
      } catch {
        onDone?.();
      }
    },
    [],
  );

  // ─── TTS queue runner ───────────────────────────────────────────────────────
  const drainQueue = useCallback(async () => {
    if (queueRunningRef.current) return;
    queueRunningRef.current = true;

    try {
      for (;;) {
        while (pausedRef.current) {
          if (!turnActiveRef.current) return;
          await new Promise((r) => setTimeout(r, 120));
        }

        const sentence = ttsQueueRef.current.shift();
        if (sentence === undefined) {
          // Queue empty — keep the runner alive while the LLM stream may
          // still deliver more sentences.
          if (streamingRef.current && !pausedRef.current) {
            await new Promise((r) => setTimeout(r, 150));
            continue;
          }
          return; // stream done + queue empty → exit; finally resets state
        }

        setState("speaking");

        let url = prefetchRef.current?.url ?? null;
        if (url && prefetchRef.current?.text !== sentence) {
          URL.revokeObjectURL(url);
          url = null;
        }
        prefetchRef.current = null;
        if (!url) url = await fetchFishTTS(sentence);

        while (pausedRef.current) {
          if (!turnActiveRef.current) return;
          await new Promise((r) => setTimeout(r, 120));
        }

        if (url) {
          await new Promise<void>((resolve) => {
            const audio = new Audio(url);
            audioRef.current = audio;
            const cleanup = () => {
              URL.revokeObjectURL(url);
              if (audioRef.current === audio) audioRef.current = null;
              if (browserResolveRef.current) {
                browserResolveRef.current();
                browserResolveRef.current = null;
              }
              resolve();
            };
            audio.onended = cleanup;
            audio.onerror = () => {
              // Fish blob failed → browser fallback for this sentence
              audioRef.current = null;
              speakWithBrowser(sentence, () => setTimeout(resolve, 30));
            };
            audio.play().catch(() => {
              audioRef.current = null;
              speakWithBrowser(sentence, () => setTimeout(resolve, 30));
            });
          });
        } else {
          await new Promise<void>((resolve) => {
            browserResolveRef.current = resolve;
            speakWithBrowser(sentence, () => {
              if (browserResolveRef.current === resolve) {
                browserResolveRef.current = null;
              }
              resolve();
            });
          });
        }
      }
    } finally {
      queueRunningRef.current = false;
      if (
        !turnActiveRef.current &&
        ttsQueueRef.current.length === 0 &&
        !pausedRef.current
      ) {
        setState("idle");
      }
    }
  }, [fetchFishTTS, speakWithBrowser]);

  /** Pause playback AND the LLM stream. The turn stays resumable. */
  const pauseSpeaking = useCallback(() => {
    if (!turnActiveRef.current) return;
    pausedRef.current = true;
    if (audioRef.current) {
      audioRef.current.pause(); // resumable — onended won't fire
      audioRef.current = null;
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.pause();
    }
    if (readerRef.current) {
      try {
        void readerRef.current.cancel(); // stop server work; resume refetches
      } catch {
        /* noop */
      }
      readerRef.current = null;
    }
    streamingRef.current = false;
    setState("paused");
  }, []);

  /**
   * Resume after pauseSpeaking(): replay the remaining queue. If the LLM
   * stream was interrupted mid-reply, transparently refetch it with a
   * "continue exactly where you stopped" instruction.
   */
  const resumeSpeaking = useCallback(async () => {
    if (!pausedRef.current) return;
    pausedRef.current = false;

    const remaining = ttsQueueRef.current.length;
    const cut = fullTextRef.current.trim();
    const streamWasCut = streamingRef.current || (cut.length > 0 && remaining === 0);

    if (streamWasCut && cut.length > 0) {
      // Resume the reply from where it stopped
      const resumeMessages: ChatTurn[] = [
        ...historyAtStartRef.current,
        {
          role: "user" as const,
          content: `Resume your previous reply exactly where it stopped. Your reply so far was: "${cut.slice(-300)}". Continue seamlessly with the very next words — do not repeat anything, do not add preamble.`,
        },
      ];
      setState("thinking");
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: resumeMessages }),
        });
        if (!res.ok || !res.body) {
          setState("idle");
          pausedRef.current = false;
          return;
        }
        streamingRef.current = true;
        void pumpStream(res.body);
      } catch {
        setState("idle");
        return;
      }
    }

    setState("speaking");
    void drainQueue();
  }, [drainQueue]);

  /** Permanently stop the current turn (queue + stream + audio). */
  const stopSpeaking = useCallback(() => {
    pausedRef.current = false;
    streamingRef.current = false;
    turnActiveRef.current = false;
    ttsQueueRef.current = [];
    bufferRef.current = "";
    fullTextRef.current = "";
    if (prefetchRef.current) {
      URL.revokeObjectURL(prefetchRef.current.url);
      prefetchRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    try {
      void readerRef.current?.cancel();
    } catch {
      /* noop */
    }
    readerRef.current = null;
    if (browserResolveRef.current) {
      browserResolveRef.current();
      browserResolveRef.current = null;
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    setStreamingText(null);
    setState("idle");
  }, []);

  // ─── Stream pump: reads deltas, feeds sentence queue ───────────────────────
  async function pumpStream(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    readerRef.current = reader;
    const decoder = new TextDecoder();

    try {
      for (;;) {
        if (!streamingRef.current) break; // paused or stopped
        const { done, value } = await reader.read();
        if (done) break;
        const delta = decoder.decode(value, { stream: true });
        fullTextRef.current += delta;
        bufferRef.current += delta;
        setStreamingText(fullTextRef.current);

        const { speakable, rest } = splitSentences(bufferRef.current);
        bufferRef.current = rest;
        for (const s of speakable) {
          ttsQueueRef.current.push(s);
          // Prefetch the first pending sentence while the LLM keeps streaming
          if (
            !prefetchRef.current &&
            ttsQueueRef.current.length > 0
          ) {
            const next = ttsQueueRef.current[0];
            void fetchFishTTS(next).then((url) => {
              if (url && prefetchRef.current === null) {
                prefetchRef.current = { text: next, url };
              } else if (url) {
                URL.revokeObjectURL(url);
              }
            });
          }
        }
        void drainQueue(); // no-op if already running
      }
      // Flush the tail fragment (if it never hit sentence punctuation)
      const tail = bufferRef.current.trim();
      bufferRef.current = "";
      if (tail.length >= 2) {
        ttsQueueRef.current.push(tail);
        void drainQueue();
      }
    } catch {
      // network error mid-stream — partial answer already queued/playing
    } finally {
      streamingRef.current = false;
      if (readerRef.current === reader) readerRef.current = null;
    }
  }

  // ─── Ask: send user text through the agent pipeline ─────────────────────────
  const ask = useCallback(
    async (text: string) => {
      const clean = text.trim();
      if (!clean || turnActiveRef.current) return;
      turnActiveRef.current = true;

      stopSpeaking(); // resets turnActiveRef — re-arm for this new turn
      turnActiveRef.current = true;
      pausedRef.current = false;

      setError(null);
      setState("thinking");

      const nextHistory: ChatTurn[] = [
        ...history,
        { role: "user" as const, content: clean },
      ].slice(-MAX_HISTORY);
      historyAtStartRef.current = nextHistory;
      setHistory(nextHistory);

      fullTextRef.current = "";
      bufferRef.current = "";

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: nextHistory }),
        });

        if (!res.ok || !res.body) {
          let msg = "The request failed.";
          try {
            const data = (await res.json()) as { error?: string };
            if (data?.error) msg = data.error;
          } catch {
            /* not JSON */
          }
          setError(msg);
          setState("idle");
          turnActiveRef.current = false;
          speakOnce("My apologies, sir. The connection to my mind is unstable.");
          return;
        }

        streamingRef.current = true;
        await pumpStream(res.body);
        await drainQueue(); // wait for TTS to fully finish

        // Finalize history with the complete reply
        if (fullTextRef.current.trim().length > 0) {
          setHistory((h) =>
            [...h, { role: "assistant" as const, content: fullTextRef.current }].slice(
              -MAX_HISTORY,
            ),
          );
        } else {
          setError("Provider returned an empty response.");
        }
      } catch {
        setError("Network error — is the server running?");
        setState("idle");
      } finally {
        turnActiveRef.current = false;
        setStreamingText(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [history, drainQueue, fetchFishTTS, stopSpeaking],
  );

  // ─── Fixed line (unlock confirmation etc.) — bypasses streaming ─────────────
  function speakOnce(text: string) {
    stopSpeaking();
    turnActiveRef.current = true;
    pausedRef.current = false;
    fullTextRef.current = "";
    bufferRef.current = "";
    ttsQueueRef.current = [text];
    setState("speaking");
    void drainQueue();
    // One-shot: when queue drains, release the turn
    const release = setInterval(() => {
      if (
        ttsQueueRef.current.length === 0 &&
        !queueRunningRef.current &&
        !pausedRef.current
      ) {
        turnActiveRef.current = false;
        setState("idle");
        clearInterval(release);
      }
    }, 200);
    setTimeout(() => clearInterval(release), 60_000); // safety
  }

  const clear = useCallback(() => {
    stopSpeaking();
    setHistory([]);
    historyAtStartRef.current = [];
    setError(null);
  }, [stopSpeaking]);

  return {
    history,
    streamingText,
    state, // "idle" | "thinking" | "speaking" | "paused"
    error,
    ask,
    clear,
    stopSpeaking,
    pauseSpeaking,
    resumeSpeaking,
    speakOnce,
    /** Current audio element (Fish) or null (browser TTS). For the analyser. */
    audioElement: audioRef,
  };
}

// Re-export for JarvisOrb convenience typing
export type { AgentState as UltronAgentState };
