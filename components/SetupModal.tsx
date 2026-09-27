"use client";

/**
 * SetupModal — first-run "Ultron Orb Setup" for local API keys.
 *
 * Security posture (mirrors /api/config):
 *   • Submits keys once via POST /api/config/save (localhost-only endpoint).
 *   • Never receives, stores, or displays key material again — the modal reads
 *     BOOLEANS from GET /api/config and shows masked status chips only.
 *   • Password-style inputs with per-field show/hide; no autocomplete leakage.
 *   • Reset clears only the allowlisted variables via POST /api/config/reset.
 *   • "Test connection" asks the server to verify one provider with its
 *     stored key — the key itself never travels back to the browser.
 */

import { useCallback, useEffect, useState } from "react";

type Field = {
  key: string;
  label: string;
  hint: string;
  placeholder: string;
  secret: boolean;
};

/** Mirrors CONFIG_KEYS in pages/api/config.ts — UI metadata only. */
const FIELDS: Field[] = [
  { key: "GEMINI_API_KEY", label: "Gemini API key", hint: "Primary AI brain — aistudio.google.com/apikey", placeholder: "AIza…", secret: true },
  { key: "GROQ_API_KEY", label: "Groq API key", hint: "Fast fallback brain + Orpheus voice — console.groq.com/keys", placeholder: "gsk_…", secret: true },
  { key: "OPENROUTER_API_KEY", label: "OpenRouter API key", hint: "Last-resort fallback — openrouter.ai/keys", placeholder: "sk-or-…", secret: true },
  { key: "FISH_AUDIO_API_KEY", label: "Fish Audio API key", hint: "Ultron's premium voice — fish.audio", placeholder: "fa-…", secret: true },
  { key: "FISH_AUDIO_VOICE_ID", label: "Fish Audio voice ID", hint: "Optional — which voice model to use", placeholder: "voice id", secret: false },
  { key: "LIVEKIT_URL", label: "LiveKit URL", hint: "Optional LIVE mode — wss://your-project.livekit.cloud", placeholder: "wss://…", secret: false },
  { key: "LIVEKIT_API_KEY", label: "LiveKit API key", hint: "From cloud.livekit.io → settings → keys", placeholder: "API key", secret: true },
  { key: "LIVEKIT_API_SECRET", label: "LiveKit API secret", hint: "Kept server-side, never leaves this machine", placeholder: "API secret", secret: true },
];

const SECRET_KEYS = new Set(["GEMINI_API_KEY", "GROQ_API_KEY", "OPENROUTER_API_KEY", "FISH_AUDIO_API_KEY", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"]);

const TEST_PROVIDERS: { id: string; label: string; needs: string[] }[] = [
  { id: "gemini", label: "Gemini", needs: ["GEMINI_API_KEY"] },
  { id: "groq", label: "Groq", needs: ["GROQ_API_KEY"] },
  { id: "openrouter", label: "OpenRouter", needs: ["OPENROUTER_API_KEY"] },
  { id: "fish", label: "Fish Audio", needs: ["FISH_AUDIO_API_KEY"] },
  { id: "livekit", label: "LiveKit", needs: ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"] },
];

export default function SetupModal({ onClose }: { onClose: () => void }) {
  const [configured, setConfigured] = useState<Record<string, boolean>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [show, setShow] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ kind: "idle" | "ok" | "err"; text: string }>({ kind: "idle", text: "" });
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; detail: string }>>({});
  const [loaded, setLoaded] = useState(false);

  const refreshStatus = useCallback(async () => {
    try {
      const r = await fetch("/api/config", { cache: "no-store" });
      if (r.ok) {
        const d = (await r.json()) as { configured: Record<string, boolean> };
        setConfigured(d.configured ?? {});
      }
    } catch {
      /* server unreachable — leave empty; save attempts will surface errors */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const anyConfigured = Object.values(configured).some(Boolean);

  async function save() {
    const filled = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim() !== ""));
    if (!Object.keys(filled).length) {
      setStatus({ kind: "err", text: "Enter at least one key first." });
      return;
    }
    setSaving(true);
    setStatus({ kind: "idle", text: "" });
    try {
      const r = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", values: filled }),
      });
      const d = (await r.json()) as { ok?: boolean; message?: string; error?: string };
      if (r.ok && d.ok) {
        setStatus({ kind: "ok", text: `${d.message ?? "Configuration saved securely."} Restart the server to load new keys.` });
        setValues({}); // wipe typed secrets from React state immediately
        await refreshStatus();
      } else {
        setStatus({ kind: "err", text: d.error ?? "Save failed." });
      }
    } catch {
      setStatus({ kind: "err", text: "Could not reach the local server." });
    } finally {
      setSaving(false);
    }
  }

  async function test(provider: string) {
    setTesting(provider);
    try {
      const r = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test", provider }),
      });
      const d = (await r.json()) as { ok: boolean; detail: string };
      setTestResult((prev) => ({ ...prev, [provider]: d }));
    } catch {
      setTestResult((prev) => ({ ...prev, [provider]: { ok: false, detail: "Could not reach the local server." } }));
    } finally {
      setTesting(null);
    }
  }

  async function resetKeys(keys: string[]) {
    if (!keys.length) return;
    const label = keys.length === 1 ? keys[0] : `${keys.length} keys`;
    if (!window.confirm(`Remove ${label} from .env.local? This cannot be undone.`)) return;
    try {
      const r = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset", keys }),
      });
      const d = (await r.json()) as { ok?: boolean; error?: string };
      if (r.ok && d.ok) {
        setStatus({ kind: "ok", text: `Cleared ${label}. Restart the server to apply.` });
        await refreshStatus();
      } else {
        setStatus({ kind: "err", text: d.error ?? "Reset failed." });
      }
    } catch {
      setStatus({ kind: "err", text: "Could not reach the local server." });
    }
  }

  return (
    <div className="setup-overlay" role="dialog" aria-modal="true" aria-label="Ultron Orb Setup">
      <div className="setup-modal">
        <header className="setup-head">
          <h2>ULTRON ORB SETUP</h2>
          <p className="setup-sub">
            Local configuration — keys are written to <code>.env.local</code> on this machine only,
            submitted once, and never sent back to the browser.
          </p>
          <button type="button" className="setup-close" onClick={onClose} aria-label="Close setup">
            ✕
          </button>
        </header>

        {!loaded ? (
          <p className="setup-loading">Reading configuration…</p>
        ) : anyConfigured ? (
          <p className="setup-note">
            <span className="dot dot-ok" /> Configuration detected — leave a field empty to keep its
            stored value. Type in a field to replace it.
          </p>
        ) : (
          <p className="setup-note">
            <span className="dot dot-idle" /> No keys configured yet. ULTRON runs without them; add
            one to wake up the AI brain.
          </p>
        )}

        <div className="setup-grid">
          {FIELDS.map((f) => (
            <label key={f.key} className="setup-field">
              <span className="setup-label">
                {f.label}
                {configured[f.key] && <em className="chip chip-ok" title="Configured">● set</em>}
                {!configured[f.key] && SECRET_KEYS.has(f.key) && <em className="chip chip-missing" title="Not configured">○ unset</em>}
              </span>
              <span className="setup-input-row">
                <input
                  type={f.secret && !show[f.key] ? "password" : "text"}
                  value={values[f.key] ?? ""}
                  placeholder={configured[f.key] ? "•••••••• (stored)" : f.placeholder}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                />
                {f.secret && (
                  <button
                    type="button"
                    className="setup-eye"
                    aria-label={show[f.key] ? "Hide key" : "Show key"}
                    onClick={() => setShow((s) => ({ ...s, [f.key]: !s[f.key] }))}
                  >
                    {show[f.key] ? "🙈" : "👁"}
                  </button>
                )}
              </span>
              <span className="setup-hint">{f.hint}</span>
            </label>
          ))}
        </div>

        {status.kind !== "idle" && (
          <p className={`setup-status ${status.kind === "ok" ? "is-ok" : "is-err"}`} role="status">
            {status.text}
          </p>
        )}

        <div className="setup-actions">
          <button type="button" className="hud-btn setup-primary" disabled={saving} onClick={save}>
            {saving ? "SAVING…" : "SAVE CONFIGURATION"}
          </button>
          <button
            type="button"
            className="hud-btn"
            onClick={() => resetKeys(Object.keys(configured).filter((k) => configured[k]))}
          >
            CLEAR ALL
          </button>
          <button type="button" className="hud-btn" onClick={onClose}>
            DONE
          </button>
        </div>

        <details className="setup-tests">
          <summary>Test connections</summary>
          <div className="setup-test-row">
            {TEST_PROVIDERS.map((p) => {
              const ready = p.needs.every((k) => configured[k]);
              const res = testResult[p.id];
              return (
                <div key={p.id} className="setup-test">
                  <button
                    type="button"
                    className="hud-btn hud-btn-sm"
                    disabled={!ready || testing === p.id}
                    title={ready ? `Verify ${p.label}` : `${p.label} is not configured`}
                    onClick={() => test(p.id)}
                  >
                    {testing === p.id ? "…" : `TEST ${p.label.toUpperCase()}`}
                  </button>
                  {res && (
                    <span className={res.ok ? "test-ok" : "test-err"}>
                      {res.ok ? "✓ " : "✕ "}
                      {res.detail}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </details>
      </div>
    </div>
  );
}
