"use client";

/**
 * VoiceWaveform — ULTRON's "mouth".
 *
 * A slim canvas bar-waveform rendered UNDER the orb while ULTRON speaks.
 *
 * Sources, in priority order:
 *   1. Fish Audio playback — real Web Audio analyser on the <audio> element
 *   2. Browser speechSynthesis — no analyser API exists, so a synthetic
 *      syllable-rhythm waveform is generated (looks organic, costs ~0)
 *
 * Perf notes (Celeron): one 2D canvas, ~28 bars, 30fps rAF, paused entirely
 * when idle or the tab is hidden.
 */

import { useEffect, useRef } from "react";

interface VoiceWaveformProps {
  /** Agent state — waveform is visible only while speaking. */
  state: "idle" | "thinking" | "speaking" | "paused";
  /** Live audio element (Fish Audio path), or null when using browser TTS. */
  audioElement: React.RefObject<HTMLAudioElement | null>;
}

const BAR_COUNT = 28;
const WIDTH = 260;
const HEIGHT = 46;

export default function VoiceWaveform({ state, audioElement }: VoiceWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const visibleRef = useRef(false);

  // ─── Real analyser (Fish Audio path) ───────────────────────────────────────
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const srcElRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (state !== "speaking" || !audioElement.current) {
      // Tear down the analyser when the element changes/gone
      if (srcElRef.current && srcElRef.current !== audioElement.current) {
        srcElRef.current = null;
        analyserRef.current = null; // old element is discarded by the agent
      }
      return;
    }
    const el = audioElement.current;
    if (srcElRef.current === el && analyserRef.current) return; // already wired

    try {
      if (!ctxRef.current) {
        const AC =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
        if (!AC) return;
        ctxRef.current = new AC();
      }
      const ac = ctxRef.current;
      if (ac.state === "suspended") void ac.resume();
      const source = ac.createMediaElementSource(el);
      const analyser = ac.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.75;
      source.connect(analyser);
      analyser.connect(ac.destination);
      srcElRef.current = el;
      analyserRef.current = analyser;
    } catch {
      // Element already wired to a context or API unavailable → synthetic path
      analyserRef.current = null;
    }
  }, [state, audioElement]);

  // ─── Draw loop ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const g = canvas.getContext("2d");
    if (!g) return;

    const levels = new Float32Array(BAR_COUNT);
    let t = 0;
    let running = true;

    const frame = () => {
      if (!running || document.hidden) return;
      rafRef.current = requestAnimationFrame(frame);
      // ~30fps pacing
      t += 1;
      if (t % 2 !== 0) return;

      const analyser = analyserRef.current;
      let data: Uint8Array | null = null;
      if (analyser) {
        data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(data as Uint8Array<ArrayBuffer>);
      }

      g.clearRect(0, 0, WIDTH, HEIGHT);

      const gap = 3;
      const barW = (WIDTH - gap * (BAR_COUNT - 1)) / BAR_COUNT;

      for (let i = 0; i < BAR_COUNT; i++) {
        let level: number;
        if (data) {
          // Real spectrum — bin 2..58 covers voice band nicely
          const bin = 2 + Math.floor((i / BAR_COUNT) * 56);
          level = (data[bin] ?? 0) / 255;
        } else {
          // Synthetic syllable rhythm: layered sines + per-bar noise
          const x = i / BAR_COUNT;
          const envelope = Math.sin(x * Math.PI); // tapered edges
          const syllable = 0.5 + 0.5 * Math.sin(t * 0.28 + Math.sin(t * 0.11) * 2);
          const jitter =
            0.6 + 0.4 * Math.abs(Math.sin(i * 12.9898 + t * 0.35));
          level = envelope * syllable * jitter;
        }
        // Smooth per-bar
        levels[i] += (level - levels[i]) * 0.35;

        const h = Math.max(2, levels[i] * (HEIGHT - 6));
        const x = i * (barW + gap);
        const y = (HEIGHT - h) / 2;

        const grad = g.createLinearGradient(0, y, 0, y + h);
        grad.addColorStop(0, "rgba(255, 196, 107, 0.95)");
        grad.addColorStop(0.5, "rgba(255, 160, 50, 0.9)");
        grad.addColorStop(1, "rgba(255, 110, 30, 0.85)");
        g.fillStyle = grad;
        g.shadowColor = "rgba(255, 150, 40, 0.7)";
        g.shadowBlur = 6;
        g.beginPath();
        const r = Math.min(barW / 2, 2);
        g.roundRect(x, y, barW, h, r);
        g.fill();
      }
      g.shadowBlur = 0;
    };

    if (state === "speaking") {
      visibleRef.current = true;
      running = true;
      rafRef.current = requestAnimationFrame(frame);
    } else {
      running = false;
      visibleRef.current = false;
      g.clearRect(0, 0, WIDTH, HEIGHT);
      // Draw a dormant single line
      g.fillStyle = "rgba(255, 160, 50, 0.25)";
      g.fillRect(0, HEIGHT / 2 - 1, WIDTH, 2);
    }

    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [state]);

  // Free the audio context on unmount
  useEffect(() => {
    return () => {
      void ctxRef.current?.close().catch(() => undefined);
      ctxRef.current = null;
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      width={WIDTH}
      height={HEIGHT}
      className={`voice-waveform${visibleRef.current ? " active" : ""}`}
      aria-hidden="true"
    />
  );
}
