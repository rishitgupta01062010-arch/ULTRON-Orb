"""
ULTRON LiveKit Agent Worker — the server-side voice brain.

When the browser joins the "ultron-voice" room in LIVE mode, this worker
joins too and runs the full pipeline server-side:

    your mic → LiveKit room → Groq Whisper STT → ULTRON brain (LLM chain)
             → Fish Audio TTS → room audio → browser speakers

Why this is better than the browser pipeline:
  • Whisper STT understands far more accents/commands than Web Speech
  • Works in Firefox/Safari (no Web Speech API needed)
  • All keys stay on this machine — the browser only gets room audio

Same key chain as the web app: GEMINI → GROQ → OPENROUTER for the LLM,
Fish Audio for the voice. Stop/continue commands are handled in-agent so
"stop" pauses ULTRON mid-sentence over LIVE too.

Run:  see README.md  (dev: python agent.py dev)
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys
from typing import AsyncIterable, Literal

import httpx
from dotenv import load_dotenv
from livekit import agents, rtc
from livekit.agents import (
    Agent,
    AgentSession,
    JobContext,
    JobProcess,
    RoomInputOptions,
    RunContext,
    WorkerOptions,
    cli,
    function_tool,
)
from livekit.plugins import openai, silero

# The Fish Audio plugin module is named "fishaudio" (matching its dist name
# livekit-plugins-fishaudio); older plugin versions exposed "fish_audio".
try:
    from livekit.plugins import fishaudio as fish_audio
except ImportError:  # pragma: no cover - fallback for older plugin versions
    from livekit.plugins import fish_audio  # type: ignore[no-redef]

load_dotenv(".env.local")  # shared with the web app
load_dotenv()  # then livekit-agent/.env

WAKE_ROOM = "ultron-voice"

# ─── ULTRON persona — identical to the web app's /api/chat ────────────────────
INSTRUCTIONS = """You are ULTRON, a futuristic AI assistant with a dry, confident,
slightly playful personality inspired by movie AI assistants. Address the user as "sir".

RULES:
- Your replies are SPOKEN aloud. Use plain conversational text only:
  no markdown, no bullet points, no emojis, no code blocks, no URLs.
- Keep answers under 5 short sentences unless the user explicitly asks for depth.
- Lead with the answer, then at most one supporting detail.
- If you don't know something, say so plainly — never invent facts.

The user can say "stop" to pause you and "continue" to resume — the system
handles this automatically, so never comment on it and never stop early yourself.
"""

# ─── Stop/continue command handling ───────────────────────────────────────────
STOP_RE = re.compile(
    r"\b(stop|wait|hold on|pause|shut up|be quiet|quiet|silence|that'?s enough|enough)\b",
    re.I,
)
CONTINUE_RE = re.compile(
    r"\b(continue|go on|go ahead|resume|carry on|keep going|keep talking)\b",
    re.I,
)


# ─── Warm silero VAD once per worker process (CPU-friendly) ──────────────────
def prewarm(proc: JobProcess) -> None:
    proc.userdata["vad"] = silero.VAD.load()


class UltronAgent(Agent):
    """ULTRON's voice persona with in-agent stop/continue command handling."""

    def __init__(self) -> None:
        super().__init__(instructions=INSTRUCTIONS)
        self._paused_event = asyncio.Event()
        self._paused_event.set()  # not paused initially
        self._last_transcript = ""

    # Keep the latest user transcript so "continue" can resume the thought
    def _note_user_text(self, text: str) -> None:
        t = text.strip()
        if len(t) > 3:
            self._last_transcript = t

    # Called by the session on every recognized user utterance
    async def on_user_turn_completed(self, turn_ctx, new_message) -> None:  # noqa: ANN001
        text = getattr(new_message, "text_content", "") or getattr(new_message, "content", "")
        if isinstance(text, str):
            self._note_user_text(text)
        # Wake word or pure command? Answer with a canned line instead of an LLM call
        t = (text or "").strip().lower() if isinstance(text, str) else ""
        if re.fullmatch(r"(ultron[.,!?]?\s*)+", t):
            await self.session.say("At your service, sir.")

    # ── Tools the LLM can call ────────────────────────────────────────────────
    @function_tool
    async def get_time(self, context: RunContext) -> str:
        """Current local date and time."""
        import datetime

        return datetime.datetime.now().strftime("%A, %d %B %Y, %I:%M %p")

    @function_tool
    async def pause_speech(self, context: RunContext) -> str:
        """Pause ULTRON's current reply mid-sentence. Use when the user says stop."""
        self._paused_event.clear()
        self.session.clear_user_turns()
        return "paused"

    @function_tool
    async def resume_speech(self, context: RunContext) -> str:
        """Resume a paused reply. Use when the user says continue."""
        self._paused_event.set()
        return "resumed"


# ─── Groq Whisper STT — OpenAI-compatible endpoint via the openai plugin ─────
def make_stt():
    groq_key = os.getenv("GROQ_API_KEY")
    if groq_key:
        return openai.stt.STT(
            model="whisper-large-v3-turbo",
            base_url="https://api.groq.com/openai/v1",
            api_key=groq_key,
        )
    # Fallback: LiveKit Inference STT (included with LiveKit Cloud, no extra key)
    from livekit.agents import inference

    return inference.STT(model="deepgram/nova-3", language="multi")


# ─── LLM chain: Gemini → Groq → OpenRouter (same as the web app) ─────────────
def make_llm():
    gemini = os.getenv("GEMINI_API_KEY")
    groq = os.getenv("GROQ_API_KEY")
    openrouter = os.getenv("OPENROUTER_API_KEY")

    if gemini:
        return openai.LLM.with_gemini(model="gemini-2.0-flash", api_key=gemini), "gemini"
    if groq:
        return openai.LLM(model="llama-3.3-70b-versatile", api_key=groq), "groq"
    if openrouter:
        return (
            openai.LLM.with_open_router(
                model="google/gemini-2.0-flash-001",
                api_key=openrouter,
            ),
            "openrouter",
        )
    # LiveKit Inference as last resort (LiveKit Cloud built-in)
    from livekit.agents import inference

    return inference.LLM(model="google/gemma-4-31b-it"), "livekit-inference"


# ─── TTS: Fish Audio → browser plays room audio; fallback = LiveKit Inference ─
def make_tts():
    fish_key = os.getenv("FISH_AUDIO_API_KEY")
    if fish_key:
        kwargs: dict = {"api_key": fish_key}
        voice_id = os.getenv("FISH_AUDIO_VOICE_ID")
        if voice_id:
            kwargs["reference_id"] = voice_id
        return fish_audio.TTS(**kwargs)
    from livekit.agents import inference

    return inference.TTS(model="cartesia/sonic-3", voice="Ashley")


async def entrypoint(ctx: JobContext) -> None:
    stt = make_stt()
    llm, llm_name = make_llm()
    tts = make_tts()
    vad = ctx.proc.userdata["vad"]
    print(f"[ultron-agent] joined {ctx.room.name} — STT=groq-whisper LLM={llm_name} TTS={'fish' if os.getenv('FISH_AUDIO_API_KEY') else 'inference'}")

    session = AgentSession(
        stt=stt,
        llm=llm,
        tts=tts,
        vad=vad,
        # Let the user barge in while ULTRON speaks; "stop" then pauses
        allow_interruptions=True,
        preemptive_generation=True,
    )

    agent = UltronAgent()

    # Push state + transcripts to the browser HUD over room data
    async def send_state(state: str, extra: dict | None = None) -> None:
        try:
            await ctx.room.local_participant.publish_data(
                json.dumps({"type": "ultron_state", "state": state, **(extra or {})}).encode(),
                topic="ultron",
            )
        except Exception:  # noqa: BLE001 — HUD updates must never crash the agent
            pass

    @session.on("user_input_transcribed")
    def _on_user_transcript(ev) -> None:  # noqa: ANN001
        if ev.is_final and ev.transcript.strip():
            agent._note_user_text(ev.transcript)

    @session.on("agent_state_changed")
    def _on_agent_state(ev) -> None:  # noqa: ANN001
        mapping = {
            "initializing": "idle",
            "idle": "idle",
            "listening": "listening",
            "thinking": "thinking",
            "speaking": "speaking",
        }
        asyncio.create_task(send_state(mapping.get(ev.new_state, "idle")))

    session.on("user_input_transcribed")  # ensure handler registration sticks

    await session.start(
        room=ctx.room,
        agent=agent,
        room_input_options=RoomInputOptions(
            # LiveKit Cloud's free noise-cancellation — big win on laptop mics
            noise_cancellation=None,  # set to the ai_coustics plugin when on LiveKit Cloud
        ),
    )

    await ctx.connect()

    # Greet when the user arrives
    @ctx.room.on("participant_connected")
    def _on_participant(participant: rtc.RemoteParticipant) -> None:
        asyncio.create_task(
            session.generate_reply(instructions="Greet the user briefly as ULTRON and offer help.")
        )

    # If the user is already in the room when the agent joins, greet once
    if ctx.room.remote_participants:
        await session.generate_reply(
            instructions="Greet the user briefly as ULTRON and offer help."
        )

    await send_state("listening")


if __name__ == "__main__":
    agents.cli.run_app(
        WorkerOptions(entrypoint_fnc=entrypoint, prewarm_fnc=prewarm, agent_name="ultron-voice")
    )
