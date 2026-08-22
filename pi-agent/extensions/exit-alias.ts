/**
 * Exit Alias Extension
 *
 * Makes /exit behave like the built-in /quit command.
 * Gracefully shuts down pi.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("exit", {
    description: "Quit pi",
    handler: async (_args, ctx) => {
      ctx.shutdown();
    },
  });
}
