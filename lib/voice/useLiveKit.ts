"use client";

/**
 * useLiveKit — optional LiveKit voice bridge.
 *
 * When LIVEKIT_* env vars are configured, "LIVE" mode connects this browser
 * to an ULTRON LiveKit room. What you get:
 *
 *   • Server-side STT/TTS pipeline (LiveKit Agents) instead of Web Speech
 *   • Echo-proof voice — recognition and playback both ride the room
 *   • Room-level presence: see when ULTRON's agent is connected
 *
 * When not configured, every method is a safe no-op and the UI reports
 * "LIVE UNAVAILABLE" — the local Web Speech pipeline keeps working.
 *
 * All state changes are exposed as plain React state for the HUD.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  ConnectionState,
} from "livekit-client";

export type LiveKitStatus =
  | "unconfigured" // no env vars on the server → 503
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export function useLiveKit(onAgentTranscript?: (text: string) => void) {
  const [status, setStatus] = useState<LiveKitStatus>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [agentPresent, setAgentPresent] = useState(false);

  const roomRef = useRef<Room | null>(null);
  const onTranscriptRef = useRef(onAgentTranscript);
  onTranscriptRef.current = onAgentTranscript;

  // Track remote (ULTRON agent) audio — do NOT auto-play; the agent's speech
  // is played through the room only in LIVE mode. Local mode plays locally.
  const agentAudioRef = useRef<HTMLAudioElement | null>(null);

  const handleTrack = useCallback(
    (track: RemoteTrack, _pub: unknown) => {
      if (track.kind !== Track.Kind.Audio) return;
      const el = track.attach();
      el.autoplay = true;
      el.style.display = "none";
      document.body.appendChild(el);
      agentAudioRef.current = el;
    },
    [],
  );

  const connect = useCallback(async () => {
    if (roomRef.current) return; // already connected/connecting
    setStatus("connecting");
    setError(null);

    let data: { token: string; url: string; room: string };
    try {
      const res = await fetch("/api/livekit", { signal: AbortSignal.timeout(8000) });
      if (res.status === 503) {
        setStatus("unconfigured");
        setError("LiveKit not configured — add LIVEKIT_* env vars to .env.local");
        return;
      }
      if (!res.ok) {
        setStatus("error");
        setError(`LiveKit token endpoint failed (${res.status})`);
        return;
      }
      data = (await res.json()) as typeof data;
    } catch {
      setStatus("error");
      setError("Could not reach the LiveKit token endpoint.");
      return;
    }

    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;

    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub) =>
      handleTrack(track, pub),
    );
    room.on(RoomEvent.ParticipantConnected, () => setAgentPresent(true));
    room.on(RoomEvent.ParticipantDisconnected, () => setAgentPresent(false));
    room.on(RoomEvent.Disconnected, () => {
      setStatus("disconnected");
      setAgentPresent(false);
    });
    // Server-side agent STT arrives as transcription (if the agent sends it)
    room.on(RoomEvent.TranscriptionReceived, (segments) => {
      const last = segments[segments.length - 1];
      if (last?.final && onTranscriptRef.current && last.text.trim()) {
        onTranscriptRef.current(last.text.trim());
      }
    });

    try {
      await room.connect(data.url, data.token);
      // Publish our mic so a server-side agent can hear the user
      try {
        await room.localParticipant.setMicrophoneEnabled(true);
      } catch {
        // Mic publication is optional — subscribe-only still works
      }
      setStatus("connected");
      setAgentPresent(room.remoteParticipants.size > 0);
    } catch (err) {
      setStatus("error");
      setError(
        err instanceof Error ? `LiveKit connect failed: ${err.message}` : "LiveKit connect failed.",
      );
      roomRef.current = null;
    }
  }, [handleTrack]);

  const disconnect = useCallback(async () => {
    const room = roomRef.current;
    roomRef.current = null;
    if (agentAudioRef.current) {
      agentAudioRef.current.remove();
      agentAudioRef.current = null;
    }
    if (room) {
      try {
        await room.disconnect();
      } catch {
        /* already gone */
      }
    }
    setStatus("disconnected");
    setAgentPresent(false);
  }, []);

  useEffect(() => {
    return () => {
      const room = roomRef.current;
      roomRef.current = null;
      if (room) void room.disconnect().catch(() => undefined);
      if (agentAudioRef.current) agentAudioRef.current.remove();
    };
  }, []);

  return {
    status,
    error,
    agentPresent,
    connect,
    disconnect,
    isConnected: status === "connected",
    connectionState: () => roomRef.current?.state ?? ConnectionState.Disconnected,
  };
}
