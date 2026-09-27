# Future Architecture: Android Device Agent (Redmi 9 Power)

> **Status: DESIGN ONLY — intentionally not implemented yet.**
> This document prepares the architecture so phone control can be added later
> safely. No phone-control code, endpoints, or ADB bridging exists today.

## Vision

```
Ultron Laptop (voice / chat / intents)
        ↓
Ultron Backend (Next.js server on the laptop)
        ↓
Android Device Agent (small app ON the Redmi 9 Power)
        ↓
Redmi 9 Power (Gmail, YouTube, camera, settings, app launching)
```

## Core security principles (non-negotiable when built)

1. **Paired, authenticated connection** — the phone agent and the laptop
   exchange a pairing token over the **local network only** (mDNS/DNS-SD
   discovery, no public internet exposure). No port forwarding, no tunnels.
2. **The phone pulls, never pushes** — the Android agent runs a minimal
   listener that only accepts commands signed with the pairing token; the
   laptop backend never exposes the phone to the internet.
3. **Explicit permission grants** — each capability (open app, send email,
   take photo, change setting) is individually authorized on the phone the
   first time, revocable in the agent's settings.
4. **No arbitrary shell/ADB** — commands are a fixed, allowlisted intent set
   validated on-device. No `adb shell` passthrough, no arbitrary URLs.
5. **Audit log** — every command the phone executes is logged and visible in
   ULTRON's activity UI.

## Planned capability surface (allowlisted intents)

| Intent | Example | Android mechanism (future) |
| --- | --- | --- |
| `open_app` | "open YouTube on my phone" | explicit intent / launch intent |
| `open_url` | "open this video" | `ACTION_VIEW` (validated https only) |
| `compose_email` | "write an email to…" | `ACTION_SENDTO` (draft only, user presses send) |
| `take_photo` | "take a picture" | CameraX via a foreground service |
| `read_notifications` | "what's on my phone?" | NotificationListener permission |
| `set_setting` | "turn on flashlight" | permitted Settings toggles only |

## When we build it

1. Android agent app (Kotlin) with pairing + permission screens.
2. `lib/phone/` on the laptop: typed client for the allowlisted intents.
3. ULTRON intent router gains a `phone.*` tool family gated behind a
   confirmation prompt (medium risk: launching apps; high risk: anything that
   sends data off the device).
4. Nothing in this design requires changing the orb, voice, or agent core.
