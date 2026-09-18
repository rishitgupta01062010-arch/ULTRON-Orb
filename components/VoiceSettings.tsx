"use client";

/**
 * VoiceSettings — sliders for wake-word sensitivity, noise gate, clap
 * threshold, plus a live mic level meter showing the gate in action.
 *
 * Persisted via lib/voice/voiceTuning.ts (localStorage) and applied live to
 * the running voice engine — no restart needed.
 */

import { useEffect, useRef, useState } from "react";
import { useVoiceTuning, VOICE_TUNING_DEFAULTS, gateRms } from "@/lib/voice/voiceTuning";

interface VoiceSettingsProps {
  /** Polled imperatively — (gateOpen, rmsLevel). */
  getGateInfo: () => { open: boolean; level: number };
  onClose: () => void;
}

const LOOP_MS = 120;

export default function VoiceSettings({ getGateInfo, onClose }: VoiceSettingsProps) {
  const [tuning, setTuning] = useVoiceTuning();
  const [meter, setMeter] = useState({ open: true, level: 0 });
  const meterRef = useRef<HTMLDivElement>(null);

  // Poll the gate imperatively — no re-render storm, ~8fps meter
  useEffect(() => {
    const timer = window.setInterval(() => {
      const info = getGateInfo();
      setMeter(info);
      if (meterRef.current) {
        meterRef.current.style.width = `${Math.min(100, info.level * 100 * 2.5).toFixed(1)}%`;
      }
    }, LOOP_MS);
    return () => window.clearInterval(timer);
  }, [getGateInfo]);

  const gateRmsNow = gateRms(tuning.noiseGate);

  return (
    <div className="voice-settings" role="dialog" aria-label="Voice settings">
      <div className="voice-settings__head">
        <span>VOICE CALIBRATION</span>
        <button type="button" className="voice-settings__close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      {/* Live mic meter */}
      <div className="voice-settings__meter-wrap">
        <div className="voice-settings__meter-label">
          <span>MIC INPUT</span>
          <span className={meter.open ? "gate-open" : "gate-closed"}>
            GATE {meter.open ? "OPEN" : "CLOSED"}
          </span>
        </div>
        <div className="voice-settings__meter">
          <div ref={meterRef} className="voice-settings__meter-fill" />
          {/* threshold marker */}
          <div
            className="voice-settings__meter-th"
            style={{ left: `${Math.min(96, gateRmsNow * 100 * 2.5)}%` }}
          />
        </div>
        <div className="voice-settings__meter-hint">
          speak — the bar must pass the marker for ULTRON to hear you
        </div>
      </div>

      {/* Wake sensitivity */}
      <label className="voice-settings__row">
        <span className="voice-settings__name">
          WAKE SENSITIVITY
          <em>{tuning.wakeSensitivity}</em>
        </span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={tuning.wakeSensitivity}
          onChange={(e) => setTuning({ wakeSensitivity: Number(e.target.value) })}
        />
        <span className="voice-settings__desc">
          how eagerly short phrases count as questions · &ldquo;ULTRON&rdquo; always works
        </span>
      </label>

      {/* Noise gate */}
      <label className="voice-settings__row">
        <span className="voice-settings__name">
          NOISE GATE
          <em>{tuning.noiseGate}</em>
        </span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={tuning.noiseGate}
          onChange={(e) => setTuning({ noiseGate: Number(e.target.value) })}
        />
        <span className="voice-settings__desc">
          blocks fan/music noise below the floor · raise it if ULTRON hears phantom words
        </span>
      </label>

      {/* Clap threshold */}
      <label className="voice-settings__row">
        <span className="voice-settings__name">
          CLAP THRESHOLD
          <em>{tuning.clapThreshold}</em>
        </span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={tuning.clapThreshold}
          onChange={(e) => setTuning({ clapThreshold: Number(e.target.value) })}
        />
        <span className="voice-settings__desc">
          double-clap strength needed to unlock · raise it if knocks set it off
        </span>
      </label>

      <button
        type="button"
        className="voice-settings__reset"
        onClick={() => setTuning(VOICE_TUNING_DEFAULTS)}
      >
        RESET DEFAULTS
      </button>
    </div>
  );
}
