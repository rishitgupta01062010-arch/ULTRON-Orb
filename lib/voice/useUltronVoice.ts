"use client";

/**
 * useUltronVoice — always-listening voice engine for ULTRON.
 *
 * ONE persistent SpeechRecognition session models the whole system as a
 * simple state machine, all transitions handled in onresult (recognition
 * is never stopped/restarted — it just keeps running):
 *
 *   LOCKED     → only the wake word "ultron" opens the lock
 *   UNLOCKED   → wake word + question in one breath works
 *                ("Ultron, what is a black hole?")
 *   COOLDOWN   → after ULTRON answers, ~0.8s of his tail is ignored
 *                (mic hears ULTRON's own voice — echo guard), then AUTO-LISTEN
 *   QUESTION   → anything from the user is a question; "stop" / "continue"
 *                are extracted as commands
 *   PAUSED     → only "continue" / "go on" / "resume" resumes playback
 *                (unless resumeOnInterrupt skips the rest)
 *
 * Chrome's continuous recognition survives the entire session; onend only
 * fires on network failure etc. and restarts automatically while armed.
 *
 * No API keys — pure Web Speech API.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  useVoiceTuning,
  gateRms,
  minQuestionLength,
  requiredConfidence,
} from "@/lib/voice/voiceTuning";
import { NoiseGate } from "@/lib/voice/NoiseGate";

export const WAKE_WORD = "ultron";

export type VoiceState =
  | "unsupported"
  | "idle" // not armed (mic released)
  | "locked-gate" // armed + locked: only the wake word matters
  | "listening" // armed, mic open
  | "cooldown" // ignoring our own voice tail after an answer
  | "processing" // question handed to the agent
  | "paused"; // playback paused, waiting for "continue"

// Minimal Web Speech typings
interface SpeechRecognitionAlternativeLike {
  transcript: string;
  confidence?: number;
}
interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: { length: number; [index: number]: SpeechRecognitionResultLike };
}
interface SpeechRecognitionErrorEventLike {
  error: string;
}
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface UltronVoiceOptions {
  /** Fired when "ultron" is heard while locked. */
  onWake: () => void;
  /** Fired with a user question (wake-word stripped, commands removed). */
  onQuestion: (text: string) => void;
  /** Fired on "stop" (or option words when pauseSkips=true). */
  onStop: () => void;
  /** Fired on "continue". */
  onContinue: () => void;
  /** When true, "stop" words during normal speech PAUSE rather than skip. */
  pauseOnStopWord?: boolean;
  /** When true, "stop" while paused SKIPS the rest instead of no-op. */
  resumeOnInterrupt?: boolean;
  /**
   * Continuous conversation: when true (default), plain questions are accepted
   * after the first wake. When false, every question must start with the
   * wake word ("Ultron, what is …").
   */
  continuous?: boolean;
}

export function useUltronVoice(opts: UltronVoiceOptions) {
  const [state, setState] = useState<VoiceState>("idle");
  const [heard, setHeard] = useState("");
  const [interim, setInterim] = useState("");
  const [lastAction, setLastAction] = useState<string>("");

  // Voice tuning (wake sensitivity + noise gate) — live-updated from settings
  const [tuning] = useVoiceTuning();
  const tuningRef = useRef(tuning);
  tuningRef.current = tuning;

  // Noise gate — dropped frames keep fan/music noise from producing fake speech
  const gateRef = useRef<NoiseGate | null>(null);

  const optsRef = useRef(opts);
  optsRef.current = opts;

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const armedRef = useRef(false);
  const voiceStateRef = useRef<VoiceState>("idle");
  const setVoiceState = (s: VoiceState) => {
    voiceStateRef.current = s;
    setState(s);
  };

  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastActionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setAction = (label: string) => {
    setLastAction(label);
    if (lastActionTimerRef.current) clearTimeout(lastActionTimerRef.current);
    lastActionTimerRef.current = setTimeout(() => setLastAction(""), 2000);
  };

  const clearResumeTimer = () => {
    if (resumeTimerRef.current) {
      clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = null;
    }
  };

  /** True when the mic would hear ULTRON's own TTS (echo loop). */
  const ttsBusyRef = useRef(false);
  const setTtsBusy = (busy: boolean) => {
    ttsBusyRef.current = busy;
  };

  // ─── Command word matching ─────────────────────────────────────────────────
  const STOP_RE =
    /\b(stop|wait|hold on|pause|shut up|be quiet|quiet|silence|that's enough|thats enough|enough)\b/i;
  const CONTINUE_RE =
    /\b(continue|go on|go ahead|resume|carry on|keep going|keep talking)\b/i;
  const WAKE_RE = /\bultron\b/i;

  function classify(
    text: string,
  ): { type: "stop" | "continue" | "wake" | "question"; payload: string } {
    if (CONTINUE_RE.test(text)) return { type: "continue", payload: text };
    if (STOP_RE.test(text)) return { type: "stop", payload: text };
    if (WAKE_RE.test(text)) return { type: "wake", payload: text };
    return { type: "question", payload: text };
  }

  // ─── The result pipeline — all state transitions live here ─────────────────
  const handleResults = useCallback((e: SpeechRecognitionEventLike) => {
    let interimText = "";
    let finalText = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0]?.transcript ?? "";
      else interimText += r[0]?.transcript ?? "";
    }

    if (interimText) setInterim(interimText);

    const live = (finalText || interimText).trim();
    if (!live) return;

    // Noise gate: below the energy floor the mic hears nothing worth parsing
    // (processing/paused still pass so "stop"/"continue" always land)
    const gateBusy =
      voiceStateRef.current === "processing" || voiceStateRef.current === "paused";
    if (!gateBusy && gateRef.current && !gateRef.current.isOpen()) {
      return;
    }

    setHeard(live);

    // ── PAUSED state: only "continue" (or skip) matters ──
    if (voiceStateRef.current === "paused") {
      if (CONTINUE_RE.test(live)) {
        setAction('CONTINUE — resuming');
        setVoiceState("cooldown");
        setInterim("");
        setTimeout(() => {
          if (voiceStateRef.current === "cooldown") setVoiceState("listening");
        }, 400);
        optsRef.current.onContinue();
      } else if (
        optsRef.current.resumeOnInterrupt &&
        STOP_RE.test(live)
      ) {
        setAction("SKIP — moving on");
        setVoiceState("cooldown");
        setInterim("");
        optsRef.current.onStop();
      }
      // any other speech while paused is ignored
      return;
    }

    // ── GLOBAL COMMANDS (work in listening/cooldown/processing) ──
    // "stop" only means something while ULTRON is actually speaking or
    // processing — otherwise idle chatter containing "stop" would wedge
    // the engine in paused state.
    const agentActive =
      ttsBusyRef.current ||
      voiceStateRef.current === "processing" ||
      voiceStateRef.current === "cooldown";
    if (STOP_RE.test(live) && agentActive) {
      setAction('STOP — paused');
      setVoiceState("paused");
      setInterim("");
      optsRef.current.onStop();
      return;
    }
    if (CONTINUE_RE.test(live) && voiceStateRef.current !== "cooldown") {
      // "continue" with nothing to continue — treat as no-op but acknowledge
      setAction("NOTHING TO CONTINUE");
      return;
    }

    // ── LOCKED: only the wake word opens the lock ──
    if (voiceStateRef.current === "locked-gate") {
      if (WAKE_RE.test(live)) {
        setAction('WAKE WORD ACCEPTED');
        setInterim("");
        optsRef.current.onWake();
      }
      // everything else ignored — wrong words never unlock
      return;
    }

    // ── ECHO GUARD: after ULTRON answers, ignore mic input for a beat ──
    if (voiceStateRef.current === "cooldown") return;

    // ── UNLOCKED: wake-word-gated questions ──
    if (voiceStateRef.current === "listening") {
      // Wake word heard — unlock confirmation runs, just note it
      if (WAKE_RE.test(live) && ttsBusyRef.current) return;

      if (WAKE_RE.test(live)) {
        // "Ultron" alone → acknowledge wake; "Ultron, <question>" → both
        const afterWake = live.replace(WAKE_RE, "").replace(/^[\s,.:—-]+/, "");
        if (afterWake.length > 2) {
          setAction("QUESTION ACCEPTED");
          setVoiceState("processing");
          setInterim("");
          optsRef.current.onQuestion(afterWake);
        } else {
          setAction("LISTENING — ASK AWAY");
        }
        return;
      }

      // ── Plain question (no wake word) — only in continuous mode ──
      if (ttsBusyRef.current) return; // ULTRON is speaking — don't self-hear
      const tuning = tuningRef.current;
      const enoughLength = live.length >= minQuestionLength(tuning.wakeSensitivity);
      const confidentEnough =
        typeof r0Confidence(finalText, e) === "number"
          ? (r0Confidence(finalText, e) as number) >= requiredConfidence(tuning.wakeSensitivity)
          : true;
      if (
        finalText &&
        enoughLength &&
        confidentEnough &&
        optsRef.current.continuous !== false
      ) {
        setAction("QUESTION ACCEPTED");
        setVoiceState("processing");
        setInterim("");
        optsRef.current.onQuestion(live);
      }
    }
  }, []);

  /** Confidence of the first final result in the batch (undefined if absent). */
  function r0Confidence(
    finalText: string,
    e: SpeechRecognitionEventLike,
  ): number | undefined {
    if (!finalText) return undefined;
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) return e.results[i][0]?.confidence ?? undefined;
    }
    return undefined;
  }

  // ─── Recognition lifecycle ──────────────────────────────────────────────────
  const startRecognition = useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setVoiceState("unsupported");
      return;
    }
    if (recognitionRef.current) return;

    const rec = new Ctor();
    recognitionRef.current = rec;
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";

    rec.onresult = handleResults;

    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        armedRef.current = false;
        setVoiceState("idle");
        setAction("MIC BLOCKED — allow mic in the address bar");
      } else if (e.error !== "no-speech" && e.error !== "aborted") {
        setAction(`MIC: ${e.error}`);
      }
      // no-speech / aborted are routine — onend restart handles them
    };

    rec.onend = () => {
      recognitionRef.current = null;
      // Network blips end the session; restart while armed.
      if (armedRef.current) {
        setTimeout(() => {
          if (armedRef.current && !recognitionRef.current) {
            try {
              startRecognition();
            } catch {
              /* browser still busy — next onend retries */
            }
          }
        }, 400);
      } else {
        setVoiceState("idle");
      }
    };

    try {
      rec.start();
      setVoiceState(voiceStateRef.current === "paused" ? "paused" : "listening");
      // Noise gate rides the same mic — fails open if the tap is refused
      if (!gateRef.current) {
        gateRef.current = new NoiseGate();
        gateRef.current.setThreshold(gateRms(tuningRef.current.noiseGate));
        void gateRef.current.start();
      }
    } catch {
      recognitionRef.current = null;
      setAction("COULD NOT START MIC");
    }
  }, [handleResults]);

  // ─── Arm / disarm ───────────────────────────────────────────────────────────
  const arm = useCallback(() => {
    armedRef.current = true;
    if (voiceStateRef.current === "unsupported") return;
    startRecognition();
  }, [startRecognition]);

  const disarm = useCallback(() => {
    armedRef.current = false;
    clearResumeTimer();
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    setVoiceState("idle");
    try {
      rec?.abort();
    } catch {
      /* already stopped */
    }
    gateRef.current?.stop();
    gateRef.current = null;
  }, []);

  /** Wake word accepted while locked → open the question gate. */
  const noteUnlocked = useCallback(() => {
    if (voiceStateRef.current === "locked-gate") {
      setVoiceState("listening");
    }
  }, []);

  /** Call when ULTRON starts speaking — echo guard on. */
  const noteSpeaking = useCallback(() => {
    setTtsBusy(true);
    if (voiceStateRef.current === "listening" || voiceStateRef.current === "processing") {
      setVoiceState("cooldown");
    }
  }, []);

  /** Call when ULTRON's answer finishes → brief tail-guard, then AUTO-LISTEN. */
  const noteSpeakingDone = useCallback(() => {
    setTtsBusy(false);
    if (voiceStateRef.current === "cooldown") {
      setAction("LISTENING FOR YOUR NEXT QUESTION…");
      clearResumeTimer();
      resumeTimerRef.current = setTimeout(() => {
        if (voiceStateRef.current === "cooldown") {
          setVoiceState("listening");
        }
      }, 800);
    }
  }, []);

  /** Apply a tuning change to the running gate without restarting it. */
  const applyGateThreshold = useCallback(() => {
    gateRef.current?.setThreshold(gateRms(tuningRef.current.noiseGate));
  }, []);

  /** Imperative gate info for the settings meter (polled, no re-renders). */
  const getGateInfo = useCallback((): { open: boolean; level: number } => {
    if (!gateRef.current) return { open: true, level: 0 };
    return { open: gateRef.current.isOpen(), level: gateRef.current.getLevel() };
  }, []);

  /** Lock pressed → gate the mic back to wake-word-only. */
  const noteLocked = useCallback(() => {
    if (voiceStateRef.current !== "idle" && voiceStateRef.current !== "unsupported") {
      setVoiceState("locked-gate");
    }
  }, []);

  /** Call on boot (system starts locked) → gate the mic to wake-word-only. */
  const enterLockedGate = useCallback(() => {
    if (voiceStateRef.current === "listening" || voiceStateRef.current === "idle") {
      setVoiceState("locked-gate");
    }
  }, []);

  useEffect(() => {
    return () => {
      armedRef.current = false;
      clearResumeTimer();
      try {
        recognitionRef.current?.abort();
      } catch {
        /* noop */
      }
    };
  }, []);

  // Keep the live gate threshold in sync when the slider moves
  useEffect(() => {
    applyGateThreshold();
  }, [tuning.noiseGate, applyGateThreshold]);

  return {
    state,
    heard,
    interim,
    lastAction,
    tuning,
    getGateInfo,
    arm,
    disarm,
    enterLockedGate,
    noteUnlocked,
    noteSpeaking,
    noteSpeakingDone,
    noteLocked,
    setVoiceState,
  };
}
