# ULTRON LiveKit Agent Worker

ULTRON's **server-side voice brain**. When you click **LIVE ON** in the web app,
the browser joins the `ultron-voice` LiveKit room, and this worker joins too and
runs the whole pipeline on this machine:

```
your mic → LiveKit room → Groq Whisper STT → LLM chain → Fish Audio TTS
         → room audio → your speakers
```

## Why LIVE mode is better than the browser voice

| | Browser (Web Speech) | LIVE (this worker) |
|---|---|---|
| STT accuracy | Browser-dependent | **Groq Whisper large-v3-turbo** |
| Firefox/Safari | ❌ no recognition | ✅ works |
| Accents / background noise | hit-or-miss | far stronger |
| Voice quality | Fish Audio if configured | **Fish Audio server-side** |
| Latency after first word | sentence-by-sentence | word-by-word streaming |

## Setup (one-time)

```bash
cd livekit-agent

# 1) Python 3.10+ and uv (https://docs.astral.sh/uv/)
uv sync

# 2) Credentials — the worker reads ../.env.local first, so if the web app
#    already has your keys, you only need the LiveKit three.
#    Free project → https://cloud.livekit.io
cp .env.example .env    # then fill LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET
```

## Run

```bash
uv run agent.py dev        # dev mode — connects to your LiveKit project
```

Then in the web app: unlock ULTRON → click **LIVE ON** → `ULTRON AGENT: IN ROOM`
appears in the HUD → just talk. "stop" / "continue" work over LIVE too.

## How it works

- `agent.py` — the `AgentSession`: Groq Whisper STT → Gemini/Groq/OpenRouter
  LLM chain (same order as the web app) → Fish Audio TTS. Silero VAD handles
  turn detection; interruptions are allowed so "stop" lands mid-sentence.
- Dispatch: the worker registers under `agent_name="ultron-voice"`. For local
  dev the agent joins the room when the app requests an explicit dispatch via
  `/api/livekit`; on LiveKit Cloud you can also set *automatic* agent dispatch
  in the project settings.
- State broadcasting: every state change is published as room data
  (`{"type": "ultron_state", ...}`) so the web HUD mirrors the agent live.
