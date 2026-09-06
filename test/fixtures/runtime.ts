import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Explicitly loaded only by scripts/smoke.mjs, never part of package manifest.
export default function runtimeProbe(pi: ExtensionAPI): void {
  pi.registerCommand("plan-smoke-tools", {
    handler: async () => { pi.appendEntry("plan-smoke-tools", pi.getActiveTools()); },
  });
  pi.registerCommand("plan-smoke-reload", {
    handler: async (_args, ctx) => { await ctx.reload(); },
  });
}
