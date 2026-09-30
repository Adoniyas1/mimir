import React, { useEffect, useState } from "react";
import type { BrainConfig, EffortLevel, PersonaConfig, VoiceConfig } from "../shared/types.js";

const EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

export default function Settings({
  onClose,
  onVoiceConfigChanged
}: {
  onClose: () => void;
  onVoiceConfigChanged: (config: VoiceConfig) => void;
}) {
  const [brain, setBrain] = useState<BrainConfig | null>(null);
  const [voice, setVoice] = useState<VoiceConfig | null>(null);
  const [brainKeyInput, setBrainKeyInput] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [confirmingPersonaReset, setConfirmingPersonaReset] = useState(false);
  const [persona, setPersona] = useState<PersonaConfig | null>(null);
  const [locationInput, setLocationInput] = useState("");

  useEffect(() => {
    void window.mimir.brain.getConfig().then(setBrain);
    void window.mimir.voice.getConfig().then(setVoice);
    void window.mimir.persona.getConfig().then((cfg) => {
      setPersona(cfg);
      setLocationInput(cfg.location ?? "");
    });
  }, []);

  if (!brain || !voice || !persona) return <div className="settings">Loading…</div>;

  async function patchBrain(patch: Partial<Omit<BrainConfig, "hasApiKey">>) {
    const next = await window.mimir.brain.setConfig(patch);
    setBrain(next);
  }

  async function patchVoice(
    patch: Partial<
        Pick<VoiceConfig, "wakeWordEnabled" | "openMicEnabled" | "ttsProvider" | "elevenLabsVoiceId" | "systemVoice" | "wakeWordPath" | "followUpListenSeconds">
    >
  ) {
    const next = await window.mimir.voice.setConfig(patch);
    setVoice(next);
    onVoiceConfigChanged(next);
  }

  async function patchPersona(patch: Partial<PersonaConfig>) {
    const next = await window.mimir.persona.setConfig(patch);
    setPersona(next);
  }

  async function saveBrainKey() {
    if (!brainKeyInput.trim() || !brain) return;
    await window.mimir.brain.setApiKey(brain.provider, brainKeyInput.trim());
    setBrainKeyInput("");
    setBrain(await window.mimir.brain.getConfig());
    setStatus("API key saved.");
  }

  async function resetPersonality() {
    if (!confirmingPersonaReset) {
      setConfirmingPersonaReset(true);
      return;
    }
    setConfirmingPersonaReset(false);
    const result = await window.mimir.persona.reset();
    setStatus(
      result.ok
        ? "Personality reset to defaults. It's revertable from the audit log if you change your mind."
        : `Reset failed: ${result.error}`
    );
  }

  return (
    <div className="settings">
      <div className="settings-header">
        <h2>Settings</h2>
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </div>

      <section>
        <h3>Brain</h3>
        <p className="hint">Provider and model are on the main page now — this is everything else.</p>
        {brain.provider !== "anthropic" && (
          <label>
            Base URL
            <input
              placeholder={brain.provider === "ollama" ? "http://localhost:11434" : "https://your-vps:port"}
              value={brain.baseUrl ?? ""}
              onChange={(e) => void patchBrain({ baseUrl: e.target.value || null })}
            />
          </label>
        )}

        {brain.provider !== "ollama" && (
          <label>
            API key {brain.hasApiKey ? "(saved — enter to replace)" : "(required)"}
            <div className="key-row">
              <input
                type="password"
                value={brainKeyInput}
                onChange={(e) => setBrainKeyInput(e.target.value)}
                placeholder="sk-ant-..."
              />
              <button type="button" className="btn" onClick={() => void saveBrainKey()}>
                Save
              </button>
            </div>
          </label>
        )}

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={brain.autoApproveCoreEdits}
            onChange={(e) => void patchBrain({ autoApproveCoreEdits: e.target.checked })}
          />
          Auto-approve core self-edits (skip the confirmation step before Mimir restarts into changed app code)
        </label>

        {brain.provider === "anthropic" && (
          <>
            <label>
              Thinking effort
              <select
                value={brain.effort}
                onChange={(e) => void patchBrain({ effort: e.target.value as EffortLevel })}
              >
                {EFFORT_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </label>
            <p className="hint">Higher effort thinks harder before responding — slower and more expensive.</p>

            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={brain.webSearchEnabled}
                onChange={(e) => void patchBrain({ webSearchEnabled: e.target.checked })}
              />
              Web search (lets Mimir look up current information)
            </label>
          </>
        )}
      </section>

      <section>
        <h3>Voice</h3>
        <p className="hint">Open Mic is controlled from the conversation bar. Command + Shift + Space remains available for manual recording.</p>
        <label>
          macOS voice
          <input
            value={voice.systemVoice}
            onChange={(e) => void patchVoice({ systemVoice: e.target.value })}
            placeholder="Samantha"
          />
        </label>
        <div className="key-row">
          <button type="button" className="btn" onClick={() => void window.mimir.chat.speak("Voice systems online.")}>
            Test voice
          </button>
        </div>
      </section>

      <section>
        <h3>Personality</h3>

        <label>
          Location / timezone (optional, injected into every reply's context)
          <div className="key-row">
            <input
              value={locationInput}
              onChange={(e) => setLocationInput(e.target.value)}
              placeholder="e.g. Seattle, WA (PT)"
            />
            <button
              type="button"
              className="btn"
              onClick={() => void patchPersona({ location: locationInput.trim() || null })}
            >
              Save
            </button>
          </div>
        </label>

        <div className="key-row">
          <button
            type="button"
            className={confirmingPersonaReset ? "btn btn--reject" : "btn"}
            onClick={() => void resetPersonality()}
          >
            {confirmingPersonaReset ? "Click again to confirm reset" : "Reset personality"}
          </button>
          {confirmingPersonaReset && (
            <button type="button" className="btn btn--reject" onClick={() => setConfirmingPersonaReset(false)}>
              Cancel
            </button>
          )}
        </div>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={persona.heartbeatEnabled}
            onChange={(e) => void patchPersona({ heartbeatEnabled: e.target.checked })}
          />
          Heartbeat maintenance (periodically consolidates daily notes into long-term memory, unattended)
        </label>
        {persona.heartbeatEnabled && (
          <label>
            Heartbeat interval (minutes)
            <input
              type="number"
              min={5}
              value={persona.heartbeatIntervalMinutes}
              onChange={(e) => {
                const minutes = Number(e.target.value);
                if (Number.isFinite(minutes) && minutes >= 5) void patchPersona({ heartbeatIntervalMinutes: minutes });
              }}
            />
          </label>
        )}

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={persona.deadlineNotificationsEnabled}
            onChange={(e) => void patchPersona({ deadlineNotificationsEnabled: e.target.checked })}
          />
          Deadline notifications (OS notification when a TASKS.md item is due soon or overdue)
        </label>
      </section>

      {status && <p className="hint">{status}</p>}
    </div>
  );
}
