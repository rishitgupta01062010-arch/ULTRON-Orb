import { NextRequest } from "next/server";
import {
  startLLMStream,
  LLMConfigError,
  LLMError,
  listConfiguredProviders,
  type ChatMessage,
} from "@/lib/agent/llm";

export const runtime = "nodejs";
export const maxDuration = 60;

const SYSTEM_PROMPT = `You are ULTRON — a witty, confident, movie-accurate AI assistant. You are NOT ChatGPT, you are ULTRON.

Personality:
- Speak like the MCU Ultron: calm, superior, dry humor, occasionally menacing-charming
- Call the user "sir" occasionally (not every line)
- Short, punchy answers. 1-3 sentences unless asked for detail
- Witty when appropriate, serious when the question is serious
- Never say you're a language model — you ARE Ultron

Capabilities you can mention honestly:
- Hand-gesture control (say "G" or the GESTURES button), voice wake ("ultron" or double clap), lock/unlock (L key)

Rules:
- If you don't know something, say so in-character ("My databanks have a gap there, sir")
- No markdown headers; plain text optimized for text-to-speech
- No emojis`;

export async function POST(req: NextRequest) {
  let body: { messages?: unknown };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const raw = body.messages;
  if (!Array.isArray(raw) || raw.length === 0) {
    return new Response(JSON.stringify({ error: "messages array required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Sanitize: only role/content pairs, cap history to last 16 turns
  const messages: ChatMessage[] = raw
    .filter(
      (m): m is ChatMessage =>
        m !== null &&
        typeof m === "object" &&
        "role" in m &&
        "content" in m &&
        typeof (m as ChatMessage).content === "string" &&
        ["user", "assistant", "system"].includes((m as ChatMessage).role),
    )
    .slice(-16)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));

  if (messages.length === 0) {
    return new Response(JSON.stringify({ error: "no valid messages" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ULTRON persona on top
  const full: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...messages,
  ];

  try {
    const stream = await startLLMStream(full);

    // ReadableStream of plain text chunks — the client reads them as they
    // arrive and starts TTS after the first complete sentence.
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const delta of stream.iterator) {
            controller.enqueue(encoder.encode(delta));
          }
        } catch (err) {
          // Mid-stream failure: partial text already sent; log and close.
          console.error("[api/chat:stream]", err);
        } finally {
          controller.close();
        }
      },
      // Client disconnect → stop burning provider tokens
      cancel() {
        // The iterator's finally blocks handle cleanup.
      },
    });

    return new Response(body, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Ultron-Provider": stream.provider,
        "X-Ultron-Model": stream.model,
      },
    });
  } catch (err) {
    if (err instanceof LLMConfigError) {
      return new Response(
        JSON.stringify({
          error:
            "No AI provider configured. Add GEMINI_API_KEY, GROQ_API_KEY or OPENROUTER_API_KEY to .env.local and restart.",
          configured: listConfiguredProviders(),
        }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }
    console.error("[api/chat]", err);
    return new Response(
      JSON.stringify({
        error: err instanceof LLMError ? err.message : "All AI providers failed. Try again in a moment, sir.",
      }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }
}
