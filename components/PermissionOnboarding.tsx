"use client";

/**
 * PermissionOnboarding — first-launch mic + camera permission flow.
 *
 * Shows ONCE (localStorage flag "ultron.onboarded.v1"), explains exactly what
 * ULTRON needs and why, then requests both permissions through real browser
 * prompts. Handles every outcome:
 *
 *   granted          → clean, moves on
 *   denied           → per-browser re-enable instructions (Chrome/Edge), retry button
 *   dismissed (ESC)  → system still boots locked; wake word re-prompts naturally
 *
 * Deliberately NOT a fake wizard: the two "Allow" clicks are the browser's own
 * native permission prompts, triggered from a real user gesture.
 */

import { useCallback, useEffect, useState } from "react";

const FLAG = "ultron.onboarded.v1";

export type PermissionOutcome = "granted" | "denied" | "dismissed";

interface PermissionOnboardingProps {
  /** Called after the flow ends (any outcome) so the app can arm the mic. */
  onComplete: (mic: PermissionOutcome, camera: PermissionOutcome) => void;
}

type Step = "welcome" | "mic" | "camera" | "done";

type PermState = "unknown" | "granted" | "denied";

export function isOnboardingNeeded(): boolean {
  try {
    return typeof window !== "undefined" && !localStorage.getItem(FLAG);
  } catch {
    return true; // private mode etc. — show once per load, harmless
  }
}

export function markOnboarded(): void {
  try {
    localStorage.setItem(FLAG, "1");
  } catch {
    /* private mode — fine, it just asks again next launch */
  }
}

async function queryPermission(name: "microphone" | "camera"): Promise<PermState> {
  try {
    const st = await navigator.permissions.query({
      name: name as PermissionName,
    });
    return st.state as PermState;
  } catch {
    return "unknown"; // Firefox lacks Permissions API for these
  }
}

/** Fire a real getUserMedia prompt; resolves to the actual outcome. */
async function requestDevice(kind: "microphone" | "camera"): Promise<PermissionOutcome> {
  try {
    const constraints: MediaStreamConstraints =
      kind === "microphone" ? { audio: true } : { video: { width: 320 } };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    stream.getTracks().forEach((t) => t.stop());
    return "granted";
  } catch (err) {
    if (err instanceof DOMException && err.name === "NotAllowedError") return "denied";
    // NotFoundError etc. — no device attached; treat as dismissible, not fatal
    return "dismissed";
  }
}

export default function PermissionOnboarding({ onComplete }: PermissionOnboardingProps) {
  const [step, setStep] = useState<Step>("welcome");
  const [micState, setMicState] = useState<PermState>("unknown");
  const [camState, setCamState] = useState<PermState>("unknown");
  const [requesting, setRequesting] = useState(false);

  // Pre-check existing permissions so previously-granted browsers skip prompts
  useEffect(() => {
    void (async () => {
      const [m, c] = await Promise.all([
        queryPermission("microphone"),
        queryPermission("camera"),
      ]);
      setMicState(m);
      setCamState(c);
      if (m === "granted" && c === "granted") setStep("camera"); // camera step will fast-path
    })();
  }, []);

  const finish = useCallback(
    (mic: PermissionOutcome, cam: PermissionOutcome) => {
      markOnboarded();
      setStep("done");
      onComplete(mic, cam);
    },
    [onComplete],
  );

  const requestMic = useCallback(async () => {
    if (micState === "granted") {
      setStep("camera");
      return;
    }
    setRequesting(true);
    try {
      const outcome = await requestDevice("microphone");
      setMicState(outcome === "granted" ? "granted" : outcome === "denied" ? "denied" : "unknown");
      if (outcome === "granted" || outcome === "denied") setStep("camera");
      else finish("dismissed", "dismissed");
    } finally {
      setRequesting(false);
    }
  }, [micState, finish]);

  const requestCamera = useCallback(async () => {
    if (camState === "granted") {
      finish("granted", "granted");
      return;
    }
    setRequesting(true);
    try {
      const outcome = await requestDevice("camera");
      if (outcome === "granted") finish("granted", "granted");
      else finish(outcome === "denied" ? "denied" : "dismissed", outcome);
    } finally {
      setRequesting(false);
    }
  }, [camState, finish]);

  const skipAll = useCallback(() => finish("dismissed", "dismissed"), [finish]);

  return (
    <div className="onboarding" role="dialog" aria-modal="true" aria-label="ULTRON setup">
      <div className="onboarding__card">
        <div className="onboarding__glitch" data-text="ULTRON SETUP">
          ULTRON SETUP
        </div>

        {step === "welcome" && (
          <>
            <p className="onboarding__lead">
              Two permissions unlock the full experience. Everything runs locally —
              your audio and video never leave this machine.
            </p>
            <ul className="onboarding__list">
              <li>
                <span className="onboarding__icon">🎙</span>
                <div>
                  <strong>Microphone</strong>
                  <span>wake word &ldquo;ULTRON&rdquo;, double-clap, and voice questions</span>
                </div>
              </li>
              <li>
                <span className="onboarding__icon">📷</span>
                <div>
                  <strong>Camera</strong>
                  <span>pinch-and-move hand gestures to spin and zoom the orb</span>
                </div>
              </li>
            </ul>
            <div className="onboarding__actions">
              <button type="button" className="onboarding__btn onboarding__btn--primary" onClick={() => setStep("mic")}>
                BEGIN AUTHORIZATION
              </button>
              <button type="button" className="onboarding__btn" onClick={skipAll}>
                SKIP
              </button>
            </div>
          </>
        )}

        {step === "mic" && (
          <>
            <p className="onboarding__lead">
              STEP 1 / 2 — your browser will now ask for microphone access.
              Choose <strong>Allow</strong>.
            </p>
            {micState === "denied" ? (
              <div className="onboarding__denied">
                <strong>MICROPHONE BLOCKED</strong>
                <p>
                  Your browser has saved a &ldquo;Block&rdquo; decision. To fix it: click the
                  🔒 / ⓘ icon left of the address bar → <em>Site settings</em> → set
                  Microphone to <em>Allow</em> → reload this page.
                </p>
              </div>
            ) : null}
            <div className="onboarding__actions">
              <button
                type="button"
                className="onboarding__btn onboarding__btn--primary"
                disabled={requesting}
                onClick={() => void requestMic()}
              >
                {requesting ? "WAITING FOR BROWSER…" : "ALLOW MICROPHONE"}
              </button>
              <button type="button" className="onboarding__btn" onClick={() => setStep("camera")}>
                SKIP
              </button>
            </div>
          </>
        )}

        {step === "camera" && (
          <>
            <p className="onboarding__lead">
              STEP 2 / 2 — allow the camera to control the orb with hand gestures.
            </p>
            {camState === "denied" || micState === "denied" ? (
              <div className="onboarding__denied">
                <strong>PERMISSION DENIED</strong>
                <p>
                  Address bar → 🔒 / ⓘ → <em>Site settings</em> → set Camera /
                  Microphone to <em>Allow</em> → reload. ULTRON still works without
                  them — gestures just stay off.
                </p>
              </div>
            ) : null}
            <div className="onboarding__actions">
              <button
                type="button"
                className="onboarding__btn onboarding__btn--primary"
                disabled={requesting}
                onClick={() => void requestCamera()}
              >
                {requesting ? "WAITING FOR BROWSER…" : "ALLOW CAMERA"}
              </button>
              <button type="button" className="onboarding__btn" onClick={skipAll}>
                FINISH WITHOUT CAMERA
              </button>
            </div>
          </>
        )}

        <div className="onboarding__foot">AUDIO + VIDEO STAY ON THIS MACHINE · NO KEYS · NO CLOUD UPLOAD</div>
      </div>
    </div>
  );
}
