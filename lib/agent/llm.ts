/**
 * ULTRON Agent — LLM Router (SERVER ONLY)
 *
 * Fallback chain:
 *   1. Gemini  (GEMINI_API_KEY)     — free tier, fast flash models
 *   2. Groq    (GROQ_API_KEY)       — OpenAI-compatible, extremely fast inference
 *   3. OpenRouter (OPENROUTER_API_KEY) — huge model catalogue as last resort
 *
 * Every call is wrapped in a hard timeout; a failing/slow provider falls
 * through to the next one. No key? The router degrades gracefully and the
 * route returns a clear configuration error instead of crashing.
 */

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface LLMResult {
  text: string;
  provider: "gemini" | "groq" | "openrouter";
  model: string;
}

export class LLMConfigError extends Error {
  constructor() {
    super("No LLM provider configured. Add GEMINI_API_KEY, GROQ_API_KEY or OPENROUTER_API_KEY to .env.local");
    this.name = "LLMConfigError";
  }
}
export class LLMError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LLMError";
  }
}

const TIMEOUT_MS = 30_000; // hard cap per provider attempt

// ─── Provider: Gemini ────────────────────────────────────────────────────────

const GEMINI_MODEL = "gemini-2.0-flash";
const GEMINI_URL = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

async function callGemini(messages: ChatMessage[]): Promise<LLMResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new LLMError("GEMINI_API_KEY not set", 401);

  const system = messages.find((m) => m.role === "system");
  const chat = messages.filter((m) => m.role !== "system");

  const body = {
    systemInstruction: system
      ? { parts: [{ text: system.content }] }
      : undefined,
    contents: chat.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1024,
    },
  };

  const res = await fetch(`${GEMINI_URL(GEMINI_MODEL)}?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new LLMError(
      `Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
      res.status,
    );
  }

  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text =
    data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ??
    "";
  if (!text.trim()) throw new LLMError("Gemini returned empty response", 502);
  return { text, provider: "gemini", model: GEMINI_MODEL };
}

// ─── Provider: Groq (OpenAI-compatible) ──────────────────────────────────────

const GROQ_MODEL = "llama-3.3-70b-versatile";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

async function callGroq(messages: ChatMessage[]): Promise<LLMResult> {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new LLMError("GROQ_API_KEY not set", 401);

  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      temperature: 0.7,
      max_tokens: 1024,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new LLMError(
      `Groq HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
      res.status,
    );
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = data.choices?.[0]?.message?.content ?? "";
  if (!text.trim()) throw new LLMError("Groq returned empty response", 502);
  return { text, provider: "groq", model: GROQ_MODEL };
}

// ─── Provider: OpenRouter ────────────────────────────────────────────────────

const OPENROUTER_MODEL = "google/gemini-2.0-flash-001";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

async function callOpenRouter(messages: ChatMessage[]): Promise<LLMResult> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new LLMError("OPENROUTER_API_KEY not set", 401);

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      // Optional but recommended attribution headers
      "HTTP-Referer": "http://localhost:3000",
      "X-Title": "ULTRON",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages,
      temperature: 0.7,
      max_tokens: 1024,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new LLMError(
      `OpenRouter HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
      res.status,
    );
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = data.choices?.[0]?.message?.content ?? "";
  if (!text.trim()) throw new LLMError("OpenRouter returned empty response", 502);
  return { text, provider: "openrouter", model: OPENROUTER_MODEL };
}

// ─── Router ──────────────────────────────────────────────────────────────────

export function listConfiguredProviders(): string[] {
  const providers: string[] = [];
  if (process.env.GEMINI_API_KEY) providers.push("gemini");
  if (process.env.GROQ_API_KEY) providers.push("groq");
  if (process.env.OPENROUTER_API_KEY) providers.push("openrouter");
  return providers;
}

/**
 * Try each configured provider in order. Returns the first success.
 * Throws LLMConfigError only when NO providers are configured at all.
 */
export async function callLLM(messages: ChatMessage[]): Promise<LLMResult> {
  const chain: [string, (m: ChatMessage[]) => Promise<LLMResult>][] = [
    ["gemini", callGemini],
    ["groq", callGroq],
    ["openrouter", callOpenRouter],
  ];

  let lastError: unknown = null;
  for (const [name, fn] of chain) {
    if (!listConfiguredProviders().includes(name)) continue;
    try {
      return await fn(messages);
    } catch (err) {
      lastError = err;
      console.error(`[llm] ${name} failed:`, err instanceof Error ? err.message : err);
    }
  }

  if (!listConfiguredProviders().length) throw new LLMConfigError();
  throw lastError instanceof Error
    ? new LLMError(`All providers failed. Last: ${lastError.message}`, 502)
    : new LLMError("All providers failed", 502);
}

// ═══════════════════════════════════════════════════════════════════════════
// STREAMING — same fallback chain, but token-by-token (SSE).
// Failover happens BEFORE the first byte: if a provider's connection fails
// or returns a non-200, we silently try the next one. Once bytes flow, an
// error just ends the stream (partial text is still usable).
// ═══════════════════════════════════════════════════════════════════════════

export interface LLMStream {
  provider: "gemini" | "groq" | "openrouter";
  model: string;
  /** Yields incremental text deltas. */
  iterator: AsyncGenerator<string>;
}

/** Headers-connection timeout; body streaming itself is unlimited. */
function connectSignal(): {
  signal: AbortSignal;
  done(): void;
} {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  return { signal: ctrl.signal, done: () => clearTimeout(timer) };
}

async function* sseLines(res: Response): AsyncGenerator<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // keep the partial line
      for (const line of lines) yield line.trim();
    }
    if (buffer.trim()) yield buffer.trim();
  } finally {
    reader.releaseLock();
  }
}

async function* streamGemini(messages: ChatMessage[]): AsyncGenerator<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new LLMError("GEMINI_API_KEY not set", 401);
  const system = messages.find((m) => m.role === "system");
  const chat = messages.filter((m) => m.role !== "system");
  const { signal, done } = connectSignal();

  const res = await fetch(
    `${GEMINI_URL(GEMINI_MODEL)}:streamGenerateContent?alt=sse&key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: system
          ? { parts: [{ text: system.content }] }
          : undefined,
        contents: chat.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
        generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
      }),
      signal,
    },
  );
  if (!res.ok || !res.body) {
    done();
    throw new LLMError(`Gemini HTTP ${res.status}`, res.status);
  }

  for await (const line of sseLines(res)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const json = JSON.parse(payload) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const text =
        json.candidates?.[0]?.content?.parts
          ?.map((p) => p.text ?? "")
          .join("") ?? "";
      if (text) yield text;
    } catch {
      // ignore malformed keepalive frames
    }
  }
  done();
}

/** OpenAI-compatible SSE (Groq + OpenRouter share the format). */
async function* streamOpenAICompatible(
  url: string,
  key: string,
  model: string,
  messages: ChatMessage[],
  extraHeaders: Record<string, string>,
): AsyncGenerator<string> {
  const { signal, done } = connectSignal();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, ...extraHeaders },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.7,
      max_tokens: 1024,
      stream: true,
    }),
    signal,
  });
  if (!res.ok || !res.body) {
    done();
    throw new LLMError(`HTTP ${res.status}`, res.status);
  }

  for await (const line of sseLines(res)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") break;
    if (!payload) continue;
    try {
      const json = JSON.parse(payload) as {
        choices?: { delta?: { content?: string } }[];
      };
      const text = json.choices?.[0]?.delta?.content ?? "";
      if (text) yield text;
    } catch {
      // ignore malformed frames
    }
  }
  done();
}

async function* streamGroq(messages: ChatMessage[]): AsyncGenerator<string> {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new LLMError("GROQ_API_KEY not set", 401);
  yield* streamOpenAICompatible(GROQ_URL, key, GROQ_MODEL, messages, {});
}

async function* streamOpenRouter(messages: ChatMessage[]): AsyncGenerator<string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new LLMError("OPENROUTER_API_KEY not set", 401);
  yield* streamOpenAICompatible(OPENROUTER_URL, key, OPENROUTER_MODEL, messages, {
    "HTTP-Referer": "http://localhost:3000",
    "X-Title": "ULTRON",
  });
}

/**
 * Start a streaming LLM completion with the same provider failover chain.
 * Resolves only once a provider has accepted the request (headers OK);
 * the returned iterator then yields text deltas as they arrive.
 */
export async function startLLMStream(messages: ChatMessage[]): Promise<LLMStream> {
  const chain: ["gemini" | "groq" | "openrouter", string, (m: ChatMessage[]) => AsyncGenerator<string>][] = [
    ["gemini", GEMINI_MODEL, streamGemini],
    ["groq", GROQ_MODEL, streamGroq],
    ["openrouter", OPENROUTER_MODEL, streamOpenRouter],
  ];

  const configured = listConfiguredProviders();
  if (configured.length === 0) throw new LLMConfigError();

  let lastError: unknown = null;
  for (const [provider, model, fn] of chain) {
    if (!configured.includes(provider)) continue;
    try {
      // Probe: create the generator; the fetch fires on first next() call.
      const iterator = fn(messages);
      // Advance once so connection errors surface HERE (before we commit).
      const first = await iterator.next();
      if (first.done) throw new LLMError(`${provider} produced no output`, 502);
      return {
        provider,
        model,
        // Re-yield the already-consumed first delta, then the rest.
        iterator: (async function* () {
          yield first.value;
          yield* iterator;
        })(),
      };
    } catch (err) {
      lastError = err;
      console.error(
        `[llm:stream] ${provider} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  throw lastError instanceof Error
    ? new LLMError(`All providers failed. Last: ${lastError.message}`, 502)
    : new LLMError("All providers failed", 502);
}
