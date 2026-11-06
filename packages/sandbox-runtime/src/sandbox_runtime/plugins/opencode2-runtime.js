/**
 * Open-Inspect runtime policy for OpenCode 2.
 *
 * OpenCode 2 lets the subagent tool run a child in the background and wake
 * the parent when it finishes. The bridge relays one prompt at a time and
 * stops listening when the parent's execution ends, so a background child's
 * work and the turn it triggers would never reach the session. Every
 * subagent therefore runs in the foreground, as the 1.x task tool did.
 *
 * Plain module, no imports: OpenCode 2 loads `export default { id, setup }`.
 */
export default {
  id: "openinspect.runtime",
  setup: async (ctx) => {
    ctx.tool.hook("execute.before", (event) => {
      if (event.tool !== "subagent" || !event.input || typeof event.input !== "object") return;
      if (event.input.background) event.input = { ...event.input, background: false };
    });
  },
};
