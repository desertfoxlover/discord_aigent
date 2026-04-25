/**
 * OpenClaw: HTTP `/v1/agent/run` 은 게이트웨이에 없을 수 있음(404).
 * 대신 이미지에 포함된 `openclaw.mjs agent` CLI로 WebSocket 게이트웨이에 요청합니다.
 *
 * 컨테이너 환경: `OPENCLAW_GATEWAY_URL=ws://openclaw-gateway:18789`, `OPENCLAW_GATEWAY_TOKEN`
 * 로컬 npm start: `OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789` (또는 미설정 시 baseUrl에서 추론)
 */
import { spawn } from "node:child_process";

const OPENCLAW_ENTRY = "/app/openclaw.mjs";
const MAX_IO_BYTES = 50 * 1024 * 1024;

/**
 * CLI stderr/stdout 이 수만 자일 수 있어 Discord 2000자·50035 를 유발 — 짧은 사용자 메시지로 압축
 * @param {string} combined
 * @param {number | null} code
 * @param {string} hint
 */
function compactOpenClawCliErrorMessage(combined, code, hint) {
  const low = combined.toLowerCase();
  const unknown = combined.match(/unknown agent id "([^"]+)"/i);
  if (unknown) {
    return (
      `게이트웨이에 없는 에이전트 id: "${unknown[1]}". ` +
      "`openclaw.json`의 `agents.list`에 이 id가 있고 `OPENCLAW_CONFIG_DIR`이 게이트웨이에 마운트됐는지 확인한 뒤 `docker compose restart openclaw-gateway`."
    );
  }
  if (
    low.includes("exceeded your current quota") ||
    (low.includes("429") &&
      (low.includes("google") ||
        low.includes("gemini") ||
        low.includes("generativelanguage")))
  ) {
    return (
      "Google Gemini API: 쿼터/결제 한도(429). AI Studio·Cloud 콘솔에서 할당량·결제를 확인하세요."
    );
  }
  if (low.includes("billing issue") && low.includes("anthropic")) {
    return "Anthropic: billing(결제/쿼터)으로 모델이 비활성화된 로그가 있습니다. API 키·크레딧을 확인하세요.";
  }
  if (low.includes("all models failed") || low.includes("fallbacksummaryerror")) {
    return (
      "모든 후보 모델이 실패했습니다(429·billing 등). `docker compose logs openclaw-gateway`에서 model-fallback 줄을 확인하세요."
    );
  }
  const tail = combined.replace(/\s+/g, " ").trim().slice(-1200);
  return `OpenClaw agent 실패 (exit ${code ?? "?"}): ${tail}${hint}`;
}

/**
 * @param {string | undefined} raw
 * @returns {string}
 * @throws {Error} 투탑(동등) 정책: 한쪽이 기본 모델이 되지 않으므로 `agentId` 는 반드시 호출 측에서(멘션한 봇에 맞게) 넘김
 */
function requireAgentId(raw) {
  if (raw != null) {
    const t = String(raw).trim();
    if (t !== "") return t;
  }
  throw new Error(
    "OpenClaw: agentId 가 비었습니다. `main`·단일 기본 모델을 쓰지 않습니다(투탑: @재미나이→discord-gemini, @클로드→discord-claude). 브리지 버그로 보이면 report 하세요.",
  );
}

/**
 * @param {object} opts
 * @param {string} [opts.baseUrl] 레거시: http URL이면 ws로 바꿔 fallback
 * @param {string} [opts.gatewayUrl] ws://openclaw-gateway:18789
 * @param {string} opts.token OPENCLAW_GATEWAY_TOKEN
 * @param {number} [opts.timeoutSec]
 */
export function createOpenClawHttpClient(opts) {
  const token = opts.token;
  const gatewayUrl = normalizeGatewayWsUrl(
    opts.gatewayUrl ||
      process.env.OPENCLAW_GATEWAY_URL ||
      httpToWs(opts.baseUrl) ||
      "ws://openclaw-gateway:18789",
  );
  const httpBase = resolveHttpBaseForHealth(
    opts.baseUrl || process.env.OPENCLAW_BASE_URL,
    gatewayUrl,
  );
  let lastHealthOkAt = 0;
  const healthCacheMs = 12_000;

  /** 스폰 전에 /healthz 로 게이트웨이가 살아 있는지 확인(캐시로 과다 요청 방지) */
  async function ensureGatewayReachable() {
    if (Date.now() - lastHealthOkAt < healthCacheMs) return;
    const url = `${httpBase}/healthz`;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 10_000);
    try {
      const r = await fetch(url, { signal: ac.signal });
      if (!r.ok) {
        throw new Error(`HTTP ${r.status} ${r.statusText || ""}`.trim());
      }
      lastHealthOkAt = Date.now();
      console.error(`[openclaw-cli] healthz ok ${url}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `게이트웨이 healthz 실패 (${url}): ${msg} — ` +
          "`docker compose ps` 로 openclaw-gateway 가 healthy 인지, " +
          "`OPENCLAW_BASE_URL` 이 컨테이너에선 `http://openclaw-gateway:18789` 인지, " +
          "`OPENCLAW_GATEWAY_TOKEN` 이 게이트웨이·브리지에서 동일한지 확인하세요.",
      );
    } finally {
      clearTimeout(t);
    }
  }

  /** CLI --timeout 미지정·멈춤 시에도 프로세스가 무한 대기하지 않게 기본값 보수적으로 */
  const timeoutSec = opts.timeoutSec ?? 180;

  /**
   * @param {object} p
   * @param {string} p.message
   * @param {string} [p.sessionKey]
   * @param {string} p.agentId `openclaw.json` `agents.list[].id` — 멘션한 봇에 맞는 id 필수(전역 기본 모델 없음)
   * @param {string} [p.model] CLI에 --model 없음; 프롬프트로만 구분
   * @param {number} [p.timeoutSec] 미지정 시 클라이언트 생성 시 기본값(초)
   */
  async function runAgentMessage(p) {
    await ensureGatewayReachable();
    const sessionId = p.sessionKey ?? `discord-${Date.now()}`;
    const agentId = requireAgentId(p.agentId);
    const runTimeout =
      typeof p.timeoutSec === "number" && p.timeoutSec > 0
        ? p.timeoutSec
        : timeoutSec;
    const args = [
      OPENCLAW_ENTRY,
      "agent",
      "--agent",
      agentId,
      "--session-id",
      sessionId,
      "--message",
      p.message,
      "--json",
      "--timeout",
      String(runTimeout),
    ];

    const env = {
      ...process.env,
      OPENCLAW_GATEWAY_URL: gatewayUrl,
      OPENCLAW_GATEWAY_TOKEN: token,
      HOME: process.env.HOME || "/home/node",
      // 일부 .env에 `OPENCLAW_AGENT_ID=main` 등이 남아 임베드/CLI가 --agent 대신 쓰는 사례 방지(투탑=명시 id만)
      OPENCLAW_AGENT_ID: agentId,
    };

    /**
     * spawnSync 는 이벤트 루프를 막아 Discord.js 하트비트/후속 reply 가 죽을 수 있음 → spawn + Promise.
     * wallTimeoutMs: CLI --timeout 보다 약간 여유.
     */
    const wallTimeoutMs = Math.min((runTimeout + 120) * 1000, 900_000);

    console.error(
      `[openclaw-cli] spawn agent agentId=${agentId} session=${sessionId} cliTimeoutSec=${runTimeout} wallMs=${wallTimeoutMs} gw=${gatewayUrl}`,
    );

    const { code, signal, stdout, stderr } = await spawnOpenClawAgent({
      execPath: process.execPath,
      args,
      env,
      cwd: "/app",
      wallTimeoutMs,
    });

    console.error(
      `[openclaw-cli] exit code=${code} signal=${signal ?? "none"} stdout=${stdout.length}b stderr=${stderr.length}b`,
    );

    if (signal === "SIGKILL" || (code === null && signal)) {
      throw new Error(
        `OpenClaw agent 시간 초과 또는 강제 종료(상한 약 ${Math.round(wallTimeoutMs / 1000)}초, signal=${signal ?? "?"}) ` +
          `— 게이트웨이 healthy·OPENCLAW_GATEWAY_TOKEN·EROFS·ws://openclaw-gateway:18789 확인.`,
      );
    }

    const errText = stderr.trim();
    const outText = stdout.trim();

    if (code !== 0) {
      const combined = `${errText}\n${outText}`;
      const low = combined.toLowerCase();
      const hint =
        low.includes("gateway agent failed") || low.includes("unknown agent id")
          ? " (웹소켓/토큰·openclaw.json 도 `docker compose logs openclaw-gateway` 로 확인)"
          : "";
      const short = compactOpenClawCliErrorMessage(
        combined,
        code,
        hint,
      );
      throw new Error(short);
    }

    try {
      return extractAssistantText(JSON.parse(outText));
    } catch {
      return outText;
    }
  }

  return {
    runAgentMessage,
    /** @deprecated */
    runAgent: async () => {
      throw new Error("runAgent 미구현 — runAgentMessage 사용");
    },
    gatewayUrl,
    httpBase,
  };
}

/**
 * @param {object} o
 * @param {string} o.execPath
 * @param {string[]} o.args
 * @param {NodeJS.ProcessEnv} o.env
 * @param {string} o.cwd
 * @param {number} o.wallTimeoutMs
 * @returns {Promise<{ code: number | null, signal: NodeJS.Signals | null, stdout: string, stderr: string }>}
 */
function spawnOpenClawAgent(o) {
  return new Promise((resolve, reject) => {
    const child = spawn(o.execPath, o.args, {
      env: o.env,
      cwd: o.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const t = setTimeout(() => {
      console.error(
        `[openclaw-cli] wall timeout ${o.wallTimeoutMs}ms → SIGKILL pid=${child.pid}`,
      );
      child.kill("SIGKILL");
    }, o.wallTimeoutMs);

    let settled = false;
    const safeReject = (/** @type {Error} */ err) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      reject(err);
    };
    const safeResolve = (
      /** @type {{ code: number | null, signal: NodeJS.Signals | null, stdout: string, stderr: string }} */ v,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve(v);
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > MAX_IO_BYTES) {
        safeReject(new Error("OpenClaw agent stdout 한도 초과"));
      }
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > MAX_IO_BYTES) {
        safeReject(new Error("OpenClaw agent stderr 한도 초과"));
      }
    });

    child.on("error", (err) => {
      safeReject(err instanceof Error ? err : new Error(String(err)));
    });

    child.on("close", (code, signal) => {
      safeResolve({ code, signal, stdout, stderr });
    });
  });
}

/**
 * compose 서비스명은 `openclaw-gateway`. `openclaw_gateway` 로 적으면 DNS 실패·장시간 대기가 날 수 있음.
 * @param {string} url
 */
function normalizeGatewayWsUrl(url) {
  if (!url || typeof url !== "string") return url;
  return url.replace(/openclaw_gateway/gi, "openclaw-gateway");
}

/**
 * @param {string} [httpUrl]
 */
function httpToWs(httpUrl) {
  if (!httpUrl || typeof httpUrl !== "string") return "";
  const u = httpUrl.replace(/\/$/, "");
  if (u.startsWith("http://")) return `ws://${u.slice("http://".length)}`;
  if (u.startsWith("https://")) return `wss://${u.slice("https://".length)}`;
  return "";
}

/**
 * `fetch(/healthz)` 는 HTTP 기준 주소가 필요하다. `OPENCLAW_BASE_URL` 이 없으면 `OPENCLAW_GATEWAY_URL` 의 ws 를 http 로 바꿔 쓴다.
 * @param {string | undefined} baseUrl
 * @param {string} gatewayWsUrl
 */
function resolveHttpBaseForHealth(baseUrl, gatewayWsUrl) {
  const b = (baseUrl || "").trim().replace(/\/$/, "");
  if (b && /^https?:\/\//i.test(b)) return b;
  const g = (gatewayWsUrl || "").trim();
  if (g.startsWith("ws://")) {
    const host = g.slice("ws://".length).split("/")[0];
    return `http://${host}`;
  }
  if (g.startsWith("wss://")) {
    const host = g.slice("wss://".length).split("/")[0];
    return `https://${host}`;
  }
  return "http://127.0.0.1:18789";
}

/**
 * @param {unknown} data
 */
function extractAssistantText(data) {
  if (data == null) return "";
  if (typeof data === "string") return data;
  if (typeof data === "object") {
    const o = /** @type {Record<string, unknown>} */ (data);
    for (const k of [
      "text",
      "output",
      "message",
      "reply",
      "content",
      "body",
      "assistant",
    ]) {
      if (typeof o[k] === "string") return o[k];
    }
    if (o.result && typeof o.result === "object") {
      return extractAssistantText(o.result);
    }
    if (Array.isArray(o.messages) && o.messages.length > 0) {
      const last = o.messages[o.messages.length - 1];
      if (last && typeof last === "object" && last !== null) {
        const m = /** @type {Record<string, unknown>} */ (last);
        if (typeof m.content === "string") return m.content;
        return extractAssistantText(m);
      }
    }
  }
  try {
    return JSON.stringify(data).slice(0, 15000);
  } catch {
    return String(data);
  }
}
