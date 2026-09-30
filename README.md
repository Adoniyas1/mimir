# Mimir

A desktop AI assistant with an animated face, an offline wake word, and one
genuinely unusual capability: it can read, propose, and apply changes to its
own source code, then restart into the new version — safely, with automatic
rollback if anything breaks.

Runs on macOS and Windows. No hardware required.

## Quick start

```bash
npm install
npm run build
npm run electron
```

On first launch, open Settings (⚙, top right) and:

1. **Brain** — pick a provider and add credentials:
   - **Claude (Anthropic)** — paste an API key from console.anthropic.com. This is
     the default and the only provider currently able to drive self-editing
     reliably out of the box (see "Modular brain" below).
   - **Local model (Ollama)** — install [Ollama](https://ollama.com), pull a
     model (`ollama pull llama3.1:8b`), and just point Mimir at it. No key needed.
   - **Your own server / VPS** — any OpenAI-compatible endpoint (vLLM,
     text-generation-webui, llama.cpp server). Set the base URL and, if it
     needs one, an API key.
2. **Voice** (optional) — wake word needs a free Picovoice AccessKey from
   console.picovoice.ai, *and* a custom "Mimir" keyword file trained in that
   same console, dropped at `resources/wake-word/mimir_mac.ppn` (or
   `mimir_windows.ppn`). Without either, wake word is simply disabled and
   push-to-talk (the mic button) still works fully offline via local Whisper.

## Modular brain

Every place in the app that talks to "the model" goes through one interface
(`src/main/brain/Provider.ts`). Three implementations exist today —
Anthropic, Ollama, and a generic OpenAI-compatible client for your own VPS —
and switching between them is a Settings action, not a rebuild. A provider
that can't do native tool-calling is transparently wrapped so it can still
use Mimir's tools via a prompt-based fallback (`src/main/brain/reactShim.ts`);
self-editing specifically stays gated to providers that report real
tool-calling support, so a weak local model degrades to "assistant that
can't edit itself" rather than a silently unsafe agent.

## How self-editing works

See the full design in [the plan](../../.claude/plans/) or read
`src/main/self-edit/transaction.ts` — the short version:

- Mimir's editable source lives in a **workspace** copy under
  `~/.mimir/workspace` (never the original install), tracked by its own git repo.
- Every edit is a transaction: checkpoint → write → typecheck/test → commit,
  or on any failure, `git reset --hard` back to the checkpoint. Nothing
  partially-applied ever survives.
- "Skill" edits (new files under `skills/`) apply immediately after a fast
  typecheck. "Core" edits (anything under `src/main` or `src/renderer`) need
  a full verify pass and — unless you've turned on auto-approve — your
  explicit sign-off in the UI before Mimir restarts into them.
- A tiny **immutable entry point** (`electron-entry.mjs`, never part of the
  editable workspace) decides which build to actually launch, and reverts to
  the original install automatically after 3 consecutive failed boots. See
  `supervisor/` for the same logic as a standalone watchdog.
- Every applied edit is in an audit log you can browse and one-click revert.

## Development

```bash
npm run typecheck   # main + renderer + supervisor
npm test            # transaction engine + boot-policy unit tests
npm run dev:renderer  # Vite dev server, then set MIMIR_DEV_SERVER_URL and run electron
```

## Packaging

```bash
npm run package:mac   # -> dist-installers/*.dmg
npm run package:win   # -> dist-installers/*.exe (run on/cross-compiled for Windows)
```
# mimir
