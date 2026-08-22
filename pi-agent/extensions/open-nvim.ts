/**
 * Open Nvim Extension
 *
 * Opens the current directory in nvim within a new terminal.
 * Usage:
 * - Run /nvim command to open nvim in a new terminal
 * - Extension auto-opens nvim when loaded (can be disabled)
 *
 * Configuration:
 * - AUTO_OPEN_ON_LOAD: Set to false to disable auto-opening on startup
 * - PREFERRED_TERMINAL: "wt" (Windows Terminal), "cmd", "powershell", or "auto"
 */

import { exec } from "node:child_process";
import { platform } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Set to false to disable auto-opening nvim on extension load
const AUTO_OPEN_ON_LOAD = false;

// Preferred terminal: "wt" (Windows Terminal), "cmd", "powershell", or "auto" (tries wt first)
const PREFERRED_TERMINAL: "wt" | "cmd" | "powershell" | "auto" = "auto";

function openNvim(cwd: string): void {
  let command: string;
  const escapedCwd = cwd.replace(/"/g, '\\"');

  if (platform() === "win32") {
    const terminal = PREFERRED_TERMINAL;

    if (terminal === "wt" || terminal === "auto") {
      // Windows Terminal (better neovim experience - true color, ligatures, etc.)
      command = `wt new-tab --title nvim -- nvim -c "cd \"${escapedCwd}\""`;
    } else if (terminal === "powershell") {
      // PowerShell - uses -NoExit to keep window open
      command = `start "" powershell -NoExit -Command "cd '${escapedCwd}'; nvim"`;
    } else {
      // cmd - uses /k to keep terminal open after command
      command = `start "" cmd /k "cd /d "${escapedCwd}" && nvim"`;
    }
  } else if (platform() === "darwin") {
    // macOS - use Terminal with proper cd
    command = `osascript -e 'tell app "Terminal" to do script "cd \\"${escapedCwd}\\" && nvim"'`;
  } else {
    // Linux
    command = `x-terminal-emulator -e "cd '${escapedCwd}' && nvim" 2>/dev/null || \
              konsole --hold -e nvim -c "cd '${escapedCwd}" 2>/dev/null || \
              gnome-terminal -- nvim -c "cd '${escapedCwd}" 2>/dev/null || \
              xterm -e "cd '${escapedCwd}' && nvim"`;
  }

  exec(command, (error) => {
    if (error) {
      console.error("Failed to open nvim:", error.message);
      // Fallback to basic cmd if preferred method fails
      if (platform() === "win32") {
        exec(`start "" cmd /k "cd /d "${escapedCwd}" && nvim"`);
      }
    }
  });
}

export default function (pi: ExtensionAPI) {
  // Register /nvim command
  pi.registerCommand("nvim", {
    description: "Open the current directory in nvim (new terminal)",
    handler: async (args, ctx) => {
      const cwd = ctx.cwd;
      openNvim(cwd);
      ctx.ui.notify(`Opening nvim in: ${cwd}`, "info");
    },
  });

  // Optionally open nvim automatically when extension is loaded
  if (AUTO_OPEN_ON_LOAD) {
    pi.on("session_start", async (event, ctx) => {
      // Only auto-open on startup (not on reload, resume, etc.)
      if (event.reason === "startup") {
        // Small delay to let the session fully initialize
        setTimeout(() => {
          openNvim(ctx.cwd);
        }, 500);
      }
    });
  }
}