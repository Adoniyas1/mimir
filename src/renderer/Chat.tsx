import React, { useRef, useState } from "react";
import MessageContent from "./MessageContent.js";
import CameraCapture from "./camera/CameraCapture.js";
import type { ChatMessage, PendingEdit } from "../shared/types.js";

interface ChatProps {
  messages: ChatMessage[];
  pendingEdit: PendingEdit | null;
  busy: boolean;
  openMicEnabled: boolean;
  onSend: (text: string, files?: File[]) => void;
  onStop: () => void;
  onApprove: () => void;
  onReject: () => void;
  onOpenMicToggle: () => void;
}

export default function Chat({
  messages,
  pendingEdit,
  busy,
  openMicEnabled,
  onSend,
  onStop,
  onApprove,
  onReject,
  onOpenMicToggle
}: ChatProps) {
  const [draft, setDraft] = useState("");
  const [stagedFiles, setStagedFiles] = useState<File[]>([]);
  const [showCamera, setShowCamera] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if ((!text && stagedFiles.length === 0) || busy) return;
    onSend(text, stagedFiles.length > 0 ? stagedFiles : undefined);
    setDraft("");
    setStagedFiles([]);
  }

  function addFiles(files: FileList | null) {
    if (!files) return;
    setStagedFiles((prev) => [...prev, ...Array.from(files)]);
  }

  function removeStagedFile(index: number) {
    setStagedFiles((prev) => prev.filter((_, i) => i !== index));
  }

  return (
    <div className="chat">
      {showCamera && (
        <CameraCapture
          onCapture={(file) => {
            setStagedFiles((prev) => [...prev, file]);
            setShowCamera(false);
          }}
          onClose={() => setShowCamera(false)}
        />
      )}
      <div className="chat-console-heading">
        <span>CONVERSATION</span>
        <span>{busy ? "PROCESSING" : "CHANNEL OPEN"}</span>
      </div>
      <div className="chat-messages">
        {messages.map((m) => (
          <div key={m.id} className={`chat-bubble chat-bubble--${m.role}`}>
            <span className="chat-role">{m.role === "user" ? "you" : m.role}</span>
            <div className="chat-text">
              {m.text ? <MessageContent text={m.text} /> : busy && m.role === "assistant" ? "…" : ""}
            </div>
          </div>
        ))}
        {pendingEdit && (
          <div className="edit-card">
            <div className="edit-card-title">
              Mimir wants to change its own {pendingEdit.tier === "core" ? "core code" : "skills"}
            </div>
            <div className="edit-card-summary">{pendingEdit.summary}</div>
            <div className="edit-card-files">{pendingEdit.filesTouched.join(", ")}</div>
            <pre className="edit-card-diff">{pendingEdit.diff.slice(0, 4000)}</pre>
            <div className="edit-card-actions">
              <button type="button" onClick={onApprove} className="btn btn--approve">
                Approve
              </button>
              <button type="button" onClick={onReject} className="btn btn--reject">
                Reject
              </button>
            </div>
          </div>
        )}
      </div>

      {stagedFiles.length > 0 && (
        <div className="attachment-chips">
          {stagedFiles.map((file, i) => (
            <span key={`${file.name}-${i}`} className="attachment-chip">
              {file.name}
              <button
                type="button"
                onClick={() => removeStagedFile(i)}
                aria-label={`Remove ${file.name}`}
                title="Remove"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <form className="chat-input" onSubmit={submit}>
        <button
          type="button"
          className={`voice-control ${openMicEnabled ? "voice-control--active" : ""}`}
          onClick={onOpenMicToggle}
          aria-label={openMicEnabled ? "Pause Open Mic" : "Enable Open Mic"}
          title={openMicEnabled ? "Pause Open Mic" : "Enable Open Mic"}
        >
          <span aria-hidden="true">{openMicEnabled ? String.fromCharCode(10074, 10074) : String.fromCharCode(9654)}</span>
        </button>
        <button
          type="button"
          className="voice-control"
          onClick={() => fileInput.current?.click()}
          aria-label="Attach a file"
          title="Attach a photo, PDF, or file"
        >
          <span aria-hidden="true">+</span>
        </button>
        <button
          type="button"
          className="voice-control"
          onClick={() => setShowCamera(true)}
          aria-label="Take a photo with the camera"
          title="Take a photo with the camera"
        >
          <span aria-hidden="true">◉</span>
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          accept="image/*,application/pdf,text/*,.md,.py,.ts,.tsx,.js,.jsx,.json,.csv,.c,.cpp,.h,.java,.m,.rs,.go,.sh,.yaml,.yml,.toml,.ini"
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Talk to Mimir…"
          disabled={busy}
        />
        {busy && (
          <button type="button" className="voice-control voice-control--stop" onClick={onStop} aria-label="Stop Mimir" title="Stop Mimir">
            <span aria-hidden="true">{String.fromCharCode(9632)}</span>
          </button>
        )}
        <button type="submit" disabled={busy || (!draft.trim() && stagedFiles.length === 0)} className="btn">
          Transmit
        </button>
      </form>
    </div>
  );
}
