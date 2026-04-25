import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const envPath = join(root, ".env");
const profilePath = join(
  root,
  "data/config/agents/main/agent/auth-profiles.json",
);

function parseEnv(text) {
  const out = {};
  const body = text.replace(/^\uFEFF/, "");
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (k) out[k] = v;
  }
  return out;
}

const env = parseEnv(readFileSync(envPath, "utf8"));
const gem =
  env.GEMINI_API_KEY || env.GOOGLE_API_KEY || env.GOOGLE_AI_API_KEY || "";
const ant = env.ANTHROPIC_API_KEY || "";

const p = JSON.parse(readFileSync(profilePath, "utf8"));
if (!p.profiles) p.profiles = {};
if (gem && p.profiles["google:default"]) p.profiles["google:default"].key = gem;
if (ant && p.profiles["anthropic:default"])
  p.profiles["anthropic:default"].key = ant;

writeFileSync(profilePath, `${JSON.stringify(p, null, 2)}\n`);
console.log("synced auth-profiles.json from .env");
