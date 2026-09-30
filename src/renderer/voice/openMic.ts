import type { MicVAD } from "@ricky0123/vad-web";

export interface OpenMicCallbacks {
  onSpeechStart: () => void;
  onSpeechEnd: (audio: Float32Array) => void;
  onError: (error: unknown) => void;
}

/**
 * Local Silero VAD used for hands-free conversation. It is loaded only when
 * Open Mic is enabled, keeping its model and ONNX runtime out of normal use.
 */
export class OpenMicController {
  private vad: MicVAD | null = null;

  constructor(private callbacks: OpenMicCallbacks) {}

  async start(): Promise<void> {
    try {
      if (!this.vad) {
        const { MicVAD } = await import("@ricky0123/vad-web");
        const assetBase = new URL("./vad/", window.location.href).toString();
        this.vad = await MicVAD.new({
          model: "v5",
          startOnLoad: false,
          baseAssetPath: assetBase,
          onnxWASMBasePath: assetBase,
          positiveSpeechThreshold: 0.6,
          negativeSpeechThreshold: 0.4,
          redemptionMs: 1_200,
          minSpeechMs: 250,
          onSpeechStart: this.callbacks.onSpeechStart,
          onSpeechEnd: this.callbacks.onSpeechEnd,
          onVADMisfire: () => undefined
        });
      }
      await this.vad.start();
    } catch (error) {
      this.callbacks.onError(error);
    }
  }

  async pause(): Promise<void> {
    await this.vad?.pause();
  }

  async destroy(): Promise<void> {
    await this.vad?.destroy();
    this.vad = null;
  }
}
