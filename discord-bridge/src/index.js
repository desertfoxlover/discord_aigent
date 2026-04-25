/**
 * Discord ↔ OpenClaw bridge.
 *
 * 봇 하나: DISCORD_TOKEN_GEMINI (또는 예전 이름 DISCORD_TOKEN) 만 설정.
 * 봇 둘: DISCORD_TOKEN_GEMINI + DISCORD_TOKEN_CLAUDE — 앱마다 토큰 발급.
 * 각 봇은 **자신이 멘션되었거나**, **자신의 메시지에 답장**이 온 경우에만 반응합니다.
 *
 * 채널 규칙(CHAT / SEARCH / CODING 채널 ID 목록)은 두 봇 공통입니다.
 * 봇을 둘 다 켠 경우: 재미나이 쪽 @ → `discord-gemini`, 클로드 @ → `discord-claude` (투탑: 한쪽이 전역 기본 모델이 아님, 멘션한 id만 호출).
 */
import { Client, GatewayIntentBits } from "discord.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createOpenClawHttpClient } from "./openclaw-client.js";
import { runDebateExchangeLoop, runPairLoop } from "./orchestrator.js";
import {
  classifyMentionIntent,
  detectDebateIntent,
  detectThreadIntent,
  parseDebateRoundsRequest,
  stripControlPhrasesForModels,
} from "./intent.js";
import {
  buildEditorUserContent,
  buildReviewerUserContent,
  buildChannelTopicRulesBlock,
  buildDiscordChannelContextPrefix,
  buildGuildDescriptionRulesBlock,
  buildDebateMainPrompt,
  buildDebateOtherPrompt,
  CHAT_SINGLE_TURN_PREFIX,
  SEARCH_SINGLE_TURN_PREFIX,
} from "./prompts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

try {
  // Dockerfile WORKDIR /bridge → .env 는 /bridge/.env
  const envPath = join(__dirname, "..", ".env");
  readFileSync(envPath, "utf8")
    .split("\n")
    .forEach((line) => {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (!m) return;
      const k = m[1].trim();
      let v = m[2].trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      if (k && (process.env[k] === undefined || process.env[k] === "")) {
        process.env[k] = v;
      }
    });
} catch {
  /* no .env */
}

const {
  DISCORD_TOKEN = "",
  DISCORD_TOKEN_GEMINI = "",
  DISCORD_TOKEN_CLAUDE = "",
  OPENCLAW_BASE_URL = "http://127.0.0.1:18789",
  /** docker-compose에서 ws://openclaw-gateway:18789 권장 */
  OPENCLAW_GATEWAY_URL = "",
  OPENCLAW_GATEWAY_TOKEN = "",
  /** OpenClaw `agents.list[].id` — Gemini 디스코드 봇이 쓰는 프로필 (기본 discord-gemini) */
  OPENCLAW_AGENT_GEMINI = "discord-gemini",
  /** OpenClaw `agents.list[].id` — Claude 디스코드 봇이 쓰는 프로필 (기본 discord-claude) */
  OPENCLAW_AGENT_CLAUDE = "discord-claude",
  CODING_CHANNEL_IDS = "",
  SEARCH_CHANNEL_IDS = "",
  /** 대화 전용 채널(말동무 등). ID를 넣으면 그 채널에서는 항상 단발 대화. */
  CHAT_CHANNEL_IDS = "",
  MAX_ROUNDS = "8",
  MAX_STALE_REVIEWS = "2",
  /** auto | chat | search | loop — 채널 목록이 전부 비었을 때만 전역 기본 */
  DEFAULT_MENTION_MODE = "auto",
  /**
   * 한 채널 ID가 여러 목록에 동시에 있을 때 우선순위(앞이 우선).
   * 예: coding,search,chat → 코딩+검색 겸용 채널은 코딩 역할
   */
  CHANNEL_LIST_OVERLAP_PRIORITY = "",
  /** 예전 이름: search → 우선순위를 search,coding,chat 으로(CHANNEL_LIST_OVERLAP_PRIORITY가 비었을 때만) */
  OVERLAP_CHANNEL_MODE = "",
  /** 코딩 역할 채널에서만: auto(문장 분류) | loop(항상 편집↔검수 루프) */
  CODING_CHANNEL_MODE = "auto",
  OPENCLAW_CHAT_TIMEOUT_SEC = "240",
  OPENCLAW_SEARCH_TIMEOUT_SEC = "",
  /** 1 이면 서버 설명(guild.description)도 프롬프트에 포함(토픽과 별개) */
  DISCORD_APPEND_GUILD_DESCRIPTION = "",
  /** 서버 설명 최대 글자(넘치면 잘림) */
  DISCORD_GUILD_DESCRIPTION_MAX_CHARS = "1200",
  /** 토론 왕복 횟수(메인+상대 각 1쌍이 1회). `5회` 멘트로 덮어쓰기 */
  DISCORD_DEBATE_ROUNDS = "3",
  /** 1(기본)이면 토론 시 별도 키워드 없이도 스레드에 개설(0이면 스레드 키워드 있을 때만) */
  DISCORD_DEBATE_IN_THREAD = "1",
} = process.env;

const codingSet = new Set(
  CODING_CHANNEL_IDS.split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const searchSet = new Set(
  SEARCH_CHANNEL_IDS.split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const chatSet = new Set(
  CHAT_CHANNEL_IDS.split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const channelListOverlapPriorityEffective =
  CHANNEL_LIST_OVERLAP_PRIORITY.trim() ||
  (OVERLAP_CHANNEL_MODE.toLowerCase().trim() === "search"
    ? "search,coding,chat"
    : "coding,search,chat");

const tokenGemini = (DISCORD_TOKEN_GEMINI || DISCORD_TOKEN).trim();
const tokenClaude = DISCORD_TOKEN_CLAUDE.trim();

/** @type {string[]} */
const discordTokens = [
  ...new Set(
    [tokenGemini, tokenClaude].filter(Boolean),
  ),
];

if (discordTokens.length === 0) {
  console.error(
    "`.env`에 DISCORD_TOKEN_GEMINI(또는 DISCORD_TOKEN) 또는 DISCORD_TOKEN_CLAUDE 중 하나 이상이 필요합니다.",
  );
  try {
    const raw = readFileSync(join(__dirname, "..", ".env"), "utf8");
    const gem = /^DISCORD_TOKEN_GEMINI=(\S+)/m.test(raw);
    const cla = /^DISCORD_TOKEN_CLAUDE=(\S+)/m.test(raw);
    const leg = /^DISCORD_TOKEN=(\S+)/m.test(raw);
    console.error(
      "[debug] /app/.env 에서 =뒤에 값이 있는 줄: GEMINI=%s CLAUDE=%s DISCORD_TOKEN=%s (에디터만 고친 뒤 저장 안 하면 디스크와 다릅니다)",
      gem,
      cla,
      leg,
    );
  } catch (e) {
    console.error("[debug] .env 읽기 실패:", e);
  }
  process.exit(1);
}

const openclaw = OPENCLAW_GATEWAY_TOKEN
  ? createOpenClawHttpClient({
      baseUrl: OPENCLAW_BASE_URL,
      gatewayUrl: OPENCLAW_GATEWAY_URL || undefined,
      token: OPENCLAW_GATEWAY_TOKEN,
    })
  : null;

process.on("unhandledRejection", (reason) => {
  console.error("[discord-bridge] unhandledRejection:", reason);
});

/**
 * Discord REST/WS가 응답 없이 멈추면 `…처리 중…`에서 영원히 안 넘어갈 수 있어 상한을 둠.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`${label} 시간 초과 (${ms}ms)`));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * `…처리 중…`만 보이면 멈춘 것처럼 느껴질 수 있어, 일정 시간 뒤 한 번 짧게 안내를 덧붙인다.
 * @param {import('discord.js').Message} status
 * @param {string} nudgeText
 * @param {number} [delayMs]
 * @returns {() => void} 성공/실패 후 `finally`에서 호출해 타이머 해제
 */
function scheduleStatusNudge(status, nudgeText, delayMs = 45_000) {
  const t = setTimeout(() => {
    status.edit({ content: nudgeText }).catch((e) => {
      console.warn("[discord-bridge] status nudge edit failed:", e);
    });
  }, delayMs);
  return () => clearTimeout(t);
}

function createDiscordClient() {
  return new Client({
    // Message Content Intent 는 Developer Portal → Bot → Privileged Gateway Intents 에서 반드시 켜야 합니다.
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
}

/**
 * @param {'gemini'|'claude'} kind
 */
function resolveOpenClawAgentId(kind) {
  if (kind === "gemini") {
    return (OPENCLAW_AGENT_GEMINI || "discord-gemini").trim() || "discord-gemini";
  }
  return (OPENCLAW_AGENT_CLAUDE || "discord-claude").trim() || "discord-claude";
}

/**
 * @param {'gemini'|'claude'} kind — 멘션한 쪽 = main, 반대 = other (코딩: 편집 / 검수)
 * @returns {{ main: string, other: string }}
 */
function getOpenClawAgentIdPair(/** @type {"gemini"|"claude"} */ kind) {
  const g = (OPENCLAW_AGENT_GEMINI || "discord-gemini").trim() || "discord-gemini";
  const c = (OPENCLAW_AGENT_CLAUDE || "discord-claude").trim() || "discord-claude";
  if (kind === "gemini") {
    return { main: g, other: c };
  }
  return { main: c, other: g };
}

/**
 * @param {import('discord.js').Client} client
 * @param {object} bot
 * @param {'gemini'|'claude'} bot.kind
 */
function attachHandlers(client, bot) {
  const idSingle = resolveOpenClawAgentId(bot.kind);
  const idPair = getOpenClawAgentIdPair(bot.kind);
  client.once("ready", () => {
    console.log(
      `Logged in as ${client.user?.tag} (OpenClaw: single=${idSingle} | coding main=${idPair.main} other=${idPair.other}) (mention or reply)`,
    );
  });

  client.on("messageCreate", async (msg) => {
    try {
      if (msg.author.bot) return;

      const botId = client.user?.id;
      if (!botId) return;

      const replyToBot = await isReplyToBot(msg, botId);
      const mentioned = msg.mentions.users.has(botId);

      if (!mentioned && !replyToBot) return;

      let userText = msg.content.trim();
      if (mentioned) {
        userText = stripMentionOf(userText, botId);
      }
      if (!userText) {
        await msg.reply(
          "무엇을 할지 말해 주세요. 예: `@봇이름 이거 좀 해줘` 또는 이 봇 메시지에 답장.",
        );
        return;
      }

      const channelCtx = resolveChannelContext(msg.channelId);
      if (!channelCtx.allowed) {
        await msg.reply(
          "이 채널은 봇이 응답하도록 설정되지 않았습니다. " +
            "`CHAT_CHANNEL_IDS` / `SEARCH_CHANNEL_IDS` / `CODING_CHANNEL_IDS` 중 하나 이상에 채널 ID를 넣거나, 세 목록을 모두 비워 전체 허용으로 두세요.",
        );
        return;
      }

      if (!openclaw) {
        await msg.reply("OpenClaw가 설정되지 않았습니다 (`OPENCLAW_GATEWAY_TOKEN`).");
        return;
      }

      const wantDebate = detectDebateIntent(userText);
      const wantThread = detectThreadIntent(userText);
      const debateRoundsDefault = (() => {
        const n = Number(DISCORD_DEBATE_ROUNDS);
        return Number.isFinite(n) && n > 0 ? n : 3;
      })();
      const useThreadForDebate =
        wantThread || (wantDebate && String(DISCORD_DEBATE_IN_THREAD).trim() === "1");
      const useThreadForChatSearch = wantThread;
      const textForModel =
        stripControlPhrasesForModels(userText) || userText.trim();
      if (!textForModel && wantDebate) {
        await msg.reply("토론 주제를 짧게라도 써 주세요(키워드만으로는 전달이 애매합니다).");
        return;
      }
      if (wantDebate) {
        const debateRounds = parseDebateRoundsRequest(
          userText,
          debateRoundsDefault,
        );
        const discordCtxPrefix = await buildFullDiscordCtxPrefix(
          msg,
          channelCtx,
        );
        await handleDebateMention(msg, {
          userText: textForModel,
          fullUserText: userText,
          channelCtx,
          discordCtxPrefix,
          pair: getOpenClawAgentIdPair(bot.kind),
          useThread: useThreadForDebate && !msg.channel.isThread(),
          rounds: debateRounds,
        });
        return;
      }

      const defaultMode = normalizeDefaultMode(DEFAULT_MENTION_MODE);
      const action = planMentionAction(userText, channelCtx, defaultMode);

      if (action === "search") {
        await handleSearchMention(
          msg,
          textForModel,
          channelCtx,
          idSingle,
          { useThread: useThreadForChatSearch && !msg.channel.isThread() },
        );
      } else if (action === "chat") {
        await handleChatMention(
          msg,
          textForModel,
          channelCtx,
          idSingle,
          { useThread: useThreadForChatSearch && !msg.channel.isThread() },
        );
      } else {
        const discordCtxPrefix = await buildFullDiscordCtxPrefix(msg, channelCtx);
        await handleCodingMention(
          msg,
          textForModel,
          discordCtxPrefix,
          getOpenClawAgentIdPair(bot.kind),
        );
      }
    } catch (e) {
      console.error("[discord-bridge] messageCreate:", e);
      try {
        if (!msg.author?.bot) {
          await msg.reply(
            truncateDiscord(
              `봇 내부 오류: ${e instanceof Error ? e.message : String(e)}`,
            ),
          );
        }
      } catch (e2) {
        console.error("[discord-bridge] messageCreate error reply failed:", e2);
      }
    }
  });
}

/** @type {{ token: string, kind: "gemini" | "claude" }[]} */
const discordBotEntries = [];
const seenToken = new Set();
for (const { token, kind } of [
  { token: tokenGemini, kind: "gemini" },
  { token: tokenClaude, kind: "claude" },
]) {
  if (!token) continue;
  if (seenToken.has(token)) {
    console.warn(
      `[discord-bridge] token reused for both bots; one client only. Using first kind only.`,
    );
    continue;
  }
  seenToken.add(token);
  discordBotEntries.push({ token, kind });
}

for (const b of discordBotEntries) {
  const client = createDiscordClient();
  attachHandlers(client, b);
  client.login(b.token).catch((e) => {
    console.error("Discord login failed:", e);
    process.exit(1);
  });
}

/**
 * @param {string} raw
 * @returns {('coding'|'search'|'chat')[]}
 */
function parseOverlapPriority(raw) {
  const fallback = ["coding", "search", "chat"];
  const parts = (raw || "")
    .toLowerCase()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allow = new Set(["coding", "search", "chat"]);
  const out = parts.filter((p) => allow.has(p));
  return out.length > 0 ? out : fallback;
}

/**
 * @param {string} [v]
 * @returns {'auto'|'loop'}
 */
function normalizeCodingChannelMode(v) {
  return (v || "auto").toLowerCase().trim() === "loop" ? "loop" : "auto";
}

/**
 * @param {string} channelId
 * @returns {{ allowed: boolean, configuredRole: 'chat'|'search'|'coding'|null, codingSubMode: 'auto'|'loop' }}
 */
function resolveChannelContext(channelId) {
  const anyList =
    codingSet.size > 0 || searchSet.size > 0 || chatSet.size > 0;
  if (!anyList) {
    return {
      allowed: true,
      configuredRole: null,
      codingSubMode: normalizeCodingChannelMode(CODING_CHANNEL_MODE),
    };
  }

  const inChat = chatSet.has(channelId);
  const inCoding = codingSet.has(channelId);
  const inSearch = searchSet.has(channelId);
  if (!inChat && !inCoding && !inSearch) {
    return {
      allowed: false,
      configuredRole: null,
      codingSubMode: normalizeCodingChannelMode(CODING_CHANNEL_MODE),
    };
  }

  const order = parseOverlapPriority(channelListOverlapPriorityEffective);
  /** @type {'chat'|'search'|'coding'|null} */
  let configuredRole = null;
  for (const kind of order) {
    if (kind === "chat" && inChat) {
      configuredRole = "chat";
      break;
    }
    if (kind === "search" && inSearch) {
      configuredRole = "search";
      break;
    }
    if (kind === "coding" && inCoding) {
      configuredRole = "coding";
      break;
    }
  }
  if (!configuredRole) {
    if (inChat) configuredRole = "chat";
    else if (inSearch) configuredRole = "search";
    else configuredRole = "coding";
  }

  return {
    allowed: true,
    configuredRole,
    codingSubMode: normalizeCodingChannelMode(CODING_CHANNEL_MODE),
  };
}

/**
 * @param {string} v
 * @returns {'auto'|'chat'|'search'|'loop'}
 */
function normalizeDefaultMode(v) {
  const s = (v || "auto").toLowerCase();
  if (s === "search") return "search";
  if (s === "chat") return "chat";
  if (s === "loop") return "loop";
  return "auto";
}

/**
 * @param {string} userText
 * @param {{ configuredRole: 'chat'|'search'|'coding'|null, codingSubMode: 'auto'|'loop' }} channelCtx
 * @param {'auto'|'chat'|'search'|'loop'} defaultMode
 * @returns {'loop'|'search'|'chat'}
 */
function planMentionAction(userText, channelCtx, defaultMode) {
  const { configuredRole, codingSubMode } = channelCtx;

  if (configuredRole === "chat") return "chat";
  if (configuredRole === "search") return "search";
  if (configuredRole === "coding") {
    if (codingSubMode === "loop") return "loop";
    return classifyMentionIntent(userText);
  }

  if (defaultMode === "loop") return "loop";
  if (defaultMode === "search") return "search";
  if (defaultMode === "chat") return "chat";
  return classifyMentionIntent(userText);
}

/**
 * @param {import('discord.js').Message} msg
 */
function getChannelDiscordMeta(msg) {
  const guildName = msg.guild?.name ?? null;
  let channelLabel = msg.channelId;
  const ch = msg.channel;
  if (
    ch &&
    typeof ch === "object" &&
    "name" in ch &&
    typeof /** @type {{ name?: string }} */ (ch).name === "string" &&
    ch.name
  ) {
    const n = ch.name;
    channelLabel = n.startsWith("#") ? n : `#${n}`;
  }
  return { guildName, channelLabel, channelId: msg.channelId };
}

const guildDescriptionMaxChars = (() => {
  const n = Number(DISCORD_GUILD_DESCRIPTION_MAX_CHARS);
  return Number.isFinite(n) && n > 0 ? n : 1200;
})();

/**
 * @param {import('discord.js').Message} msg
 * @param {{ configuredRole: 'chat'|'search'|'coding'|null }} channelCtx
 */
async function buildFullDiscordCtxPrefix(msg, channelCtx) {
  const discordMeta = getChannelDiscordMeta(msg);
  let operatorNotes = "";
  try {
    operatorNotes = await withTimeout(
      buildDiscordOperatorNotes(msg),
      12_000,
      "채널 토픽/규칙 로드",
    );
  } catch (e) {
    console.warn("[discord-bridge] operator notes 생략:", e);
  }
  return [
    buildDiscordChannelContextPrefix({
      guildName: discordMeta.guildName,
      channelLabel: discordMeta.channelLabel,
      channelId: discordMeta.channelId,
      configuredRole: channelCtx.configuredRole ?? "unknown",
    }),
    operatorNotes,
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function buildDiscordOperatorNotes(msg) {
  const parts = [];
  const topic = await fetchChannelTopicText(msg.channel);
  const topicBlock = buildChannelTopicRulesBlock(topic);
  if (topicBlock) parts.push(topicBlock);

  if (DISCORD_APPEND_GUILD_DESCRIPTION.trim() === "1" && msg.guild) {
    try {
      let g = msg.guild;
      if (g.partial) {
        g = await withTimeout(g.fetch(), 8_000, "guild.fetch");
      }
      const raw = (g.description && g.description.trim()) || "";
      if (raw) {
        const clipped =
          raw.length > guildDescriptionMaxChars
            ? `${raw.slice(0, guildDescriptionMaxChars)}…`
            : raw;
        const block = buildGuildDescriptionRulesBlock(clipped);
        if (block) parts.push(block);
      }
    } catch {
      /* ignore */
    }
  }

  return parts.length ? parts.join("\n\n") : "";
}

/**
 * @param {import('discord.js').Channel} channel
 */
async function fetchChannelTopicText(channel) {
  try {
    const ch = channel.partial
      ? await withTimeout(channel.fetch(), 8_000, "channel.fetch(topic)")
      : channel;
    if (ch.isThread()) {
      const parent = ch.parent;
      if (!parent) return "";
      const p = parent.partial
        ? await withTimeout(parent.fetch(), 8_000, "parent.fetch(topic)")
        : parent;
      if (
        p &&
        "topic" in p &&
        typeof /** @type {{ topic?: string | null }} */ (p).topic ===
          "string" &&
        p.topic
      ) {
        return p.topic.trim();
      }
      return "";
    }
    if (
      "topic" in ch &&
      typeof /** @type {{ topic?: string | null }} */ (ch).topic ===
        "string" &&
      ch.topic
    ) {
      return ch.topic.trim();
    }
    return "";
  } catch {
    return "";
  }
}

/**
 * @param {import('discord.js').Message} msg
 * @param {string} botId
 */
async function isReplyToBot(msg, botId) {
  if (!msg.reference?.messageId) return false;
  try {
    const ref = await msg.fetchReference();
    return ref.author.id === botId;
  } catch {
    return false;
  }
}

/**
 * @param {string} content
 * @param {string} botUserId
 */
function stripMentionOf(content, botUserId) {
  return content
    .replace(new RegExp(`<@!?${botUserId}>\\s*`, "g"), "")
    .trim();
}

/**
 * @param {import('discord.js').Message} msg
 * @param {string} userText
 */
const searchTimeoutSec = (() => {
  const n = Number(OPENCLAW_SEARCH_TIMEOUT_SEC);
  if (Number.isFinite(n) && n > 0) return n;
  return undefined;
})();

const chatTimeoutSec = (() => {
  const n = Number(OPENCLAW_CHAT_TIMEOUT_SEC);
  if (Number.isFinite(n) && n > 0) return n;
  return 240;
})();

const debateCallTimeoutSec = (() => {
  const n = Number(OPENCLAW_CHAT_TIMEOUT_SEC);
  if (Number.isFinite(n) && n > 0) return Math.min(600, n * 2);
  return 300;
})();

/**
 * @param {import('discord.js').Message} msg
 * @param {object} p
 * @param {string} p.userText
 * @param {{ configuredRole: 'chat'|'search'|'coding'|null }} p.channelCtx
 * @param {string} p.discordCtxPrefix
 * @param {{ main: string, other: string }} p.pair
 * @param {boolean} p.useThread
 * @param {number} p.rounds
 * @param {string} [p.fullUserText] unused; caller may pass for future use
 */
async function handleDebateMention(msg, p) {
  const { userText, channelCtx, discordCtxPrefix, pair, useThread, rounds } = p;
  const styleMode = channelCtx.configuredRole === "search" ? "search" : "chat";
  const sessionBase = `debate-${msg.id}`;
  const taskWithCtx = `${discordCtxPrefix}\n\n[토론: ${rounds}회 왕복 · 메인=${pair.main} · 상대=${pair.other}]\n\n${userText}`;

  const runOpenClaw = (id, m) =>
    openclaw.runAgentMessage({
      message: m,
      sessionKey: `${sessionBase}-${id}-${Date.now()}`,
      agentId: id,
      timeoutSec: debateCallTimeoutSec,
    });

  /** @type {import('discord.js').TextChannel|import('discord.js').ThreadChannel|import('discord.js').DMChannel|import('discord.js').NewsChannel|import('discord.js').AnyThreadChannel|import('discord.js').PublicThreadChannel|import('discord.js').PrivateThreadChannel} */
  let outChannel = msg.channel;
  if (useThread) {
    const th = await msg.startThread({
      name: truncateThreadTitle(userText),
      autoArchiveDuration: 1440,
    });
    outChannel = th;
    await th.send(
      `**토론** ${rounds}회 왕복(메인 \`${pair.main}\` → 상대 \`${pair.other}\` 순서) 시작…`,
    );
  } else {
    const st = await msg.reply(
      `**토론** ${rounds}회 왕복(메인 \`${pair.main}\` / 상대 \`${pair.other}\`) — 이 채널에 차례대로 보냅니다…`,
    );
    if (st.channel) outChannel = st.channel;
  }

  const style = { mode: styleMode === "search" ? "search" : "chat" };
  try {
    await runDebateExchangeLoop({
      task: taskWithCtx,
      buildMainPrompt: (round, task, history) =>
        buildDebateMainPrompt(round, task, history, style),
      buildOtherPrompt: (round, task, lastMain, history) =>
        buildDebateOtherPrompt(round, task, lastMain, history, style),
      runMain: (m) => runOpenClaw(pair.main, m),
      runOther: (m) => runOpenClaw(pair.other, m),
      rounds,
      onNotify: async (n) => {
        if (n.type === "debate" && n.phase) {
          const head =
            n.phase === "main"
              ? `**[왕복 ${n.round} · 메인 \`${pair.main}\`]**`
              : `**[왕복 ${n.round} · 상대 \`${pair.other}\`]**`;
          const body = truncateDiscord(n.text, 1800);
          await outChannel.send({ content: `${head}\n\n${body}` });
        }
      },
    });
    await outChannel.send("— **토론 끝** — (왕복 횟수는 `5회` 등 멘트나 `DISCORD_DEBATE_ROUNDS`로 조절)");
  } catch (e) {
    const em = e instanceof Error ? e.message : String(e);
    await outChannel.send(`**토론 중 오류:** ${truncateDiscord(em, 500)}`);
    console.error("[discord-bridge] handleDebateMention:", e);
  }
}

/**
 * @param {import('discord.js').Message} msg
 * @param {string} userText
 * @param {{ configuredRole: 'chat'|'search'|'coding'|null }} channelCtx
 * @param {string} openclawAgentId
 * @param {{ useThread?: boolean }} [opts]
 */
async function handleSearchMention(
  msg,
  userText,
  channelCtx,
  openclawAgentId,
  opts = {},
) {
  const useThread = Boolean(opts?.useThread);
  /** @type {import('discord.js').Message} */
  let status;
  if (useThread) {
    const th = await msg.startThread({
      name: truncateThreadTitle(userText),
      autoArchiveDuration: 1440,
    });
    status = /** @type {import('discord.js').Message} */ (await th.send(
      "…처리 중 (검색/단발)…",
    ));
  } else {
    status = await msg.reply({
      content: "…처리 중 (검색/단발)…",
      fetchReply: true,
    });
  }
  const clearNudge = scheduleStatusNudge(
    status,
    "…처리 중 (검색/단발) — OpenClaw 응답 대기 중… (느리면 `docker compose logs` 로 게이트웨이·브리지 확인)",
  );
  try {
    console.log("[discord-bridge] search: building context…");
    const discordCtxPrefix = await buildFullDiscordCtxPrefix(msg, channelCtx);
    console.log("[discord-bridge] search: openclaw agent…");
    const answer = await openclaw.runAgentMessage({
      message:
        `${discordCtxPrefix}\n\n${SEARCH_SINGLE_TURN_PREFIX}\n\n---\n\n${userText}`,
      agentId: openclawAgentId,
      ...(searchTimeoutSec ? { timeoutSec: searchTimeoutSec } : {}),
    });
    console.log("[discord-bridge] search: done, editing reply");
    await safeEditStatusMessage(status, msg, truncateDiscord(answer || "(empty)"));
  } catch (e) {
    console.error("[discord-bridge] handleSearchMention:", e);
    await safeEditStatusMessage(
      status,
      msg,
      `Error: ${e instanceof Error ? e.message : e}`,
    );
  } finally {
    clearNudge();
  }
}

/**
 * @param {import('discord.js').Message} msg
 * @param {string} userText
 * @param {{ configuredRole: 'chat'|'search'|'coding'|null }} channelCtx
 * @param {string} openclawAgentId
 * @param {{ useThread?: boolean }} [opts]
 */
async function handleChatMention(
  msg,
  userText,
  channelCtx,
  openclawAgentId,
  opts = {},
) {
  const useThread = Boolean(opts?.useThread);
  /** @type {import('discord.js').Message} */
  let status;
  if (useThread) {
    const th = await msg.startThread({
      name: truncateThreadTitle(userText),
      autoArchiveDuration: 1440,
    });
    status = /** @type {import('discord.js').Message} */ (await th.send(
      "…처리 중 (대화)…",
    ));
  } else {
    status = await msg.reply({
      content: "…처리 중 (대화)…",
      fetchReply: true,
    });
  }
  const clearNudge = scheduleStatusNudge(
    status,
    `…처리 중 (대화) — OpenClaw 응답 대기 중… (기본 ${chatTimeoutSec}초·느리면 \`docker compose logs\` 로 확인)`,
  );
  try {
    console.log("[discord-bridge] chat: building context…");
    const discordCtxPrefix = await buildFullDiscordCtxPrefix(msg, channelCtx);
    console.log("[discord-bridge] chat: openclaw agent…", {
      timeoutSec: chatTimeoutSec,
    });
    const answer = await openclaw.runAgentMessage({
      message:
        `${discordCtxPrefix}\n\n${CHAT_SINGLE_TURN_PREFIX}\n\n---\n\n${userText}`,
      agentId: openclawAgentId,
      timeoutSec: chatTimeoutSec,
    });
    console.log("[discord-bridge] chat: done, editing reply");
    await safeEditStatusMessage(status, msg, truncateDiscord(answer || "(empty)"));
  } catch (e) {
    console.error("[discord-bridge] handleChatMention:", e);
    await safeEditStatusMessage(
      status,
      msg,
      `Error: ${e instanceof Error ? e.message : e}`,
    );
  } finally {
    clearNudge();
  }
}

/**
 * 두 번째 `msg.reply` 대신 첫 답장을 수정 — Discord/봇 환경에서 더 안정적.
 * @param {import('discord.js').Message} status
 * @param {import('discord.js').Message} origMsg
 * @param {string} content
 */
async function safeEditStatusMessage(status, origMsg, content) {
  const text = truncateDiscord(content, 2000);
  try {
    await status.edit({ content: text });
  } catch (e) {
    console.error("[discord-bridge] status.edit failed:", e);
    try {
      if (status.channel && status.channel.isThread()) {
        await status.channel.send({ content: text });
      } else {
        await origMsg.channel.send({
          content: text,
          reply: { messageReference: origMsg.id },
        });
      }
    } catch (e2) {
      console.error("[discord-bridge] channel.send fallback failed:", e2);
    }
  }
}

/**
 * @param {{ main: string, other: string }} pair
 * main = 멘션한 쪽(편집/구현) · other = 상대 모델(검수)
 * @param {import('discord.js').Message} msg
 * @param {string} task
 * @param {string} discordCtxPrefix
 */
async function handleCodingMention(
  msg,
  task,
  discordCtxPrefix,
  pair,
) {
  const thread = await msg.startThread({
    name: truncateThreadTitle(task),
    autoArchiveDuration: 60,
  });

  const sessionBase = `discord-${msg.id}`;
  const taskWithCtx = `${discordCtxPrefix}\n\n${task}`;

  const runEditor = (prompt) =>
    openclaw.runAgentMessage({
      message: prompt,
      sessionKey: `${sessionBase}-editor`,
      agentId: pair.main,
    });

  const runReviewer = (prompt) =>
    openclaw.runAgentMessage({
      message: prompt,
      sessionKey: `${sessionBase}-reviewer`,
      agentId: pair.other,
    });

  await thread.send(
    `**편집(메인·${pair.main}) ↔ 검수(상대·${pair.other})** 루프 시작…`,
  );

  const result = await runPairLoop({
    task: taskWithCtx,
    runEditor,
    runReviewer,
    buildEditorPrompt: (round, prior) =>
      buildEditorUserContent(taskWithCtx, round, prior),
    buildReviewerPrompt: (round, editorOut) =>
      buildReviewerUserContent(taskWithCtx, editorOut, round),
    maxRounds: Number(MAX_ROUNDS) || 8,
    maxStaleReviews: Number(MAX_STALE_REVIEWS) || 2,
    onNotify: async (n) => {
      if (n.type === "round") {
        await thread.send(
          `**Round ${n.round}** · verdict \`${n.verdict}\`\n` +
            `__Editor__:\n${truncateDiscord(n.editorPreview || "")}\n` +
            `__Reviewer__:\n${truncateDiscord(n.reviewerPreview || "")}`,
        );
      } else if (n.type === "complete") {
        await thread.send(`**완료** — 검토자 승인 (round ${n.round}).`);
      } else if (n.type === "blocked") {
        await thread.send(
          `**중단(blocked)** round ${n.round}. 검토 메시지를 확인하세요.`,
        );
      } else if (n.type === "stalemate") {
        await thread.send(
          "**교착** — 같은 피드백이 반복됩니다. 사람이 개입해 주세요.",
        );
      } else if (n.type === "max_rounds") {
        await thread.send("**라운드 상한** 도달로 중지했습니다.");
      } else if (n.type === "error") {
        await thread.send(`**오류:** ${n.message}`);
      }
    },
  });

  await msg.reply(
    `작업 스레드: ${thread}\n**최종 상태:** \`${result.status}\``,
  );

  await thread.send(
    `**최종 상태:** \`${result.status}\`\n${truncateDiscord(
      result.editorOutput || "",
      1500,
    )}`,
  );
}

function truncateDiscord(s, max = 1900) {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

function truncateThreadTitle(task) {
  const base = task.replace(/\s+/g, " ").slice(0, 80);
  return base || "task";
}
