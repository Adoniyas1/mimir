import React, { useEffect, useRef, useState } from "react";
import Face from "./Face.js";
import Chat from "./Chat.js";
import Settings from "./Settings.js";
import QuickControls from "./QuickControls.js";
import SkillTree from "./SkillTree.js";
import { preloadTranscriber, transcribeSamples, VoiceRecorder } from "./voice/stt.js";
import type { AutoStopReason } from "./voice/vad.js";
import { sanitizeSpeech, takeCompleteSentences } from "./voice/speech.js";
import { OpenMicController } from "./voice/openMic.js";
import { fileToAttachment } from "./attachments.js";
import { pythonRuntime } from "./python/pythonRuntime.js";
import { searchProjectFiles } from "./search/projectSearch.js";
import type { Attachment, ChatMessage, FaceState, PendingEdit } from "../shared/types.js";

function newId(): string {
  return crypto.randomUUID();
}

const OPEN_MIC_ECHO_GUARD_MS = 1_500;

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: newId(),
      role: "assistant",
      text: "I'm Mimir. Ask me anything, or tell me to change how I work — I can edit my own code.",
      createdAt: Date.now()
    }
  ]);
  const [pendingEdit, setPendingEdit] = useState<PendingEdit | null>(null);
  const [faceState, setFaceState] = useState<FaceState>("idle");
  const [busy, setBusy] = useState(false);
  const [, setListening] = useState(false);
  const [openMicActive, setOpenMicActive] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showSkills, setShowSkills] = useState(false);

  const assistantMessageId = useRef<string | null>(null);
  const voiceOrigin = useRef(false);
  const recorder = useRef<VoiceRecorder | null>(null);
  // State updates reach the next render asynchronously; this ref is the
  // immediate guard shared by wake-word, follow-up, and mic-button paths.
  const listeningRef = useRef(false);
  const busyRef = useRef(false);
  const openMicEnabled = useRef(false);
  const openMic = useRef<OpenMicController | null>(null);
  const speechBuffer = useRef("");
  const speechQueue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    // Only warm the (memory-heavy, WASM) Whisper model eagerly if wake word
    // is on — that means the user actually wants low-latency voice. Text-
    // only sessions load it lazily on first real mic use instead, so an
    // 8GB machine isn't holding a speech model in RAM for no reason.
    void window.mimir.voice.getConfig().then((cfg) => {
      if (cfg.wakeWordEnabled || cfg.openMicEnabled) preloadTranscriber();
      if (cfg.openMicEnabled) void setOpenMicEnabled(true);
    });

    const offFace = window.mimir.face.onState((state) => setFaceState(state));
    const offStream = window.mimir.chat.onStream((event) => {
      if (event.type === "text-delta") {
        setMessages((prev) => appendToAssistant(prev, assistantMessageId, event.text));
        if (voiceOrigin.current) {
          const { chunks, remainder } = takeCompleteSentences(speechBuffer.current + event.text);
          speechBuffer.current = remainder;
          for (const chunk of chunks) enqueueSpeech(chunk);
        }
      } else if (event.type === "image") {
        // Shown directly in the assistant's bubble, never sent back to the
        // model — see the "image" ChatStreamEvent doc comment.
        setMessages((prev) => appendToAssistant(prev, assistantMessageId, `\n![plot](${event.dataUrl})\n`));
      } else if (event.type === "edit-pending") {
        setPendingEdit(event.pending);
      } else if (event.type === "error") {
        setBusy(false);
        busyRef.current = false;
        setMessages((prev) => [
          ...prev,
          { id: newId(), role: "system", text: `⚠️ ${event.message}`, createdAt: Date.now() }
        ]);
      } else if (event.type === "turn-done") {
        setBusy(false);
        busyRef.current = false;
        assistantMessageId.current = null;
        if (voiceOrigin.current && event.fullText.trim()) {
          const finalSpeech = enqueueSpeech(speechBuffer.current);
          speechBuffer.current = "";
          void finalSpeech.then(resumeAfterVoiceReply, resumeAfterVoiceReply);
        } else if (voiceOrigin.current) {
          void maybeStartFollowUpListening();
        }
        voiceOrigin.current = false;
      }
      // tool-start / tool-end are surfaced via faceState "thinking" already;
      // intentionally not rendered as chat bubbles to keep the transcript readable.
    });

    const offWake = window.mimir.voice.onWakeTriggered(() => {
      void startVoiceTurn();
    });
    const offHotkey = window.mimir.voice.onHotkeyTriggered(() => {
      void handleMicToggle();
    });
    const offPython = window.mimir.python.onRunRequest((req) => {
      if ("reset" in req) {
        pythonRuntime.reset();
        return;
      }
      void pythonRuntime
        .run(req.code, req.args, req.capabilities)
        .then((result) => window.mimir.python.sendResult(req.id, result));
    });
    const offSearch = window.mimir.search.onSearchRequest((req) => {
      void searchProjectFiles(req.query, req.corpus, req.topK).then((hits) =>
        window.mimir.search.sendResult(req.id, hits)
      );
    });

    return () => {
      offFace();
      offStream();
      offWake();
      offHotkey();
      offPython();
      offSearch();
      void openMic.current?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function maybeStartFollowUpListening() {
    if (openMicEnabled.current) {
      await openMic.current?.start();
      return;
    }
    const cfg = await window.mimir.voice.getConfig();
    if (cfg.followUpListenSeconds > 0) {
      void startVoiceTurn({ noSpeechTimeoutMs: cfg.followUpListenSeconds * 1000 });
    }
  }

  async function resumeAfterVoiceReply() {
    // `say` can finish just before the room stops carrying its sound. Keep
    // the mic closed briefly so Open Mic does not transcribe Mimir itself.
    await new Promise<void>((resolve) => window.setTimeout(resolve, OPEN_MIC_ECHO_GUARD_MS));
    if (!busyRef.current) await maybeStartFollowUpListening();
  }

  function enqueueSpeech(text: string): Promise<void> {
    const cleanText = sanitizeSpeech(text);
    if (!cleanText) return speechQueue.current;

    // A request must finish before the next begins: this prevents sentence
    // chunks from overlapping and makes the final follow-up window reliable.
    speechQueue.current = speechQueue.current.catch(() => undefined).then(() => window.mimir.chat.speak(cleanText));
    return speechQueue.current;
  }

  async function handleSend(text: string, viaVoice = false, files?: File[]) {
    let attachments: Attachment[] | undefined;
    if (files && files.length > 0) {
      try {
        attachments = await Promise.all(files.map(fileToAttachment));
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          {
            id: newId(),
            role: "system",
            text: `⚠️ ${err instanceof Error ? err.message : String(err)}`,
            createdAt: Date.now()
          }
        ]);
        return;
      }
    }

    voiceOrigin.current = viaVoice;
    speechBuffer.current = "";
    busyRef.current = true;
    setPendingEdit(null);
    setBusy(true);
    const displayText = attachments?.length
      ? `${text}${text ? "\n" : ""}📎 ${attachments.map((a) => a.name).join(", ")}`
      : text;
    setMessages((prev) => [...prev, { id: newId(), role: "user", text: displayText, createdAt: Date.now() }]);
    const id = newId();
    assistantMessageId.current = id;
    setMessages((prev) => [...prev, { id, role: "assistant", text: "", createdAt: Date.now() }]);
    window.mimir.chat.send(text, attachments);
  }

  async function setOpenMicEnabled(enabled: boolean) {
    openMicEnabled.current = enabled;
    setOpenMicActive(enabled);
    if (!enabled) {
      await openMic.current?.pause();
      setListening(false);
      if (!busyRef.current) setFaceState("idle");
      return;
    }

    if (!openMic.current) {
      openMic.current = new OpenMicController({
        onSpeechStart: () => {
          if (openMicEnabled.current && !busyRef.current) {
            setListening(true);
            setFaceState("listening");
          }
        },
        onSpeechEnd: (audio) => {
          void handleOpenMicSegment(audio);
        },
        onError: (error) => {
          console.error("[mimir] open mic failed:", error);
          setListening(false);
          setFaceState("error");
        }
      });
    }
    preloadTranscriber();
    await openMic.current.start();
  }

  async function handleOpenMicSegment(audio: Float32Array) {
    setListening(false);
    if (!openMicEnabled.current || busyRef.current) return;
    await openMic.current?.pause();
    setFaceState("thinking");
    try {
      const text = await transcribeSamples(audio);
      if (text) handleSend(text, true);
      else {
        setFaceState("idle");
        await openMic.current?.start();
      }
    } catch (error) {
      console.error("[mimir] open mic transcription failed:", error);
      setFaceState("idle");
      await openMic.current?.start();
    }
  }

  async function startVoiceTurn(opts?: { noSpeechTimeoutMs?: number }) {
    if (listeningRef.current) return;
    listeningRef.current = true;
    setListening(true);
    setFaceState("listening");
    const activeRecorder = new VoiceRecorder();
    recorder.current = activeRecorder;
    try {
      await activeRecorder.start();
      // Record until the room goes quiet again, rather than a fixed window —
      // see voice/vad.ts. `noSpeechTimeoutMs` is longer for follow-up
      // listening (the user needs a beat to decide to say anything at all)
      // than for a fresh wake-word trigger.
      const reason = await new Promise<AutoStopReason>((resolve) => {
        activeRecorder.watchForAutoStop((r) => resolve(r), {
          noSpeechTimeoutMs: opts?.noSpeechTimeoutMs ?? 6000
        });
      });
      if (recorder.current !== activeRecorder) return;
      listeningRef.current = false;
      setListening(false);
      if (reason === "no-speech-timeout" || reason === "cancelled") {
        // Nothing was said — don't bother running Whisper on near-silence
        // (it's prone to hallucinating text from silence).
        activeRecorder.abort();
        recorder.current = null;
        setFaceState("idle");
        return;
      }
      const text = await activeRecorder.stopAndTranscribe();
      recorder.current = null;
      if (text) handleSend(text, true);
      else setFaceState("idle");
    } catch (err) {
      if (recorder.current === activeRecorder) recorder.current = null;
      listeningRef.current = false;
      setListening(false);
      setFaceState("idle");
      console.error("[mimir] voice capture failed:", err);
    }
  }

  async function handleMicToggle() {
    if (!listeningRef.current) {
      listeningRef.current = true;
      setListening(true);
      setFaceState("listening");
      window.mimir.voice.pushToTalkStart();
      recorder.current = new VoiceRecorder();
      try {
        await recorder.current.start();
      } catch (err) {
        setListening(false);
        setFaceState("idle");
        console.error("[mimir] microphone unavailable:", err);
      }
      return;
    }

    listeningRef.current = false;
    setListening(false);
    window.mimir.voice.pushToTalkStop();
    if (!recorder.current) return;
    setFaceState("thinking");
    try {
      const text = await recorder.current.stopAndTranscribe();
      recorder.current = null;
      if (text) handleSend(text, true);
      else setFaceState("idle");
    } catch (err) {
      recorder.current = null;
      setFaceState("idle");
      console.error("[mimir] transcription failed:", err);
    }
  }

  function handleStop() {
    window.mimir.chat.stop();
    busyRef.current = false;
    voiceOrigin.current = false;
    speechBuffer.current = "";
    assistantMessageId.current = null;
    setBusy(false);
    setFaceState("idle");
    if (openMicEnabled.current) void resumeAfterVoiceReply();
  }

  async function toggleOpenMic() {
    const config = await window.mimir.voice.setConfig({ openMicEnabled: !openMicEnabled.current });
    await setOpenMicEnabled(config.openMicEnabled);
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="system-ident">
          <span className="system-ident__eyebrow">MIMIR // LOCAL INTERFACE</span>
          <strong>EMBER COGNITIVE CORE</strong>
        </div>
        <Face state={faceState} />
        <div className="system-status" aria-live="polite">
          <span className={`status-dot status-dot--${faceState}`} />
          {faceState}
        </div>
        <button
          type="button"
          className="settings-toggle"
          onClick={() => setShowSettings((s) => !s)}
          aria-label="Open settings"
          title="Settings"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path
              fill="currentColor"
              d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm9.4 3.5c0 .6-.05 1.15-.14 1.7l2.03 1.58a.85.85 0 0 1 .2 1.08l-1.92 3.3a.85.85 0 0 1-1.03.37l-2.4-.96c-.9.68-1.9 1.22-2.97 1.58l-.36 2.55a.85.85 0 0 1-.84.72h-3.84a.85.85 0 0 1-.84-.72l-.36-2.55a9.4 9.4 0 0 1-2.97-1.58l-2.4.96a.85.85 0 0 1-1.03-.37L.61 16.36a.85.85 0 0 1 .2-1.08l2.03-1.58A9.6 9.6 0 0 1 2.7 12c0-.58.05-1.15.14-1.7L.81 8.72a.85.85 0 0 1-.2-1.08l1.92-3.3a.85.85 0 0 1 1.03-.37l2.4.96A9.4 9.4 0 0 1 8.93 3.35l.36-2.55A.85.85 0 0 1 10.13 0h3.84c.42 0 .78.31.84.72l.36 2.55c1.07.36 2.07.9 2.97 1.58l2.4-.96c.4-.15.85 0 1.03.37l1.92 3.3c.2.36.12.82-.2 1.08l-2.03 1.58c.09.55.14 1.12.14 1.7Z"
            />
          </svg>
        </button>
      </header>

      {showSettings ? (
        <Settings onClose={() => setShowSettings(false)} onVoiceConfigChanged={(config) => void setOpenMicEnabled(config.openMicEnabled)} />
      ) : showSkills ? (
        <SkillTree onClose={() => setShowSkills(false)} />
      ) : (
        <>
        <QuickControls
          onOpenSkills={() => setShowSkills(true)}
          onError={(message) =>
            setMessages((prev) => [...prev, { id: newId(), role: "system", text: `⚠️ ${message}`, createdAt: Date.now() }])
          }
        />
        <Chat
          messages={messages}
          pendingEdit={pendingEdit}
          busy={busy}
          openMicEnabled={openMicActive}
          onSend={(text, files) => void handleSend(text, false, files)}
          onStop={handleStop}
          onApprove={() => {
            if (pendingEdit) window.mimir.edit.approve(pendingEdit.id);
            setPendingEdit(null);
          }}
          onReject={() => {
            if (pendingEdit) window.mimir.edit.reject(pendingEdit.id);
            setPendingEdit(null);
          }}
          onOpenMicToggle={() => void toggleOpenMic()}
        />
        </>
      )}
    </div>
  );
}

function appendToAssistant(
  prev: ChatMessage[],
  idRef: React.MutableRefObject<string | null>,
  delta: string
): ChatMessage[] {
  const id = idRef.current;
  if (!id) return prev;
  return prev.map((m) => (m.id === id ? { ...m, text: m.text + delta } : m));
}
