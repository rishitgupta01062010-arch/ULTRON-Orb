"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createOrbScene, type OrbSceneApi } from "@/lib/orbScene";
import { HandTracker, type TrackerStatus } from "@/lib/handTracker";
import { ClapDetector } from "@/lib/clapDetector";
import {
  playLockSound,
  playUnlockSound,
  speakUnlockConfirmation,
} from "@/lib/systemAudio";
import { useUltronAgent } from "@/lib/agent/useUltronAgent";
import {
  useUltronVoice,
  type VoiceState,
} from "@/lib/voice/useUltronVoice";
import { useLiveKit } from "@/lib/voice/useLiveKit";
import ChatPanel from "@/components/ChatPanel";
import VoiceWaveform from "@/components/VoiceWaveform";
import LockScreen from "@/components/LockScreen";
import PermissionOnboarding, { isOnboardingNeeded } from "@/components/PermissionOnboarding";
import VoiceSettings from "@/components/VoiceSettings";

type CameraState = "off" | "starting" | "on" | "error";

const MODE_LABEL: Record<TrackerStatus["mode"], string> = {
  idle: "STANDBY",
  spin: "SPIN",
  zoom: "ZOOM",
};

/** Map the voice engine state to the LockScreen's mic status display. */
function toMicStatus(state: VoiceState): "unsupported" | "idle" | "listening" | "error" {
  if (state === "unsupported") return "unsupported";
  if (state === "idle") return "idle";
  return "listening"; // all other states = mic is armed and running
}

export default function JarvisOrb() {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<OrbSceneApi | null>(null);
  const trackerRef = useRef<HandTracker | null>(null);

  const [camera, setCamera] = useState<CameraState>("off");
  const [status, setStatus] = useState<TrackerStatus>({ hands: 0, mode: "idle" });
  const [error, setError] = useState<string | null>(null);

  // System starts LOCKED — say "ultron" (or double clap) to unlock
  const [locked, setLocked] = useState(true);

  // AI agent — streaming + voice (Gemini → Groq → OpenRouter, Fish Audio TTS)
  const agent = useUltronAgent();
  const [chatOpen, setChatOpen] = useState(false);
  const [continuous, setContinuous] = useState(true); // hands-free by default

  // First-launch onboarding + voice settings panel
  const [onboarding, setOnboarding] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Orb mouth: drive the scene's voice pulse from the agent state
  useEffect(() => {
    sceneRef.current?.setVoiceLevel(agent.state === "speaking" ? 1 : 0);
  }, [agent.state]);

  const scene = sceneRef.current;
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const created = createOrbScene(container);
    created.setLocked(true); // boot locked → blue orb
    sceneRef.current = created;
    return () => {
      trackerRef.current?.stop();
      trackerRef.current = null;
      created.dispose();
      sceneRef.current = null;
    };
  }, []);

  // ─── VOICE ENGINE — always listening; the wake word gates everything ────────
  const startGesturesRef = useRef<() => void>(() => {});

  const handleWake = useCallback(() => {
    setLocked(false);
    sceneRef.current?.setLocked(false);
    playUnlockSound();
    speakUnlockConfirmation();
    voiceRef.current?.noteUnlocked();
    startGesturesRef.current();
  }, []);

  const handleQuestion = useCallback(
    (text: string) => {
      void agent.ask(text);
    },
    [agent],
  );

  const handleStop = useCallback(() => {
    agent.pauseSpeaking(); // "stop" pauses mid-sentence; "continue" resumes
  }, [agent]);

  const handleContinue = useCallback(() => {
    void agent.resumeSpeaking();
  }, [agent]);

  const voice = useUltronVoice({
    onWake: handleWake,
    onQuestion: handleQuestion,
    onStop: handleStop,
    onContinue: handleContinue,
    continuous,
  });
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  // First-launch onboarding — show before arming the mic so the browser
  // prompts are explained, not surprising. Skippable; system boots locked
  // either way.
  useEffect(() => {
    if (isOnboardingNeeded()) setOnboarding(true);
  }, []);

  // Arm the always-on mic once onboarding completes (or was skipped).
  // NOT re-armed on lock/unlock — the engine's gate transitions handle that,
  // preserving the single persistent recognition session.
  useEffect(() => {
    if (onboarding) return; // not finished yet
    voice.arm();
    if (locked) voice.enterLockedGate();
    return () => voice.disarm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboarding, voice.arm, voice.disarm, voice.enterLockedGate]);

  // ─── LIVEKIT — optional LIVE bridge (no-ops when unconfigured) ─────────────
  const livekit = useLiveKit();

  // ─── CLAP WAKE — double clap unlocks while locked ──────────────────────────
  const clapRef = useRef<ClapDetector | null>(null);
  const [clapError, setClapError] = useState(false);
  useEffect(() => {
    if (!locked) {
      clapRef.current?.stop();
      clapRef.current = null;
      return;
    }
    const detector = new ClapDetector(() => {
      handleWake();
    });
    detector.setSensitivity(voice.tuning.clapThreshold);
    clapRef.current = detector;
    detector.start().catch(() => setClapError(true));
    return () => {
      detector.stop();
    };
  }, [locked, handleWake]);

  // ─── GESTURES ───
  const stopGestures = useCallback(() => {
    trackerRef.current?.stop();
    trackerRef.current = null;
    setCamera("off");
    setStatus({ hands: 0, mode: "idle" });
  }, []);

  const startGestures = useCallback(async () => {
    const video = videoRef.current;
    const overlay = overlayRef.current;
    if (!video || !overlay || trackerRef.current) return;

    setCamera("starting");
    setError(null);

    const tracker = new HandTracker(video, overlay, {
      onRotate: (dt, dp) => sceneRef.current?.rotateBy(dt, dt * 0.6),
      onZoom: (factor) => sceneRef.current?.zoomBy(factor),
      onStatus: setStatus,
    });
    trackerRef.current = tracker;

    try {
      await tracker.start();
      setCamera("on");
    } catch (err) {
      trackerRef.current = null;
      tracker.stop();
      setCamera("error");
      setError(
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "CAMERA ACCESS DENIED"
          : "TRACKING INIT FAILED",
      );
    }
  }, []);

  // Wake handler triggers gestures without a dependency loop
  useEffect(() => {
    startGesturesRef.current = () => {
      if (!locked) void startGestures();
    };
  }, [locked, startGestures]);

  const toggleGestures = useCallback(() => {
    if (trackerRef.current) stopGestures();
    else void startGestures();
  }, [startGestures, stopGestures]);

  // ─── LOCK / KEYBOARD ───
  const handleLock = useCallback(() => {
    setLocked(true);
    sceneRef.current?.setLocked(true);
    playLockSound();
    stopGestures();
    setChatOpen(false);
    agent.stopSpeaking();
    voice.noteLocked(); // mic returns to wake-word-only gate
  }, [stopGestures, agent, voice]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (locked) return;
      switch (e.key) {
        case "+":
        case "=":
          sceneRef.current?.zoomIn();
          break;
        case "-":
        case "_":
          sceneRef.current?.zoomOut();
          break;
        case "r":
        case "R":
          sceneRef.current?.resetView();
          break;
        case "g":
        case "G":
          toggleGestures();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleGestures, locked]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "l" || e.key === "L") && !locked) handleLock();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [locked, handleLock]);

  // Keep the running clap detector's threshold in sync with the slider
  useEffect(() => {
    clapRef.current?.setSensitivity(voice.tuning.clapThreshold);
  }, [voice.tuning.clapThreshold]);

  // ─── Agent speaking notifications → voice engine echo guard ────────────────
  useEffect(() => {
    if (agent.state === "speaking") voice.noteSpeaking();
    else if (agent.state === "idle") voice.noteSpeakingDone();
    // "paused" / "thinking" → no change needed
  }, [agent.state, voice]);

  const cameraOn = camera === "on";

  // Status line under the title: one source of truth for what ULTRON is doing
  const statusLine =
    agent.state === "thinking"
      ? "THINKING…"
      : agent.state === "speaking"
        ? "SPEAKING — SAY “STOP” TO PAUSE"
        : agent.state === "paused"
          ? "PAUSED — SAY “CONTINUE” TO RESUME"
          : voice.state === "processing"
            ? "PROCESSING…"
            : voice.lastAction || "LISTENING — SAY “ULTRON” + YOUR QUESTION";

  const handleOnboardingComplete = useCallback(() => {
    setOnboarding(false);
  }, []);

  return (
    <>
      <div ref={containerRef} className="orb-root" />

      <div className="overlay-vignette" />
      <div className="overlay-grain" />
      <div className="overlay-scanlines" />

      {onboarding && (
        <PermissionOnboarding onComplete={handleOnboardingComplete} />
      )}

      {locked ? (
        <LockScreen
          listening={voice.state !== "idle" && voice.state !== "unsupported"}
          heard={voice.heard}
          micStatus={toMicStatus(voice.state)}
          clapAvailable={!clapError}
          onManualUnlock={handleWake}
          onRetryMic={() => {
            voice.disarm();
            setTimeout(() => voice.arm(), 300);
          }}
        />
      ) : (
        <>
          <div className="hud hud-title">U.L.T.R.O.N.</div>

          <div className="hud hud-status" data-state={agent.state}>
            {statusLine}
          </div>

          <div className="hud hud-hint">
            <div>
              <span className="key">“ULTRON + QUESTION”</span> ask anything&nbsp;&nbsp;
              <span className="key">“STOP”</span> pause answer&nbsp;&nbsp;
              <span className="key">“CONTINUE”</span> resume
            </div>
            {cameraOn ? (
              <div>
                <span className="key">PINCH + MOVE</span> spin&nbsp;&nbsp;
                <span className="key">PINCH BOTH HANDS ± SPREAD</span> zoom
              </div>
            ) : (
              <div>
                <span className="key">G</span> gestures&nbsp;&nbsp;
                <span className="key">R</span> reset&nbsp;&nbsp;
                <span className="key">L</span> lock
              </div>
            )}
          </div>

          <div className="hud hud-controls">
            <div className={`camera-panel${cameraOn ? " visible" : ""}`}>
              <video ref={videoRef} muted playsInline className="camera-video" />
              <canvas ref={overlayRef} width={208} height={156} className="camera-overlay" />
              <div className="camera-status">
                {status.hands > 0
                  ? `${status.hands} HAND${status.hands > 1 ? "S" : ""} · ${MODE_LABEL[status.mode]}`
                  : "SHOW HANDS"}
              </div>
            </div>

            {error && <div className="hud-error">{error}</div>}
            {agent.error && <div className="hud-error">{agent.error}</div>}

            <div className="hud-row">
              <button
                type="button"
                className={`hud-btn${continuous ? " hud-btn--on" : ""}`}
                aria-pressed={continuous}
                onClick={() => setContinuous((v) => !v)}
                title="Keep listening for follow-up questions after each answer"
              >
                {continuous ? "CONTINUOUS ON" : "CONTINUOUS OFF"}
              </button>
              <button
                type="button"
                className={`hud-btn${livekit.isConnected ? " hud-btn--on" : ""}`}
                onClick={() => {
                  if (livekit.isConnected) void livekit.disconnect();
                  else void livekit.connect();
                }}
                title="LiveKit realtime voice bridge — needs LIVEKIT_* env vars"
              >
                {livekit.status === "connecting"
                  ? "LIVE…"
                  : livekit.isConnected
                    ? "LIVE ON"
                    : "LIVE OFF"}
              </button>
              <button
                type="button"
                className="hud-btn"
                aria-pressed={chatOpen}
                onClick={() => setChatOpen((v) => !v)}
              >
                ASK ULTRON
              </button>
              <button
                type="button"
                className={`hud-btn${settingsOpen ? " hud-btn--on" : ""}`}
                aria-pressed={settingsOpen}
                onClick={() => setSettingsOpen((v) => !v)}
                title="Voice calibration — sensitivity, noise gate, clap threshold"
              >
                VOICE ⚙
              </button>
              <button type="button" className="hud-btn" onClick={handleLock} aria-label="Lock system">
                LOCK
              </button>
            </div>

            <div className="hud-row">
              <button type="button" className="hud-btn" onClick={() => sceneRef.current?.zoomIn()} aria-label="Zoom in">
                +
              </button>
              <button type="button" className="hud-btn" onClick={() => sceneRef.current?.zoomOut()} aria-label="Zoom out">
                −
              </button>
              <button type="button" className="hud-btn" onClick={() => sceneRef.current?.resetView()}>
                RESET
              </button>
            </div>
          </div>

          {/* ULTRON's mouth — under the orb while it speaks */}
          <VoiceWaveform
            state={agent.state}
            audioElement={agent.audioElement}
          />

          {settingsOpen && (
            <VoiceSettings
              getGateInfo={voice.getGateInfo}
              onClose={() => setSettingsOpen(false)}
            />
          )}

          {chatOpen && (
            <ChatPanel
              history={agent.history}
              streamingText={agent.streamingText}
              state={agent.state}
              error={agent.error}
              onSend={(text) => agent.ask(text)}
              onClear={agent.clear}
              onClose={() => setChatOpen(false)}
            />
          )}
        </>
      )}
    </>
  );
}
