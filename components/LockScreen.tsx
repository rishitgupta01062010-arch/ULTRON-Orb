"use client";

/**
 * LockScreen — hacker-style "SYSTEM LOCKED" overlay.
 *
 * Covers ONLY the middle band of the screen (the blue orb stays visible
 * above and below it). Pure CSS glitch/scanline aesthetics — zero runtime
 * cost beyond a few DOM nodes.
 */

export type MicStatus =
  | "unsupported" // browser has no speech recognition
  | "idle"
  | "listening"
  | "error";

interface LockScreenProps {
  /** True while the wake-word mic is armed and listening. */
  listening: boolean;
  /** Last phrase the recognizer heard (proves other words are ignored). */
  heard: string;
  /** Speech recognition availability / error state. */
  micStatus: MicStatus;
  /** False when the clap detector failed to start (no mic / no Web Audio). */
  clapAvailable: boolean;
  /** Manual unlock for browsers without speech recognition. */
  onManualUnlock: () => void;
  /** Retry the mic after a permission error. */
  onRetryMic: () => void;
}

export default function LockScreen({
  listening,
  heard,
  micStatus,
  clapAvailable,
  onManualUnlock,
  onRetryMic,
}: LockScreenProps) {
  return (
    <div className="lockscreen" role="status" aria-live="polite">
      {/* corner brackets frame the band without covering the orb */}
      <div className="lockscreen__corner lockscreen__corner--tl" />
      <div className="lockscreen__corner lockscreen__corner--tr" />
      <div className="lockscreen__corner lockscreen__corner--bl" />
      <div className="lockscreen__corner lockscreen__corner--br" />

      <div className="lockscreen__glitch" data-text="SYSTEM LOCKED">
        SYSTEM LOCKED
      </div>

      <div className="lockscreen__sub">
        {micStatus === "unsupported" ? (
          <>VOICE UNAVAILABLE — CLAP TWICE OR USE MANUAL OVERRIDE</>
        ) : micStatus === "error" ? (
          <>MICROPHONE BLOCKED — CHECK PERMISSION OR USE OVERRIDE</>
        ) : listening ? (
          <>
            SAY &quot;<span className="lockscreen__wake">ULTRON</span>&quot; OR
            CLAP TWICE TO AUTHENTICATE
          </>
        ) : (
          <>INITIALIZING VOICE AUTH…</>
        )}
      </div>

      {listening && clapAvailable && (
        <div className="lockscreen__clap-hint">👏👏 DOUBLE CLAP ENABLED</div>
      )}

      {listening && (
        <div className="lockscreen__feed">
          {heard ? (
            <>
              <span className="lockscreen__heard-label">HEARD:</span>{" "}
              <span className="lockscreen__heard">{heard.toUpperCase()}</span>
              {heard.trim() !== "" && !heard.toLowerCase().includes("ultron") && (
                <span className="lockscreen__deny"> — ACCESS DENIED</span>
              )}
            </>
          ) : (
            <span className="lockscreen__idle-mic">
              <span className="lockscreen__mic-dot" /> MICROPHONE ACTIVE · AWAITING
              VOICEPRINT
            </span>
          )}
        </div>
      )}

      <div className="lockscreen__actions">
        {micStatus === "error" ? (
          <button type="button" className="lockscreen__btn" onClick={onRetryMic}>
            RETRY MIC
          </button>
        ) : null}
        {micStatus !== "listening" && (
          <button type="button" className="lockscreen__btn" onClick={onManualUnlock}>
            MANUAL OVERRIDE
          </button>
        )}
      </div>
    </div>
  );
}
