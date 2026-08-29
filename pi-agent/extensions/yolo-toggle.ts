/**
 * Yolo Mode Toggle Extension
 *
 * Toggles yoloMode in the pi-permission-system config.
 * When yoloMode is enabled, all "ask" permission prompts are auto-approved.
 *
 * Commands:
 * - /yolo         - Toggle yolo mode on/off
 * - /yolo status  - Show current yolo mode state
 * - /yolo on      - Enable yolo mode
 * - /yolo off     - Disable yolo mode
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CONFIG_DIR = join(process.env.PI_CODING_AGENT_DIR || join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "agent"), "extensions", "pi-permission-system");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

interface PermissionConfig {
  yoloMode?: boolean;
  [key: string]: unknown;
}

async function loadConfig(): Promise<PermissionConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as PermissionConfig;
  } catch {
    return {};
  }
}

async function saveConfig(config: PermissionConfig): Promise<void> {
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

interface StatusContext {
  ui: {
    theme: { fg(color: string, text: string): string; bold(text: string): string };
  };
}

function yoloStatus(ctx: StatusContext, isYolo: boolean): string {
  const th = ctx.ui.theme;
  return isYolo ? th.fg("warning", th.bold("⚡ yolo on")) : th.fg("success", "🛡 yolo off");
}

export default function (pi: ExtensionAPI) {
  // Status widget: show yolo mode state in footer
  pi.on("session_start", async (_event, ctx) => {
    const config = await loadConfig();
    const isYolo = config.yoloMode === true;
    ctx.ui.setStatus("yolo", yoloStatus(ctx, isYolo));
  });

  pi.registerCommand("yolo", {
    description: "Toggle yolo mode (auto-approve all permission asks). Usage: /yolo [on|off|status]",
    handler: async (args, ctx) => {
      const config = await loadConfig();
      const current = config.yoloMode === true;
      const sub = args.trim().toLowerCase();

      let next: boolean;
      if (sub === "on") {
        next = true;
      } else if (sub === "off") {
        next = false;
      } else if (sub === "status" || sub === "") {
        ctx.ui.notify(`Yolo mode is ${current ? "ON ⚡" : "OFF 🛡"}`, "info");
        ctx.ui.setStatus("yolo", yoloStatus(ctx, current));
        return;
      } else {
        ctx.ui.notify(`Unknown argument: ${sub}. Use: /yolo [on|off|status]`, "error");
        return;
      }

      config.yoloMode = next;
      await saveConfig(config);

      ctx.ui.notify(`Yolo mode ${next ? "ENABLED ⚡" : "DISABLED 🛡"}`, next ? "warning" : "info");
      ctx.ui.setStatus("yolo", yoloStatus(ctx, next));

      // Suggest reload so permission system picks up the new config
      if (next !== current) {
        ctx.ui.notify("Run /reload to apply the new permission config", "info");
      }
    },
  });
}
