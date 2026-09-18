"use client";

/**
 * NoiseGate — real-time mic energy monitor.
 *
 * Computes RMS level from a lightweight audio tap (fftSize 256, ~10 checks/sec —
 * negligible CPU) and reports an open/closed gate against a configurable
 * threshold. The voice engine drops recognition results while the gate is
 * closed, so fan noise / music / room rumble never produce false wakes.
 *
 * Fail-open by design: if the extra mic tap can't be created (device busy,
 * permission quirks), the gate reports open forever — ULTRON keeps working,
 * just unfiltered.
 *
 * Also exposes `level` for the settings panel's live mic meter.
 */

const FFT_SIZE = 256;
const LOOP_MS = 100;

export class NoiseGate {
  private audioCtx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private timeData: Float32Array<ArrayBuffer> | null = null;
  private timer: number | null = null;

  private open = true; // fail-open
  private rms = 0;
  private threshold = 0.02;

  /** Called on every sample tick with (gateOpen, rmsLevel0to1). */
  constructor(private onChange?: (open: boolean, level: number) => void) {}

  setThreshold(rms: number): void {
    this.threshold = Math.max(0.001, Math.min(0.5, rms));
  }

  async start(): Promise<void> {
    if (this.audioCtx) return;
    try {
      // Reuse whatever the system already negotiated — constraints kept minimal
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const AC =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.audioCtx = new AC();
      const source = this.audioCtx.createMediaStreamSource(this.stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = FFT_SIZE;
      source.connect(this.analyser);
      this.timeData = new Float32Array(
        new ArrayBuffer(this.analyser.fftSize * 4),
      ) as Float32Array<ArrayBuffer>;
      this.timer = window.setInterval(() => this.tick(), LOOP_MS);
    } catch {
      // Fail-open — cleanup whatever half-started
      this.stop();
      this.open = true;
    }
  }

  private tick(): void {
    if (!this.analyser || !this.timeData) return;
    this.analyser.getFloatTimeDomainData(this.timeData);
    let sum = 0;
    for (let i = 0; i < this.timeData.length; i++) {
      sum += this.timeData[i] * this.timeData[i];
    }
    this.rms = Math.sqrt(sum / this.timeData.length);
    const nowOpen = this.rms >= this.threshold;
    if (nowOpen !== this.open) {
      this.open = nowOpen;
    }
    this.onChange?.(this.open, this.rms);
  }

  isOpen(): boolean {
    return this.open;
  }

  /** Current RMS mic level 0–1 — for the live meter. */
  getLevel(): number {
    return this.rms;
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.analyser = null;
    this.timeData = null;
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => undefined);
      this.audioCtx = null;
    }
  }
}
