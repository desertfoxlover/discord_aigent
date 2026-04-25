/**
 * 멘션 한 번에 어떤 모드로 갈지 휴리스틱 분류.
 * - loop: 저장소/파일·폴더를 건드리는 작업 요청
 * - search: 웹·사실 조회 성격
 * - chat: 그 외 대화
 */

const LOOP_KO =
  /(?:수정|구현|고쳐|바꿔|추가해|삭제해|리팩(?:토링)?|패치|머지|커밋|파일|폴더|디렉(?:토리|터리)|경로|워크스페이스|코드베이스|레포|에이전트\.?md|readme)/i;
const LOOP_EN =
  /\b(?:edit|modify|change|implement|refactor|patch|fix)\b.*\b(?:file|files|folder|directory|codebase|repo|workspace)\b/i;
const LOOP_EN2 =
  /\b(?:implement|refactor|patch)\b|\b(?:fix|change)\s+(?:the|a)\s+(?:bug|code|file)/i;

const WIN_PATH = /[A-Za-z]:[\\/][^\s]+/;
const POSIX_PATH =
  /(?:^|[\s"'([{])(?:\.{0,2}\/|[\w.-]+\/)+[\w./-]+\.\w{1,8}\b/;
const CODE_EXT =
  /\.(?:ts|tsx|js|mjs|cjs|jsx|json|md|mdx|py|go|rs|java|kt|cs|cpp|h|yaml|yml|toml|sh|dockerfile)\b/i;

const SEARCH_KO =
  /(?:검색|찾아|조사|알아봐|검색해|웹에서|구글|실시간|최신|뉴스|자료)\s*(?:해|줘)?|뭐\s*야\?|무엇\s*인지/;
const SEARCH_EN =
  /\b(?:search|look\s*up|google|research|web\s*search)\b|\bfind\s+(?:out|information)\b/i;

/**
 * @param {string} raw
 * @returns {'loop' | 'search' | 'chat'}
 */
export function classifyMentionIntent(raw) {
  const text = (raw || "").trim();
  if (!text) return "chat";

  const hasPathLike =
    WIN_PATH.test(text) ||
    POSIX_PATH.test(text) ||
    /[\\/][\w.-]+\.[A-Za-z]{1,8}\b/.test(text) ||
    /\b(?:src|app|lib|test|tests|packages|discord-bridge|openclaw)\/[./\w-]+/i.test(
      text,
    );

  const hasCodeExt = CODE_EXT.test(text);
  const loopKo = LOOP_KO.test(text);
  const loopEn = LOOP_EN.test(text) || LOOP_EN2.test(text);

  const loopScore =
    (hasPathLike ? 2 : 0) +
    (hasCodeExt ? 2 : 0) +
    (loopKo || loopEn ? 1 : 0);

  const searchKo = SEARCH_KO.test(text);
  const searchEn = SEARCH_EN.test(text);
  const searchScore = (searchKo ? 2 : 0) + (searchEn ? 2 : 0);

  if (loopScore >= 2 || (loopScore >= 1 && hasPathLike)) return "loop";
  if (loopScore >= 1 && searchScore < 2) return "loop";
  if (searchScore >= 2) return "search";
  if (searchScore >= 1 && !hasPathLike && !hasCodeExt) return "search";

  return "chat";
}

/** 스레드에서 진행/스레드 열기 등(봇에 스레드 권한 필요) */
const THREAD_INTENT =
  /(?:스레드|쓰레드|쓰래드|thread)\s*(?:에서|로|에|열라|열어|생성|만들어)?|in\s*[\s'"]*a?\s*thread|스레드\s*열/i;

/**
 * 두 모델 토론(왕복) — 검색/대화 톤이어도 토론 루트로 감지되면 `handleDebateMention` 으로 보냄
 */
const DEBATE_INTENT =
  /(?:토론|의견\s*교환|양\s*측|양\s*모델|둘\s*다|양쪽|찬\s*반|pro\s*and\s*con|devil'?s?\s*advocate|멀티.{0,2}(?:뷰|view)|다각도)/i;

/**
 * @param {string} raw
 * @param {string} [defaultRounds=3] env `DISCORD_DEBATE_ROUNDS` 를 넘기면 됨
 * @returns {number} 1~20
 */
export function parseDebateRoundsRequest(raw, defaultRounds = 3) {
  const text = (raw || "").trim();
  const m = text.match(
    /(\d{1,2})\s*(?:번|회|round|rounds|라운드|망)\s*(?:왕복|토론|이상|까지)?/i,
  );
  if (m) {
    return Math.min(20, Math.max(1, parseInt(m[1], 10)));
  }
  const d = Number(defaultRounds);
  return Math.min(20, Math.max(1, Number.isFinite(d) && d > 0 ? d : 3));
}

/**
 * @param {string} raw
 */
export function detectThreadIntent(raw) {
  return THREAD_INTENT.test((raw || "").trim());
}

/**
 * @param {string} raw
 */
export function detectDebateIntent(raw) {
  return DEBATE_INTENT.test((raw || "").trim());
}

/**
 * 모델에 넣기 전 토론/스레드 키워드만 느슨하게 제거(의미 토막이 남을 수 있음).
 * @param {string} raw
 */
export function stripControlPhrasesForModels(raw) {
  let t = (raw || "").trim();
  t = t.replace(THREAD_INTENT, " ");
  t = t.replace(DEBATE_INTENT, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t || (raw || "").trim();
}
