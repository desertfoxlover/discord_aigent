/**
 * Dry-run: fake editor/reviewer to validate loop + Discord formatting helpers.
 * Run: npm run orchestrator-demo
 */
import { runPairLoop } from "./orchestrator.js";
import {
  buildEditorUserContent,
  buildReviewerUserContent,
} from "./prompts.js";

let needWorkLeft = 2;

async function runEditor(prompt) {
  needWorkLeft--;
  if (needWorkLeft > 0) {
    return `Stub implementer: did partial work.\n${prompt.slice(0, 80)}…`;
  }
  return "Stub implementer: finished all requested edits in ./src/foo.js";
}

async function runReviewer(prompt) {
  if (needWorkLeft > 0) {
    return `Found gaps.\nVERDICT: NEEDS_WORK`;
  }
  return `LGTM.\nVERDICT: APPROVE`;
}

const task = "Add hello world to foo.js";

const result = await runPairLoop({
  task,
  runEditor,
  runReviewer,
  buildEditorPrompt: (round, prior) =>
    buildEditorUserContent(task, round, prior),
  buildReviewerPrompt: (round, editorOut) =>
    buildReviewerUserContent(task, editorOut, round),
  maxRounds: 6,
  maxStaleReviews: 2,
  onNotify: async (n) => {
    console.log("[notify]", n.type, n);
  },
});

console.log("Result:", result.status);
