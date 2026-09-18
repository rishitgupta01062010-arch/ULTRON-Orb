# ULTRON Orb UI

An Iron Man–inspired holographic orb built with **Next.js**, **Three.js**, and **MediaPipe** hand tracking — control it with your bare hands through your webcam.

> 🔮 This is the open-source **interface** of [ULTRON](https://sagartamang.com/projects/ultron) — my AI that talks in real time and controls Android devices by itself. **[Read the write-up](https://sagartamang.com/projects/ultron)** or **[the X post](https://x.com/sagar_builds/status/2077277583646101921)**

> 📱 **[Watch the demo on Instagram](https://www.instagram.com/p/DayJ17OTwvx/)**

![ULTRON orb UI](docs/screenshot.png)

https://github.com/user-attachments/assets/91578a83-9a27-44e8-84b0-96defcfd7366

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Controls

### Mouse / touch

| Input | Action |
| --- | --- |
| Drag | Spin the orb |
| Scroll / pinch | Zoom in & out |

### Hand gestures (webcam)

Click **GESTURES OFF** (or press `G`) and allow camera access, then:

| Gesture | Action |
| --- | --- |
| Pinch (thumb + index) one hand and move it | Spin the orb |
| Pinch with **both** hands, spread apart / bring together | Zoom in / out |

### Keyboard

| Key | Action |
| --- | --- |
| `G` | Toggle hand gestures |
| `R` | Reset the view |
| `+` / `−` | Zoom in / out |

### Voice

| Input | Action |
| --- | --- |
| Say **"ultron"** | Unlock the system (wake word — the only accepted word) |
| 👏👏 Double clap | Alternative unlock |
| Any question (unlocked) | ULTRON answers out loud — no button needed |
| "Stop" / "Continue" | Pause / resume ULTRON mid-answer |
| `L` | Re-lock the system |

## Voice onboarding & tuning

### Permission onboarding (first launch)

The first time the app runs, a terminal-style overlay asks for **microphone** and
camera access **before** the browser prompts appear — with a plain explanation of
what each permission is used for:

- **Microphone** — wake word detection, voice questions, and clap unlock.
- **Camera** — hand-gesture control of the orb (optional; you can skip it).

If a permission was previously denied, the overlay detects it and shows a
step-by-step guide to unblock it in the browser's site settings, with a
**RETRY** button — so a mis-click never permanently breaks voice. The overlay
only appears once; granted states are remembered in `localStorage`.

### Voice settings panel

Open with the **🎚 VOICE** button in the HUD to calibrate the mic to your room:

| Control | What it does |
| --- | --- |
| **Live mic meter** | Real-time level bar with the noise-gate threshold marker — speak and watch your voice clear the line |
| **Wake sensitivity** | How eagerly short utterances are accepted as questions (high = snappy, low = only longer, confident speech). The word *"ultron"* is always exact-match regardless |
| **Noise gate** | Energy floor for the mic — fans, music, and room rumble below the line are dropped before recognition ever sees them (kills false wakes) |
| **Clap threshold** | Sensitivity of the double-clap detector |

All settings persist in `localStorage` and can be restored with **RESET DEFAULTS**.

## How it works

- **`lib/orbScene.ts`** — the Three.js scene: layered wireframe shells, a spiral
  inner core, floating code-text sprites, orbiting debris, dust particles, scan
  rings, and a bloom + chromatic-aberration post-processing stack.
- **`lib/handTracker.ts`** — MediaPipe HandLandmarker running on the webcam
  feed. Pinch detection with hysteresis: one pinched hand spins the orb, two
  pinched hands zoom by spreading apart or together.
- **`components/JarvisOrb.tsx`** — the HUD and glue between the scene, the
  tracker, and your inputs.

## License

MIT
