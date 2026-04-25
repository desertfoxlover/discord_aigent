/**
 * Claude(editor) ↔ Gemini(reviewer) round loop with stalemate / cap detection.
 * Pure logic — no Discord / HTTP. Wire `runEditor` / `runReviewer` to OpenClaw or direct APIs.
 */

export const Verdict = {
  APPROVE: "APPROVE",
  NEEDS_WORK: "NEEDS_WORK",
  BLOCKED: "BLOCKED",
  UNKNOWN: "UNKNOWN",
};

const VERDICT_RE = /VERDICT:\s*(APPROVE|NEEDS_WORK|BLOCKED)\b/i;

/**
 * @param {string} reviewerText
 * @returns {keyof typeof Verdict}
 */
export function parseVerdict(reviewerText) {
  const m = reviewerText.match(VERDICT_RE);
  if (!m) return Verdict.UNKNOWN;
  return m[1].toUpperCase();
}

/**
 * Cheap fingerprint: collapse whitespace so tiny wording changes still match.
 * @param {string} s
 */
export function fingerprint(s) {
  return s.replace(/\s+/g, " ").trim().slice(0, 4000);
}

/**
 * @typedef {object} RoundNotification
 * @property {'round'} type
 * @property {number} round
 * @property {string} verdict
 * @property {string} [editorPreview]
 * @property {string} [reviewerPreview]
 */

/**
 * @typedef {object} OrchestratorResult
 * @property {'complete'|'blocked'|'stalemate'|'max_rounds'|'error'} status
 * @property {number} [round]
 * @property {string} [editorOutput]
 * @property {string} [reviewerOutput]
 * @property {string} [message]
 */

/**
 * @param {object} opts
 * @param {string} opts.task
 * @param {(prompt: string) => Promise<string>} opts.runEditor
 * @param {(prompt: string) => Promise<string>} opts.runReviewer
 * @param {(round: number, priorReviewer: string) => string} opts.buildEditorPrompt
 * @param {(round: number, editorOutput: string) => string} opts.buildReviewerPrompt
 * @param {number} [opts.maxRounds]
 * @param {number} [opts.maxStaleReviews] consecutive NEEDS_WORK with same fingerprint
 * @param {(n: RoundNotification | { type: string; [k: string]: unknown }) => Promise<void>} [opts.onNotify]
 * @returns {Promise<OrchestratorResult>}
 */
export async function runPairLoop(opts) {
  const {
    task,
    runEditor,
    runReviewer,
    buildEditorPrompt,
    buildReviewerPrompt,
    maxRounds = 8,
    maxStaleReviews = 2,
    onNotify = async () => {},
  } = opts;

  let reviewerFeedback = "";
  let lastNeedsWorkFp = null;
  let staleCount = 0;
  let editorOutput = "";
  let reviewerOutput = "";

  for (let round = 1; round <= maxRounds; round++) {
    try {
      const editorPrompt = buildEditorPrompt(round, reviewerFeedback);
      editorOutput = await runEditor(editorPrompt);

      const reviewerPrompt = buildReviewerPrompt(round, editorOutput);
      reviewerOutput = await runReviewer(reviewerPrompt);
      const verdict = parseVerdict(reviewerOutput);

      await onNotify({
        type: "round",
        round,
        verdict,
        editorPreview: preview(editorOutput),
        reviewerPreview: preview(reviewerOutput),
      });

      if (verdict === Verdict.APPROVE) {
        await onNotify({ type: "complete", round, verdict });
        return {
          status: "complete",
          round,
          editorOutput,
          reviewerOutput,
        };
      }

      if (verdict === Verdict.BLOCKED) {
        await onNotify({ type: "blocked", round, verdict });
        return {
          status: "blocked",
          round,
          editorOutput,
          reviewerOutput,
        };
      }

      if (verdict === Verdict.NEEDS_WORK) {
        const fp = fingerprint(reviewerOutput);
        if (fp === lastNeedsWorkFp) staleCount += 1;
        else staleCount = 0;
        lastNeedsWorkFp = fp;

        if (staleCount >= maxStaleReviews) {
          await onNotify({ type: "stalemate", round, staleCount });
          return {
            status: "stalemate",
            round,
            editorOutput,
            reviewerOutput,
            message: "Reviewer repeated the same NEEDS_WORK feedback; stopping.",
          };
        }
        reviewerFeedback = reviewerOutput;
        continue;
      }

      // UNKNOWN verdict: treat as NEEDS_WORK once, then escalate stalemate
      await onNotify({
        type: "unknown_verdict",
        round,
        hint: "Reviewer did not end with VERDICT: line; tighten reviewer prompt or model.",
      });
      reviewerFeedback = reviewerOutput;
      const fp = fingerprint(reviewerOutput);
      if (fp === lastNeedsWorkFp) staleCount += 1;
      else {
        staleCount = 0;
        lastNeedsWorkFp = fp;
      }
      if (staleCount >= maxStaleReviews) {
        await onNotify({ type: "stalemate", round, staleCount });
        return {
          status: "stalemate",
          round,
          editorOutput,
          reviewerOutput,
          message: "Unknown or repeating reviewer output.",
        };
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await onNotify({ type: "error", round, message });
      return { status: "error", round, message };
    }
  }

  await onNotify({ type: "max_rounds", maxRounds });
  return {
    status: "max_rounds",
    round: maxRounds,
    editorOutput,
    reviewerOutput,
    message: `Exceeded maxRounds (${maxRounds}).`,
  };
}

function preview(s, n = 500) {
  const t = s.trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n)}…`;
}
