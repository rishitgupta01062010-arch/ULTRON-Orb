"use client";

/**
 * ULTRON Clap Detector — double-clap wake trigger.
 *
 * Pure Web Audio API — no dependencies, no API keys.
 *
 * Detection: a clap is a sharp broadband transient. We watch RMS energy in the
 * 1.2–4 kHz band (where claps punch through normal room noise) via a 2048-point
 * FFT. Onset = band energy jumps above threshold while the noise floor was
 * quiet (rising-edge, so one long noise burst can't fire twice).
 *
 * Wake fires when TWO claps land within a 150–900 ms window.
 * 3s cooldown after firing so post-wake speech/noise can't retrigger.
 */

const FFT_SIZE = 2048;
const BAND_LOW = 1.2e3; // Hz
const BAND_HIGH = 4.0e3; // Hz
const ONSET_THRESHOLD = 2.8; // ratio vs running noise floor
const FLOOR_ALPHA = 0.06; // noise-floor adaptation speed
const MIN_CLAP_GAP_MS = 150;
const MAX_CLAP_GAP_MS = 900;
const COOLDOWN_MS = 3000;
const LOOP_MS = 60; // ~16 checks/sec — light on CPU

export class ClapDetector {
  private audioCtx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private freqData: Float32Array<ArrayBuffer> | null = null;
  private timer: number | null = null;

  private noiseFloor = 0.001;
  private lastClapAt = 0;
  private armed = false; // first clap seen, waiting for the second
  private lastFireAt = 0;
  /** 0–100 user setting → onset ratio multiplier (see setSensitivity). */
  private thresholdMultiplier = 1;

  constructor(private onDoubleClap: () => void) {}

  /**
   * Map the user's clapThreshold setting (0–100) to an onset multiplier.
   *   0   → ×0.6 (trigger on soft claps — too low may catch knocks)
   *   50  → ×1.0 (default)
   *   100 → ×2.2 (only sharp, loud claps)
   */
  setSensitivity(clapThreshold: number): void {
    const t = Math.min(100, Math.max(0, clapThreshold));
    this.thresholdMultiplier = 0.6 + (1 - t / 100) * 1.6;
  }

  async start(): Promise<void> {
    if (this.audioCtx) return;
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AC) throw new Error("Web Audio not supported");

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false, // keep transients sharp
        noiseSuppression: false, // NS eats claps
        autoGainControl: false, // AGC would renormalize the levels we compare
      },
    });

    this.audioCtx = new AC();
    const source = this.audioCtx.createMediaStreamSource(this.stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = FFT_SIZE;
    this.analyser.smoothingTimeConstant = 0; // raw frames, we do our own smoothing
    source.connect(this.analyser);
    this.freqData = new Float32Array(
      new ArrayBuffer(this.analyser.frequencyBinCount * 4),
    ) as Float32Array<ArrayBuffer>;

    this.timer = window.setInterval(() => this.check(), LOOP_MS);
  }

  private check(): void {
    if (!this.analyser || !this.freqData || !this.audioCtx) return;
    this.analyser.getFloatFrequencyData(this.freqData);

    const binHz = this.audioCtx.sampleRate / FFT_SIZE;
    const lo = Math.floor(BAND_LOW / binHz);
    const hi = Math.min(this.freqData.length - 1, Math.ceil(BAND_HIGH / binHz));

    // Mean energy in the clap band (convert dB → linear)
    let sum = 0;
    for (let i = lo; i <= hi; i++) {
      sum += Math.pow(10, this.freqData[i] / 10);
    }
    const energy = sum / (hi - lo + 1);

    const now = performance.now();

    // Cooldown: ignore everything right after a successful wake
    if (now - this.lastFireAt < COOLDOWN_MS) return;

    // Rising-edge onset: above threshold AND enough gap since last clap
    if (
      energy > this.noiseFloor * ONSET_THRESHOLD * this.thresholdMultiplier &&
      energy > 1e-6 &&
      now - this.lastClapAt > MIN_CLAP_GAP_MS
    ) {
      if (this.armed && now - this.lastClapAt <= MAX_CLAP_GAP_MS) {
        // Second clap inside the window → WAKE
        this.armed = false;
        this.lastClapAt = 0;
        this.lastFireAt = now;
        this.onDoubleClap();
        return;
      }
      // First clap — arm and wait for the second
      this.lastClapAt = now;
      this.armed = true;
    }

    // Adapt noise floor when quiet (slow decay, fast attack guard above)
    if (energy < this.noiseFloor) {
      this.noiseFloor =
        this.noiseFloor * (1 - FLOOR_ALPHA) + energy * FLOOR_ALPHA;
    }
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.analyser = null;
    this.freqData = null;
    if (this.audioCtx) {
      void this.audioCtx.close();
      this.audioCtx = null;
    }
    this.armed = false;
  }
}
