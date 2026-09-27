/**
 * Local configuration endpoints — secure setup flow for API keys.
 *
 *   GET  /api/config              → which providers are configured (BOOLEANS ONLY —
 *                                   no key material, not even masked fragments)
 *   POST /api/config {action:...}
 *        action "save"           → merge allowlisted vars into .env.local (atomic,
 *                                  preserves unrelated lines; never logs/returns values)
 *        action "reset"          → remove ONLY the allowlisted keys provided
 *        action "test"           → live-verify one provider against its real API
 *
 * Security model:
 *   • LOCAL ONLY — every handler verifies that the TCP connection actually
 *     originates from the loopback interface via req.socket.remoteAddress.
 *     Header-based checks (Host / X-Forwarded-*) are NOT trusted as the primary
 *     signal: both are client-controlled and trivially spoofed by any LAN
 *     device. The socket address cannot be forged by request headers.
 *     A local Host header is additionally required, which also defeats
 *     DNS-rebinding attempts (rebinded requests carry the attacker's Host).
 *     This endpoint lives in pages/api (not app/api) precisely because
 *     NextApiRequest exposes the underlying socket.
 *   • ALLOWLIST — only keys listed in CONFIG_KEYS can be read/written/reset.
 *   • WRITE-ONLY — secrets flow browser → file, never file → browser.
 *   • Atomic writes (temp file + rename) so a crash can't truncate .env.local.
 *   • The browser never sees the key again after submitting; UI uses booleans.
 */

import { NextApiRequest, NextApiResponse } from "next";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";

/** The ONLY environment variables this endpoint may touch. */
const CONFIG_KEYS = [
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  "FISH_AUDIO_API_KEY",
  "FISH_AUDIO_VOICE_ID",
  "LIVEKIT_URL",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
] as const;

type ConfigKey = (typeof CONFIG_KEYS)[number];

const MAX_VALUE_LEN = 300;

function isLoopbackAddress(addr: string): boolean {
  const a = addr.toLowerCase();
  return (
    a === "::1" ||
    a === "::ffff:127.0.0.1" ||
    a === "127.0.0.1" ||
    a.startsWith("::ffff:127.")
  );
}

function isLocalRequest(req: NextApiRequest): boolean {
  // Primary signal: the actual TCP socket address. Cannot be spoofed by headers.
  const socketAddr = req.socket?.remoteAddress ?? "";
  if (socketAddr && !isLoopbackAddress(socketAddr)) return false;

  // Secondary: the Host header must be local. Blocks remote clients that spoof
  // "Host: localhost" (their socket is already non-loopback) and DNS-rebinding
  // (loopback socket, but the browser sends the attacker's hostname).
  const host = (req.headers.host ?? "").toLowerCase().split(":")[0];
  const hostOk =
    host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  if (!hostOk) return false;

  // Belt-and-suspenders: if a forwarded chain exists at all, its first hop
  // must also be loopback (a reverse proxy on the same machine).
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) {
    const firstHop = xff.split(",")[0].trim().toLowerCase();
    if (firstHop && !isLoopbackAddress(firstHop)) return false;
  }
  return true;
}

function envLocalPath(): string {
  return join(process.cwd(), ".env.local");
}

/** Parse a raw .env-style file into ordered lines (preserves comments/blank lines). */
function parseEnvLines(content: string): { key: string; value: string; raw: string }[] {
  return content.split(/\r?\n/).map((raw) => {
    const trimmed = raw.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0 || trimmed.startsWith("#")) return { key: "", value: "", raw };
    return { key: trimmed.slice(0, eq).trim(), value: trimmed.slice(eq + 1).trim(), raw };
  });
}

function readEnvLocal(): string {
  return existsSync(envLocalPath()) ? readFileSync(envLocalPath(), "utf8") : "";
}

/**
 * Merge vars into .env.local content: replace values of keys that already
 * exist, append the rest under a marker comment. Unrelated lines are kept
 * byte-for-byte.
 */
function upsertVars(content: string, vars: Record<string, string>): string {
  const lines = content.split(/\r?\n/);
  const pending = { ...vars };
  const seen = new Set<string>();

  const out = lines.map((line) => {
    const trimmed = line.trim();
    const eq = trimmed.indexOf("=");
    if (eq > 0 && !trimmed.startsWith("#")) {
      const key = trimmed.slice(0, eq).trim();
      if (key in pending) {
        seen.add(key);
        return `${key}=${pending[key]}`;
      }
    }
    return line;
  });

  const missing = (Object.keys(pending) as string[]).filter((k) => !seen.has(k));
  if (missing.length) {
    if (out.length && out[out.length - 1].trim() !== "") out.push("");
    out.push("# ── managed by Ultron Orb local setup (do not commit) ──");
    for (const k of missing) out.push(`${k}=${pending[k]}`);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n") + (content.endsWith("\n") || !content ? "\n" : "");
}

/** Remove only the given allowlisted keys; leave everything else untouched. */
function removeVars(content: string, keys: string[]): string {
  const drop = new Set(keys);
  const lines = content.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    const eq = trimmed.indexOf("=");
    if (eq > 0 && !trimmed.startsWith("#") && drop.has(trimmed.slice(0, eq).trim())) return false;
    return true;
  });
  return lines.join("\n");
}

/** Atomic write: temp file in the same directory, then rename over target. */
function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${Date.now()}`;
  writeFileSync(tmp, content, "utf8");
  try {
    try {
      unlinkSync(path);
    } catch {
      /* target may not exist yet — fine */
    }
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing more we can do */
    }
    throw err;
  }
}

/* ── provider live-tests: minimal, cheapest possible call per provider ── */

async function testProvider(provider: string): Promise<{ ok: boolean; detail: string }> {
  // Read from the FILE (fresh values) so "test" works immediately after save.
  const fileEnv: Record<string, string> = {};
  for (const line of parseEnvLines(readEnvLocal())) {
    if (line.key) fileEnv[line.key] = line.value;
  }
  const val = (k: string) => fileEnv[k] || process.env[k] || "";

  try {
    if (provider === "gemini") {
      const key = val("GEMINI_API_KEY");
      if (!key) return { ok: false, detail: "Gemini API key is not configured." };
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=1`,
        { signal: AbortSignal.timeout(15_000) },
      );
      if (r.ok) return { ok: true, detail: "Gemini key is valid." };
      if (r.status === 400 || r.status === 401 || r.status === 403)
        return { ok: false, detail: "Gemini authentication failed. Check your API key." };
      return { ok: false, detail: `Gemini unreachable (HTTP ${r.status}). Try again shortly.` };
    }

    if (provider === "groq") {
      const key = val("GROQ_API_KEY");
      if (!key) return { ok: false, detail: "Groq API key is not configured." };
      const r = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (r.ok) return { ok: true, detail: "Groq key is valid." };
      if (r.status === 401 || r.status === 403)
        return { ok: false, detail: "Groq authentication failed. Check your API key." };
      return { ok: false, detail: `Groq unreachable (HTTP ${r.status}). Try again shortly.` };
    }

    if (provider === "openrouter") {
      const key = val("OPENROUTER_API_KEY");
      if (!key) return { ok: false, detail: "OpenRouter API key is not configured." };
      const r = await fetch("https://openrouter.ai/api/v1/auth/key", {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (r.ok) return { ok: true, detail: "OpenRouter key is valid." };
      if (r.status === 401 || r.status === 403)
        return { ok: false, detail: "OpenRouter authentication failed. Check your API key." };
      return { ok: false, detail: `OpenRouter unreachable (HTTP ${r.status}).` };
    }

    if (provider === "fish") {
      const key = val("FISH_AUDIO_API_KEY");
      if (!key) return { ok: false, detail: "Fish Audio API key is not configured." };
      const r = await fetch("https://api.fish.audio/wallet/self/api-credit", {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (r.ok) return { ok: true, detail: "Fish Audio key is valid." };
      if (r.status === 401 || r.status === 403)
        return { ok: false, detail: "Fish Audio authentication failed. Check your API key." };
      if (r.status === 402)
        return { ok: false, detail: "Fish Audio key valid, but the account has no API credit." };
      return { ok: false, detail: `Fish Audio unreachable (HTTP ${r.status}).` };
    }

    if (provider === "livekit") {
      const url = val("LIVEKIT_URL");
      const key = val("LIVEKIT_API_KEY");
      const secret = val("LIVEKIT_API_SECRET");
      if (!url || !key || !secret)
        return { ok: false, detail: "LiveKit URL, API key, and secret are all required." };
      // Validate credentials locally by minting a room-list token and calling the API.
      const { AccessToken } = await import("livekit-server-sdk");
      const at = new AccessToken(key, secret);
      at.addGrant({ roomList: true });
      const jwt = await at.toJwt();
      // LIVEKIT_URL is normally wss:// (WebSocket); the Twirp REST API needs https://.
      const httpUrl = url
        .replace(/\/+$/, "")
        .replace(/^wss:\/\//i, "https://")
        .replace(/^ws:\/\//i, "http://");
      const r = await fetch(`${httpUrl}/twirp/livekit.RoomService/ListRooms`, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(15_000),
      });
      if (r.ok) return { ok: true, detail: "LiveKit credentials are valid." };
      if (r.status === 401 || r.status === 403)
        return { ok: false, detail: "LiveKit authentication failed. Check key and secret." };
      return { ok: false, detail: "LiveKit connection could not be established." };
    }

    return { ok: false, detail: `Unknown provider "${provider}".` };
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError")
      return { ok: false, detail: `${provider} timed out — check your internet connection.` };
    console.error(`[api/config] test ${provider} failed:`, err instanceof Error ? err.message : err);
    return { ok: false, detail: `${provider} connection failed. Check your network.` };
  }
}

/* ─────────────────────────────── handlers ─────────────────────────────── */

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!isLocalRequest(req)) {
    return res.status(403).json({ error: "Configuration is only available on localhost." });
  }

  if (req.method === "GET") {
    // BOOLEANS ONLY — never key material, never masked fragments.
    const content = readEnvLocal();
    const present = new Set(
      parseEnvLines(content)
        .filter((l) => l.key && (l.value?.length ?? 0) > 0)
        .map((l) => l.key),
    );
    const configured: Record<string, boolean> = {};
    for (const k of CONFIG_KEYS) configured[k as ConfigKey] = present.has(k) || Boolean(process.env[k]);
    return res.status(200).json({ configured, localOnly: true });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const body = (req.body ?? {}) as {
    action?: string;
    values?: Record<string, unknown>;
    keys?: unknown;
    provider?: string;
  };

  /* ---- save ---- */
  if (body.action === "save") {
    const incoming = body.values ?? {};
    if (typeof incoming !== "object" || Array.isArray(incoming)) {
      return res.status(400).json({ error: "values must be an object." });
    }
    const clean: Record<string, string> = {};
    for (const [rawKey, rawValue] of Object.entries(incoming)) {
      if (!(CONFIG_KEYS as readonly string[]).includes(rawKey)) {
        return res.status(400).json({ error: `Unknown variable "${rawKey}".` });
      }
      const value = String(rawValue ?? "").trim();
      if (!value) continue; // empty = leave untouched
      if (value.length > MAX_VALUE_LEN || /[\r\n]/.test(value)) {
        return res.status(400).json({ error: `Invalid value for ${rawKey}.` });
      }
      if (rawKey === "LIVEKIT_URL" && !/^https?:\/\//i.test(value)) {
        return res.status(400).json({ error: "LIVEKIT_URL must start with http:// or wss://." });
      }
      clean[rawKey] = value;
    }
    if (!Object.keys(clean).length) {
      return res.status(400).json({ error: "Nothing to save." });
    }
    try {
      const updated = upsertVars(readEnvLocal(), clean);
      atomicWrite(envLocalPath(), updated);
    } catch (err) {
      console.error("[api/config] save failed:", err instanceof Error ? err.message : err);
      return res.status(500).json({ error: "Could not write configuration file." });
    }
    // Secrets deliberately NOT echoed. Names only.
    return res.status(200).json({
      ok: true,
      saved: Object.keys(clean),
      message: "Configuration saved securely.",
      restartRequired: true,
    });
  }

  /* ---- reset ---- */
  if (body.action === "reset") {
    const keys = Array.isArray(body.keys) ? body.keys.map(String) : [];
    if (!keys.length) return res.status(400).json({ error: "keys required." });
    for (const k of keys) {
      if (!(CONFIG_KEYS as readonly string[]).includes(k)) {
        return res.status(400).json({ error: `Unknown variable "${k}".` });
      }
    }
    try {
      const updated = removeVars(readEnvLocal(), keys);
      atomicWrite(envLocalPath(), updated);
    } catch (err) {
      console.error("[api/config] reset failed:", err instanceof Error ? err.message : err);
      return res.status(500).json({ error: "Could not write configuration file." });
    }
    return res.status(200).json({ ok: true, cleared: keys, restartRequired: true });
  }

  /* ---- test (async handler body) ---- */
  if (body.action === "test") {
    const provider = String(body.provider ?? "");
    return testProvider(provider).then((result) => res.status(200).json(result));
  }

  return res.status(400).json({ error: "Unknown action." });
}
