/**
 * POST /api/tts — Fish Audio text-to-speech proxy (SERVER ONLY).
 *
 * Keeps FISH_AUDIO_API_KEY out of the browser. Returns raw audio/mpeg bytes.
 * If Fish Audio is not configured or fails, responds 503 — the client then
 * falls back to the browser's built-in speechSynthesis automatically.
 *
 * Environment:
 *   FISH_AUDIO_API_KEY  — required (fish.audio → API keys)
 *   FISH_AUDIO_VOICE_ID — optional reference_id of the voice model to use
 */

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const FISH_TTS_URL = "https://api.fish.audio/v1/tts";

export async function POST(req: NextRequest) {
  const key = process.env.FISH_AUDIO_API_KEY;
  if (!key) {
    return NextResponse.json(
      { error: "FISH_AUDIO_API_KEY not configured — using browser voice" },
      { status: 503 },
    );
  }

  let body: { text?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    return NextResponse.json({ error: "text required" }, { status: 400 });
  }
  // Fish Audio limit is 1000 chars/request — trim rather than fail
  const clipped = text.slice(0, 1000);

  try {
    const upstream = await fetch(FISH_TTS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: clipped,
        // Voice reference: set FISH_AUDIO_VOICE_ID in .env.local to pick a voice
        ...(process.env.FISH_AUDIO_VOICE_ID
          ? { reference_id: process.env.FISH_AUDIO_VOICE_ID }
          : {}),
        format: "mp3",
        mp3_bitrate: 64, // small + fast on a Celeron
        normalize: true,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!upstream.ok || !upstream.body) {
      const detail = (await upstream.text()).slice(0, 200);
      console.error(`[api/tts] Fish Audio HTTP ${upstream.status}: ${detail}`);
      return NextResponse.json(
        { error: `Fish Audio error (${upstream.status})` },
        { status: 502 },
      );
    }

    return new NextResponse(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("[api/tts]", err);
    return NextResponse.json(
      { error: "TTS request failed — using browser voice" },
      { status: 502 },
    );
  }
}
