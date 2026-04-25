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
  /** CLI --timeout 미지정·멈춤 시에도 프로세스가 무한 대기하지 않게 기본값 보수적으로 */
  const timeoutSec = opts.timeoutSec ?? 180;

  /**
   * @param {object} p
   * @param {string} p.message
   * @param {string} [p.sessionKey]
   * @param {string} [p.agentId]
   * @param {string} [p.model] CLI에 --model 없음; 프롬프트로만 구분
   * @param {number} [p.timeoutSec] 미지정 시 클라이언트 생성 시 기본값(초)
   */
  async function runAgentMessage(p) {
    const sessionId = p.sessionKey ?? `discord-${Date.now()}`;
    const agentId = p.agentId ?? "main";
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
    };

    /**
     * spawnSync 는 이벤트 루프를 막아 Discord.js 하트비트/후속 reply 가 죽을 수 있음 → spawn + Promise.
     * wallTimeoutMs: CLI --timeout 보다 약간 여유.
     */
    const wallTimeoutMs = Math.min((runTimeout + 120) * 1000, 900_000);

    console.error(
      `[openclaw-cli] spawn agent session=${sessionId} cliTimeoutSec=${runTimeout} wallMs=${wallTimeoutMs} gw=${gatewayUrl}`,
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
      const tail = (errText || outText).slice(-4500);
      throw new Error(`OpenClaw agent 실패 (exit ${code}): ${tail}`);
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
