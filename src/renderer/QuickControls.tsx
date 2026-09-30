import React, { useEffect, useState } from "react";
import type { BrainConfig, BrainProviderKind } from "../shared/types.js";

const PROVIDER_LABEL: Record<BrainProviderKind, string> = {
  anthropic: "Claude",
  ollama: "Ollama",
  "openai-compatible": "VPS"
};

/**
 * Always-visible compact strip on the main chat page for the two settings
 * changed often enough that hiding them behind the Settings screen was
 * friction: which brain is answering, and where the Projects folder is.
 * Everything used less often (API keys, voice, personality) stays in
 * Settings.
 */
export default function QuickControls({
  onOpenSkills,
  onError
}: {
  onOpenSkills: () => void;
  onError: (message: string) => void;
}) {
  const [brain, setBrain] = useState<BrainConfig | null>(null);
  const [model, setModel] = useState("");
  const [projectsRoot, setProjectsRoot] = useState<string | null>(null);
  // null = not checked yet, [] = checked but Ollama isn't reachable / has no
  // models pulled — either way, fall back to a free-text model field.
  const [ollamaModels, setOllamaModels] = useState<string[] | null>(null);

  useEffect(() => {
    void window.mimir.brain.getConfig().then((cfg) => {
      setBrain(cfg);
      setModel(cfg.model);
      if (cfg.provider === "ollama") void detectOllamaModels(cfg.baseUrl);
    });
    void window.mimir.projects.getRoot().then(setProjectsRoot);
  }, []);

  if (!brain) return null;

  async function detectOllamaModels(baseUrl: string | null) {
    const names = await window.mimir.brain.listOllamaModels(baseUrl ?? undefined);
    setOllamaModels(names);
  }

  async function patchBrain(patch: Partial<Omit<BrainConfig, "hasApiKey">>) {
    const next = await window.mimir.brain.setConfig(patch);
    setBrain(next);
    setModel(next.model);
    if (patch.provider === "ollama" && patch.provider !== brain?.provider) {
      void detectOllamaModels(next.baseUrl);
    }
  }

  async function commitModel() {
    const trimmed = model.trim();
    if (brain && trimmed && trimmed !== brain.model) await patchBrain({ model: trimmed });
  }

  const showOllamaPicker = brain.provider === "ollama" && !!ollamaModels && ollamaModels.length > 0;
  // Keep whatever's currently configured selectable even if it fell out of
  // the detected list (e.g. pulled on a different machine, or config from
  // before Ollama was running) rather than silently overwriting it.
  const ollamaOptions =
    showOllamaPicker && ollamaModels && !ollamaModels.includes(brain.model) ? [brain.model, ...ollamaModels] : ollamaModels;

  return (
    <div className="quick-controls">
      <select
        className="quick-controls__provider"
        value={brain.provider}
        onChange={(e) => void patchBrain({ provider: e.target.value as BrainProviderKind })}
        title="Brain provider"
        aria-label="Brain provider"
      >
        {(Object.keys(PROVIDER_LABEL) as BrainProviderKind[]).map((p) => (
          <option key={p} value={p}>
            {PROVIDER_LABEL[p]}
          </option>
        ))}
      </select>
      {showOllamaPicker ? (
        <select
          className="quick-controls__model"
          value={brain.model}
          onChange={(e) => void patchBrain({ model: e.target.value })}
          title="Model — auto-detected from your local Ollama install"
          aria-label="Model"
        >
          {ollamaOptions?.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="quick-controls__model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          onBlur={() => void commitModel()}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          placeholder={brain.provider === "ollama" ? "model (Ollama not detected — enter manually)" : "model"}
          aria-label="Model"
          title="Model"
        />
      )}
      <button
        type="button"
        className="quick-controls__action"
        title={projectsRoot ? `Open Projects folder — ${projectsRoot}` : "Open Projects folder"}
        onClick={async () => {
          const result = await window.mimir.projects.openFolder();
          if (!result.ok) onError(`Could not open Projects folder: ${result.error}`);
        }}
      >
        FILES
      </button>
      <button type="button" className="quick-controls__action" title="View Mimir's skill tree" onClick={onOpenSkills}>
        SKILLS
      </button>
    </div>
  );
}
