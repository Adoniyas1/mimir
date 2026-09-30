import type { MimirApi } from "../preload/index";

declare global {
  interface Window {
    mimir: MimirApi;
  }
}

export {};
