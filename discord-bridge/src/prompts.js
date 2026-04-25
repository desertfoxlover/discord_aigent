/**
 * System instructions embedded in user prompts so any gateway/agent honors role split.
 * Tweak wording to match your OpenClaw agent tool policy.
 */

export const EDITOR_SYSTEM_HINT = `
You are the primary implementer (Claude role). You may edit files in the mounted workspace only.
After changes, summarize: files touched, intent, risks, and how to verify.
`.trim();

export const REVIEWER_SYSTEM_HINT = `
You are the reviewer (Gemini role). You do not apply edits; you only review the implementer's output.
Respond in this order:
1) Summary of what the implementer did
2) Issues found (severity: blocker / major / minor)
3) Concrete follow-ups if any

End your message with EXACTLY one line in this format (no code fence):
VERDICT: APPROVE
or
VERDICT: NEEDS_WORK
or
VERDICT: BLOCKED

Use APPROVE only if you would merge as-is. NEEDS_WORK if fixes are required. BLOCKED if unsafe or wrong direction.
`.trim();

export function buildEditorUserContent(task, round, reviewerFeedback) {
  const tail = reviewerFeedback
    ? `\n\n---\nReviewer feedback (round ${round - 1}):\n${reviewerFeedback}`
    : "";
  return `${EDITOR_SYSTEM_HINT}\n\nTask:\n${task}${tail}`;
}

export function buildReviewerUserContent(task, editorOutput, round) {
  return `${REVIEWER_SYSTEM_HINT}\n\nOriginal task:\n${task}\n\n---\nImplementer output (round ${round}):\n${editorOutput}`;
}

/** 단발 대화 — 편집/검수 루프 없이 자연어 응답 */
export const CHAT_SINGLE_TURN_PREFIX = `
You are a helpful assistant in Discord. Reply in the same language as the user when possible.
Do not claim you edited files or started an editor/reviewer loop unless the user explicitly asked for repo/file changes.
Be concise.
`.trim();

/** 단발 검색/사실 조회 톤 */
export const SEARCH_SINGLE_TURN_PREFIX = `
You are helping with a question that may need up-to-date or factual information.
Answer in the user's language. If unsure, say so. Prefer accuracy over guessing.
If you used browsing/search tools, mention that briefly; otherwise answer from general knowledge.
`.trim();

/**
 * `.env` 채널 목록으로 정한 역할을 모델에 알려 줌(서버/채널 이름 포함).
 * @param {object} o
 * @param {string | null} [o.guildName]
 * @param {string} o.channelLabel
 * @param {string} o.channelId
 * @param {'chat' | 'search' | 'coding' | 'unknown'} o.configuredRole
 */
export function buildDiscordChannelContextPrefix(o) {
  const desc = {
    chat:
      "CHAT — 이 채널은 잡담·짧은 질문용으로 설정됨. 파일/저장소 수정은 사용자가 분명히 요청할 때만 언급.",
    search:
      "SEARCH — 이 채널은 검색·사실 확인용으로 설정됨. 가능하면 근거·출처에 가깝게 답변.",
    coding:
      "CODING — 이 채널은 코드/파일 작업용으로 설정됨. 구현·수정 요청이면 워크스페이스 도구 사용이 허용될 수 있음.",
    unknown:
      "역할 미지정(목록 비었거나 이 채널이 목록에 없음) — 브리지가 고른 단발/루프 모드를 따름.",
  }[o.configuredRole];

  return [
    "[Discord — 채널 역할(운영자가 .env에 매핑함)]",
    `서버: ${o.guildName ?? "(알 수 없음)"}`,
    `채널: ${o.channelLabel} (id=${o.channelId})`,
    desc,
    "---",
  ].join("\n");
}

/**
 * 채널 설정의 "채널 주제"(토픽) — 운영자가 UI에 적어 두면 매 요청에 포함됨.
 * @param {string} topic
 */
export function buildChannelTopicRulesBlock(topic) {
  const t = (topic || "").trim();
  if (!t) return "";
  return [
    "[Discord — 이 채널의 주제/규칙(채널 편집 → 채널 주제에 작성됨)]",
    t,
    "---",
  ].join("\n");
}

/**
 * 서버 설정의 서버 설명(커뮤니티 서버 등). 길면 잘라서 붙임.
 * @param {string} description
 */
export function buildGuildDescriptionRulesBlock(description) {
  const d = (description || "").trim();
  if (!d) return "";
  return [
    "[Discord — 서버 설명(서버 설정에 작성됨)]",
    d,
    "---",
  ].join("\n");
}

const DEBATE_MAIN_INTRO = `
You are the model the user @mentioned first (the "main" side in this debate).
Another AI model will respond after you; you are not a code-reviewer, you are a debate participant.
Be concise, structured. Same language as the user when possible.
Do not use VERDICT: lines; this is not a code review.
`.trim();

const DEBATE_OTHER_INTRO = `
You are the "other" model in a two-way debate, paired with a different model that went first in each round.
Respond to the topic and, from round 1 onward, respond to the main model's latest points as well. Stay constructive.
Be concise. Same language as the user when possible. No VERDICT: line.
`.trim();

/**
 * @param {number} round
 * @param {string} task
 * @param {Array<{ side: string; round: number; text: string }>} history
 * @param {{ mode?: 'search' | 'chat' }} [style]
 */
export function buildDebateMainPrompt(
  round,
  task,
  history,
  style = {},
) {
  const extra =
    style.mode === "search"
      ? "You may use factual, up-to-date knowledge if relevant. If unsure, say so."
      : "";
  let backAndForth = "";
  if (round > 1) {
    const oPrev = (history || []).find(
      (h) => h.side === "other" && h.round === round - 1,
    );
    if (oPrev?.text) {
      backAndForth = `이전 왕복에서 상대(다른) 모델이 말한 내용:\n${oPrev.text}\n\n이제 라운드 ${round} — 위에 응답·보완·반박하며 이어가세요.`;
    }
  }
  return [
    DEBATE_MAIN_INTRO,
    extra,
    `주제/요청:\n${task}`,
    `지금은 토론 ${round}번째 왕복의 **당신(메인) 턴**입니다.`,
    backAndForth,
    "지금 턴에만 답하세요(짧게).",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * @param {number} round
 * @param {string} task
 * @param {string} _mainLast
 * @param {Array<{ side: string; round: number; text: string }>} history
 * @param {{ mode?: 'search' | 'chat' }} [style]
 */
export function buildDebateOtherPrompt(
  round,
  task,
  _mainLast,
  history,
  _style = {},
) {
  const lastMain = [...(history || [])]
    .reverse()
    .find((h) => h.side === "main" && h.round === round);
  const mText = (lastMain?.text || _mainLast || "").trim();
  return [
    DEBATE_OTHER_INTRO,
    `주제/요청:\n${task}`,
    `이번 ${round}번째 왕복에서, 방금 **메인 모델**이 말한 내용(당신은 **상대(검수 쪽) 모델**):\n${mText}`,
    "응답·반박·보완을 이어가세요(짧게).",
  ].join("\n\n");
}
