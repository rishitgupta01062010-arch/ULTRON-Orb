/**
 * POST /api/tts — server-side TTS with automatic provider fallback.
 *
 *   1. Fish Audio   (FISH_AUDIO_API_KEY)          — premium emotional voice
 *   2. Groq Orpheus (GROQ_API_KEY)                — free premium neural voice
 *   3. 503/502 → the client falls back to the browser's built-in speechSynthesis
 *
 * Every key stays server-side. The successful provider is advertised in the
 * `X-TTS-Provider` response header for debugging.
 *
 * Environment:
 *   FISH_AUDIO_API_KEY  — optional (fish.audio → API keys)
 *   FISH_AUDIO_VOICE_ID — optional reference_id of the voice model to use
 *   GROQ_API_KEY        — optional (console.groq.com/keys). NOTE: Orpheus is
 *     a gated model — accept its terms once at:
 *     https://console.groq.com/playground?model=canopylabs%2Forpheus-v1-english
 *   GROQ_TTS_VOICE      — optional voice name (default: "hade")
 */

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const FISH_TTS_URL = "https://api.fish.audio/v1/tts";
const GROQ_TTS_URL = "https://api.groq.com/openai/v1/audio/speech";
const GROQ_TTS_MODEL = "canopylabs/orpheus-v1-english";
const GROQ_TTS_VOICE = process.env.GROQ_TTS_VOICE || "hade";

const MAX_CHARS = 1000; // both providers accept at least this much

async function fishAudio(text: string, key: string): Promise<Response> {
  const upstream = await fetch(FISH_TTS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
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
    throw new Error(`Fish Audio HTTP ${upstream.status}: ${detail}`);
  }
  return new Response(upstream.body, {
    status: 200,
    headers: { "Content-Type": "audio/mpeg", "X-TTS-Provider": "fish" },
  });
}

async function groqOrpheus(text: string, key: string): Promise<Response> {
  const upstream = await fetch(GROQ_TTS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_TTS_MODEL,
      input: text,
      voice: GROQ_TTS_VOICE,
      response_format: "mp3",
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!upstream.ok || !upstream.body) {
    const detail = (await upstream.text()).slice(0, 200);
    throw new Error(`Groq TTS HTTP ${upstream.status}: ${detail}`);
  }
  return new Response(upstream.body, {
    status: 200,
    headers: { "Content-Type": "audio/mpeg", "X-TTS-Provider": "groq" },
  });
}

export async function POST(req: NextRequest) {
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
  const clipped = text.slice(0, MAX_CHARS);

  const chain: { name: string; key?: string; run: (t: string, k: string) => Promise<Response> }[] = [
    { name: "fish", key: process.env.FISH_AUDIO_API_KEY, run: fishAudio },
    { name: "groq", key: process.env.GROQ_API_KEY, run: groqOrpheus },
  ];

  let lastError = "";
  let anyConfigured = false;

  for (const attempt of chain) {
    if (!attempt.key) continue;
    anyConfigured = true;
    try {
      return await attempt.run(clipped, attempt.key);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.error(`[api/tts] ${attempt.name} failed:`, lastError);
    }
  }

  if (!anyConfigured) {
    return NextResponse.json(
      { error: "No TTS provider configured — using browser voice" },
      { status: 503 },
    );
  }
  return NextResponse.json(
    { error: `TTS unavailable — using browser voice (${lastError.slice(0, 120)})` },
    { status: 502 },
  );
}
