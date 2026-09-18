"use client";

/**
 * ULTRON System Audio — lock/unlock sound effects + unlock voice confirmation.
 *
 * All audio is synthesized with the Web Audio API — no sound files, no API keys.
 * Voice confirmation uses the built-in speechSynthesis voices.
 */

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

/** One enveloped oscillator sweep. */
function sweep(
  ac: AudioContext,
  opts: {
    f0: number;
    f1: number;
    dur: number;
    type: OscillatorType;
    gain: number;
    delay?: number;
  },
) {
  const t0 = ac.currentTime + (opts.delay ?? 0);
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = opts.type;
  osc.frequency.setValueAtTime(opts.f0, t0);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.f1), t0 + opts.dur);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(opts.gain, t0 + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
  osc.connect(g).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + opts.dur + 0.05);
}

/** Rising two-tone "power up" chirp when the system unlocks. */
export function playUnlockSound(): void {
  const ac = getCtx();
  if (!ac) return;
  sweep(ac, { f0: 240, f1: 520, dur: 0.14, type: "sine", gain: 0.22 });
  sweep(ac, { f0: 520, f1: 980, dur: 0.2, type: "sine", gain: 0.2, delay: 0.12 });
  sweep(ac, { f0: 1200, f1: 2400, dur: 0.28, type: "triangle", gain: 0.06, delay: 0.16 });
}

/** Descending "power down" sweep when the system locks. */
export function playLockSound(): void {
  const ac = getCtx();
  if (!ac) return;
  sweep(ac, { f0: 760, f1: 160, dur: 0.32, type: "sawtooth", gain: 0.12 });
  sweep(ac, { f0: 200, f1: 60, dur: 0.22, type: "sine", gain: 0.2, delay: 0.1 });
}

/** Spoken confirmation after unlocking — uses the browser's built-in TTS. */
export function speakUnlockConfirmation(): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(
      "ULTRON online. All systems unlocked.",
    );
    u.rate = 1.02;
    u.pitch = 0.85;
    u.volume = 0.9;
    const voices = window.speechSynthesis.getVoices();
    const en = voices.filter((v) => v.lang.toLowerCase().startsWith("en"));
    if (en.length > 0) {
      // Prefer a deeper/male-ish default voice when one exists
      u.voice =
        en.find((v) => /male|daniel|david|george|alex|guy|james/i.test(v.name)) ??
        en[0];
    }
    window.speechSynthesis.cancel(); // clear any queued speech
    window.speechSynthesis.speak(u);
  } catch {
    // TTS unavailable — the unlock sound still played
  }
}
