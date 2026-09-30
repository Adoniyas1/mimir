import type { BrainProvider } from "./Provider.js";
import { AnthropicProvider } from "./anthropicProvider.js";
import { OpenAICompatibleProvider } from "./openaiCompatibleProvider.js";
import { OllamaProvider } from "./ollamaProvider.js";
import { withReactShim } from "./reactShim.js";
import { getBrainApiKey, loadBrainConfig } from "./config.js";

export type {
  BrainProvider,
  ChatEvent,
  ChatOpts,
  BrainMessage,
  ToolDef,
  ToolCall,
  StopReason,
  Attachment
} from "./Provider.js";
export { loadBrainConfig, saveBrainConfig, setBrainApiKey } from "./config.js";
export { listOllamaModels } from "./ollamaProvider.js";

/**
 * Builds the active BrainProvider from persisted config + keychain secrets.
 * This is the single place that turns "provider": "anthropic" | "ollama" |
 * "openai-compatible" into a concrete implementation — swap providers by
 * changing config, never by changing call sites.
 */
export async function createBrainProvider(): Promise<BrainProvider> {
  const config = await loadBrainConfig();

  let provider: BrainProvider;
  switch (config.provider) {
    case "anthropic": {
      const apiKey = await getBrainApiKey("anthropic");
      if (!apiKey) {
        throw new Error(
          "No Anthropic API key configured. Add one in Settings, or switch to a local/VPS provider."
        );
      }
      provider = new AnthropicProvider(apiKey, config.model);
      break;
    }
    case "ollama": {
      provider = new OllamaProvider(config.model, config.baseUrl ?? undefined);
      break;
    }
    case "openai-compatible": {
      if (!config.baseUrl) {
        throw new Error("openai-compatible provider requires a base URL (your VPS/server address).");
      }
      const apiKey = await getBrainApiKey("openai-compatible");
      provider = new OpenAICompatibleProvider(config.baseUrl, config.model, apiKey);
      break;
    }
    default: {
      const exhaustive: never = config.provider;
      throw new Error(`Unknown brain provider: ${String(exhaustive)}`);
    }
  }

  // Wrap with the ReAct shim only when the provider can't natively call
  // tools — keeps native tool-calling providers (Anthropic, most
  // OpenAI-compatible servers, tool-capable Ollama models) on the fast path.
  return provider.supportsTools() ? provider : withReactShim(provider);
}
