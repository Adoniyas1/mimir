/**
 * Optional external watchdog. The packaged app is self-healing on its own
 * (see electron-entry.mjs, which checks the same boot-attempts counter
 * before every launch), so most users never need this running. It exists
 * for long-lived/background deployments where something outside the
 * Electron process itself should be the one restarting it — and it's the
 * thing exercised by the "kill the app mid-boot 3x" verification step,
 * without needing a real display.
 *
 * Usage: `npm run supervisor`
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decideBootAction } from "./bootPolicy.js";
import { readActivePointer, readBootAttempts, writeActivePointer, writeBootAttempts } from "./state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");
const HEALTHY_MARKER = "MIMIR_HEALTHY";
const HEALTHY_TIMEOUT_MS = 20_000;

async function main(): Promise<void> {
  let running = true;
  process.on("SIGINT", () => (running = false));
  process.on("SIGTERM", () => (running = false));

  while (running) {
    const attempts = await readBootAttempts();
    const decision = decideBootAction({ consecutiveFailures: attempts });

    if (decision.action === "revert-and-boot-fallback") {
      console.warn(`[supervisor] ${decision.reason}`);
      await writeActivePointer({ activeDir: null, revision: null, updatedAt: Date.now() });
      await writeBootAttempts(0);
    }

    const pointer = await readActivePointer();
    const target = pointer?.activeDir ?? APP_ROOT;
    console.log(`[supervisor] Launching from ${target} (attempt streak: ${attempts})`);

    const healthy = await launchAndWaitForHealth(target);

    if (healthy) {
      await writeBootAttempts(0);
      console.log("[supervisor] App reported healthy and has exited normally. Not relaunching.");
      running = false; // a clean, healthy run that exited is a user-initiated quit — stop supervising
    } else {
      const next = attempts + 1;
      await writeBootAttempts(next);
      console.warn(`[supervisor] App exited without reporting healthy (streak now ${next}).`);
    }
  }
}

function launchAndWaitForHealth(cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["electron", "."], { cwd, stdio: ["ignore", "pipe", "inherit"] });
    let sawHealthy = false;
    const timer = setTimeout(() => {
      // Didn't report healthy in time — let it keep running if it hasn't
      // crashed (slow start isn't necessarily a bad build), but count this
      // launch as unhealthy so a genuinely-hung build still gets reverted.
    }, HEALTHY_TIMEOUT_MS);

    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString("utf-8");
      process.stdout.write(text);
      if (text.includes(HEALTHY_MARKER)) sawHealthy = true;
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(sawHealthy && code === 0);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

main().catch((err) => {
  console.error("[supervisor] Fatal error:", err);
  process.exit(1);
});
