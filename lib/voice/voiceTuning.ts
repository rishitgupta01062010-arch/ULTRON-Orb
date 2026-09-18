"use client";

/**
 * Voice tuning settings — persisted in localStorage.
 *
 *   wakeSensitivity  0–100 — how eagerly ULTRON accepts speech as a question.
 *       100 = any short utterance counts, 0 = only long, high-confidence speech.
 *       The wake word "ultron" itself is ALWAYS exact-match regardless.
 *
 *   noiseGate        0–100 — mic energy floor. Background noise (fans, music)
 *       below the gate never reaches recognition, killing false wakes.
 *
 *   clapThreshold    0–100 — double-clap trigger strength. Higher = a harder
 *       clap needed; lower = claps trigger easier but so may table knocks.
 *
 * Default values are tuned for a quiet room on a laptop mic.
 */

import { useEffect, useState } from "react";

const KEY = "ultron.voiceTuning.v1";

export interface VoiceTuning {
  wakeSensitivity: number; // 0–100
  noiseGate: number; // 0–100
  clapThreshold: number; // 0–100
}

export const VOICE_TUNING_DEFAULTS: VoiceTuning = {
  wakeSensitivity: 60,
  noiseGate: 25,
  clapThreshold: 50,
};

export function loadVoiceTuning(): VoiceTuning {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...VOICE_TUNING_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<VoiceTuning>;
    return {
      wakeSensitivity: clampNum(parsed.wakeSensitivity, VOICE_TUNING_DEFAULTS.wakeSensitivity),
      noiseGate: clampNum(parsed.noiseGate, VOICE_TUNING_DEFAULTS.noiseGate),
      clapThreshold: clampNum(parsed.clapThreshold, VOICE_TUNING_DEFAULTS.clapThreshold),
    };
  } catch {
    return { ...VOICE_TUNING_DEFAULTS };
  }
}

export function saveVoiceTuning(t: VoiceTuning): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(t));
  } catch {
    /* private mode — settings just don't persist */
  }
}

function clampNum(v: unknown, fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return Math.min(100, Math.max(0, Math.round(n)));
}

const listeners = new Set<(t: VoiceTuning) => void>();

export function subscribeVoiceTuning(fn: (t: VoiceTuning) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function updateVoiceTuning(patch: Partial<VoiceTuning>): VoiceTuning {
  const next = { ...loadVoiceTuning(), ...patch };
  saveVoiceTuning(next);
  listeners.forEach((fn) => fn(next));
  return next;
}

/** React binding — re-renders on any change (including from other tabs). */
export function useVoiceTuning(): [VoiceTuning, (patch: Partial<VoiceTuning>) => void] {
  const [tuning, setTuning] = useState<VoiceTuning>(VOICE_TUNING_DEFAULTS);

  useEffect(() => {
    setTuning(loadVoiceTuning());
    return subscribeVoiceTuning(setTuning);
  }, []);

  return [tuning, updateVoiceTuning];
}

// ─── Derived engine parameters ─────────────────────────────────────────────────

/** Min length of a final question (chars) before it's accepted. */
export function minQuestionLength(sensitivity: number): number {
  // 100 → 2 chars (very eager), 0 → 24 chars (very strict)
  return Math.round(24 - (sensitivity / 100) * 22);
}

/** Required speech confidence (0–1) for a final question. */
export function requiredConfidence(sensitivity: number): number {
  // Web Speech confidence is often 0 even when correct — the floor stays low,
  // the gate mostly shapes behavior at the extremes.
  return 0.35 + (1 - sensitivity / 100) * 0.45;
}

/** NoiseGate threshold as RMS (0–1 linear mic level). */
export function gateRms(noiseGate: number): number {
  // 0 → 0.002 (almost open), 100 → 0.09 (blocks anything quiet)
  return 0.002 + (noiseGate / 100) * 0.088;
}
