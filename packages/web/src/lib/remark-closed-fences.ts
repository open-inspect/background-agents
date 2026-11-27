import type { Code } from "mdast";
// remark-parse's types declare `fromMarkdownExtensions` on unified's Data.
import type {} from "remark-parse";
import type { Processor } from "unified";

/** Mark only fences for which CommonMark actually parsed a closing fence. */
export function remarkClosedFences(this: Processor) {
  const data = this.data();
  const seen = new WeakSet<Code>();
  (data.fromMarkdownExtensions ??= []).push({
    enter: {
      codeFencedFence() {
        // The closing fence enters with the code's text buffer still on the stack.
        const node = this.stack.find((node): node is Code => node.type === "code");
        if (!node) return;
        if (!seen.has(node)) {
          seen.add(node);
          return;
        }
        node.data ??= {};
        node.data.hProperties ??= {};
        node.data.hProperties.dataFenceClosed = "true";
      },
    },
  });
}
