import { NextRequest } from "next/server";
import {
  AccessToken,
  AgentDispatchClient,
  RoomServiceClient,
} from "livekit-server-sdk";

export const runtime = "nodejs";

/**
 * LiveKit token minting + agent dispatch for the ULTRON voice room.
 *
 * Requires LIVEKIT_URL + LIVEKIT_API_KEY + LIVEKIT_API_SECRET in .env.local.
 * Secrets stay server-side — the browser only receives a join token.
 *
 * When the livekit-agent worker (livekit-agent/agent.py) is running, this
 * route also:
 *   • explicitly dispatches the "ultron-voice" agent into the room, and
 *   • reports whether the worker is actually present (HUD: ULTRON AGENT: IN ROOM).
 *
 * Without env vars this returns 503 and the client keeps the local voice
 * pipeline (Web Speech) — graceful degradation, never a crash.
 */

const ROOM_NAME = "ultron-voice";
const AGENT_NAME = "ultron-voice";
const TTL_SECONDS = 60 * 60; // 1 hour

interface LivekitPayload {
  token: string;
  url: string;
  room: string;
  agentDispatched: boolean;
  agentInRoom: boolean;
}

export async function GET(_req: NextRequest) {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const url = process.env.LIVEKIT_URL;

  if (!apiKey || !apiSecret || !url) {
    return Response.json(
      {
        error:
          "LiveKit not configured. Add LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET to .env.local (free tier at cloud.livekit.io).",
      },
      { status: 503 },
    );
  }

  let agentDispatched = false;
  let agentInRoom = false;

  try {
    const dispatchClient = new AgentDispatchClient(apiKey, apiSecret);

    // Is the ULTRON agent worker already sitting in the room?
    const roomService = new RoomServiceClient(apiKey, apiSecret);
    try {
      const participants = await roomService.listParticipants(ROOM_NAME);
      agentInRoom = participants.some((p) => p.identity.startsWith("agent-"));
    } catch {
      // Room doesn't exist yet — that's fine, it gets created on first join
      agentInRoom = false;
    }

    // Explicitly dispatch our agent into the room (idempotent if already there)
    if (!agentInRoom) {
      try {
        await dispatchClient.createDispatch(ROOM_NAME, AGENT_NAME, {
          metadata: JSON.stringify({ source: "ultron-web" }),
        });
        agentDispatched = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // "dispatch already exists" is fine — the agent is on its way
        if (!/exist|already/i.test(msg)) {
          console.warn("[api/livekit] agent dispatch failed:", msg);
        } else {
          agentDispatched = true;
        }
      }
    } else {
      agentDispatched = true;
    }
  } catch (err) {
    // Dispatch is an enhancement — token join still works without it
    console.warn(
      "[api/livekit] dispatch unavailable:",
      err instanceof Error ? err.message : err,
    );
  }

  const token = new AccessToken(apiKey, apiSecret, {
    identity: `ultron-user-${Date.now().toString(36)}`,
    ttl: TTL_SECONDS,
  });
  token.addGrant({
    room: ROOM_NAME,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  const payload: LivekitPayload = {
    token: await token.toJwt(),
    url,
    room: ROOM_NAME,
    agentDispatched,
    agentInRoom,
  };
  return Response.json(payload);
}
