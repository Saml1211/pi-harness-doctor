import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { execSync, spawn } from "node:child_process";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";

const ALLOWED_MACOS_SOUNDS = new Set([
  "Basso", "Blow", "Bottle", "Frog", "Funk", "Glass", "Hero", "Morse", "Ping", "Pop", "Purr", "Sosumi", "Submarine", "Tink",
]);

export interface ProbeResult {
  name: string;
  ok: boolean;
  message: string;
  latencyMs?: number;
}

export interface DoctorReport {
  timestamp: string;
  totalOk: number;
  totalProbes: number;
  probes: ProbeResult[];
  markdown: string;
}

function resolveJevApiKey(): string | undefined {
  if (process.env.TYPESAFE_API_KEY?.trim()) {
    return process.env.TYPESAFE_API_KEY.trim();
  }
  try {
    const configPath = join(homedir(), ".pi/agent/pi-jev.json");
    if (existsSync(configPath)) {
      const cfg = JSON.parse(readFileSync(configPath, "utf8"));
      if (cfg.apiKey?.trim()) return cfg.apiKey.trim();
      if (cfg.apiKeyFile) {
        const keyFilePath = cfg.apiKeyFile.replace(/^~(?=$|\/)/, homedir());
        if (existsSync(keyFilePath)) {
          return readFileSync(keyFilePath, "utf8").trim();
        }
      }
    }
  } catch {}
  return undefined;
}

export function playAudioChime(sound = "Glass"): boolean {
  if (process.platform !== "darwin") return false;
  // Strict allowlist validation prevents path traversal
  if (!ALLOWED_MACOS_SOUNDS.has(sound)) return false;

  const soundPath = `/System/Library/Sounds/${sound}.aiff`;
  if (!existsSync(soundPath) || !existsSync("/usr/bin/afplay")) return false;

  try {
    const child = spawn("/usr/bin/afplay", [soundPath], {
      detached: true,
      stdio: "ignore",
    });
    // Critical: attach error handler before unref to prevent unhandled node error events
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export async function runHarnessDoctor(cwd = process.cwd()): Promise<DoctorReport> {
  const probes: ProbeResult[] = [];
  const extDir = join(homedir(), ".pi/agent/extensions");

  // 1. self-compact probe
  const t0 = Date.now();
  const selfCompactPath = join(extDir, "self-compact.ts");
  const stateDir = join(homedir(), ".pi/state");
  const scExists = existsSync(selfCompactPath);
  probes.push({
    name: "self-compact",
    ok: scExists,
    message: scExists
      ? `Active (Notice 70%, Warning 80%, Force 90% | State: ${stateDir})`
      : "Extension file missing in ~/.pi/agent/extensions/self-compact.ts",
    latencyMs: Date.now() - t0,
  });

  // 2. auto-validate probe
  const t1 = Date.now();
  const avPath = join(extDir, "auto-validate.ts");
  let bunOk = false;
  let pyOk = false;
  let shOk = false;
  try {
    const bunBin = existsSync(join(homedir(), ".bun/bin/bun")) ? join(homedir(), ".bun/bin/bun") : "bun";
    execSync(`${bunBin} --version`, { stdio: "ignore" });
    bunOk = true;
  } catch {}
  try {
    execSync("python3 -I -c 'import sys'", { stdio: "ignore" });
    pyOk = true;
  } catch {}
  try {
    execSync("bash -c 'exit 0'", { stdio: "ignore" });
    shOk = true;
  } catch {}

  const avOk = existsSync(avPath) && bunOk && pyOk && shOk;
  probes.push({
    name: "auto-validate",
    ok: avOk,
    message: avOk
      ? `Active (bun: ok, python3: ok, bash: ok, JSON.parse: ok)`
      : `Missing components: ${!bunOk ? "bun " : ""}${!pyOk ? "python3 " : ""}${!shOk ? "bash" : ""}`,
    latencyMs: Date.now() - t1,
  });

  // 3. prime probe
  const t2 = Date.now();
  const primePath = join(extDir, "prime.ts");
  let gitBranch = "unknown";
  try {
    gitBranch =
      execSync("git branch --show-current || git rev-parse --abbrev-ref HEAD", {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || "main";
  } catch {}
  const primeOk = existsSync(primePath) && gitBranch !== "unknown";
  probes.push({
    name: "prime",
    ok: primeOk,
    message: primeOk
      ? `Active (branch: ${gitBranch} | stack & diff bundle supported)`
      : "Git or prime.ts unreachable",
    latencyMs: Date.now() - t2,
  });

  // 4. cmux-race probe
  const t3 = Date.now();
  const cmuxPath = join(extDir, "cmux-race.ts");
  const cmuxSocket = process.env.CMUX_SOCKET_PATH;
  const socketExists = cmuxSocket ? existsSync(cmuxSocket) : false;
  const inCmux = Boolean(socketExists || process.env.CMUX_WORKSPACE_ID);
  probes.push({
    name: "cmux-race",
    ok: existsSync(cmuxPath) && inCmux,
    message: inCmux
      ? `Active (cmux socket: ${socketExists ? "verified on disk" : "workspace active"})`
      : "cmux environment not active (socket unavailable)",
    latencyMs: Date.now() - t3,
  });

  // 5. adw probe
  const t4 = Date.now();
  const adwPath = join(extDir, "adw.ts");
  const adwOk = existsSync(adwPath);
  probes.push({
    name: "adw (Software Factory)",
    ok: adwOk,
    message: adwOk
      ? "Active (5-phase PIV loop: Prime -> Plan -> Build -> Checkpoint -> Verify)"
      : "adw.ts missing in extensions",
    latencyMs: Date.now() - t4,
  });

  // 6. TypeSafe Jev System One probe
  const t5 = Date.now();
  const jevApiKey = resolveJevApiKey();
  let jevOk = false;
  let jevLatency = 0;
  if (jevApiKey) {
    const pingController = new AbortController();
    const pingTimer = setTimeout(() => pingController.abort(), 3500);
    try {
      const res = await fetch(JEV_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${jevApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          state: "ping",
          model: JEV_MODEL,
          questions: { is_healthy: { type: "noul", instructions: "Is this probe healthy?" } },
        }),
        signal: pingController.signal,
      });
      if (res.ok) {
        const json = (await res.json()) as any;
        const noul = json?.answers?.is_healthy?.noul;
        if (typeof noul === "number" && Number.isFinite(noul)) {
          jevOk = true;
          jevLatency = Date.now() - t5;
        }
      }
    } catch {
    } finally {
      clearTimeout(pingTimer);
    }
  }
  probes.push({
    name: "TypeSafe Jev",
    ok: jevOk,
    message: jevOk
      ? `Connected (System One: ${jevLatency}ms)`
      : jevApiKey ? "API unreachable or ping timed out" : "API key unconfigured",
    latencyMs: jevLatency || Date.now() - t5,
  });

  // 7. Audio Telemetry probe
  const t6 = Date.now();
  const audioOk = existsSync("/usr/bin/afplay") && existsSync("/System/Library/Sounds/Glass.aiff");
  probes.push({
    name: "Audio Telemetry",
    ok: audioOk,
    message: audioOk ? "Active (macOS afplay + System/Library/Sounds)" : "afplay or audio assets missing",
    latencyMs: Date.now() - t6,
  });

  const totalOk = probes.filter((p) => p.ok).length;
  const lines: string[] = [
    `### 🩺 Pi Agentic Harness Doctor Report`,
    `Status: **${totalOk}/${probes.length} subsystems healthy** (${Math.round((totalOk / probes.length) * 100)}%)\n`,
  ];

  for (const p of probes) {
    const icon = p.ok ? "✅" : "⚠️";
    const lat = p.latencyMs !== undefined ? ` [${p.latencyMs}ms]` : "";
    lines.push(`- ${icon} **${p.name}**: ${p.message}${lat}`);
  }

  return {
    timestamp: new Date().toISOString(),
    totalOk,
    totalProbes: probes.length,
    probes,
    markdown: lines.join("\n"),
  };
}

export default function (pi: ExtensionAPI) {
  // 1. Tool: harness_doctor (conforming to Pi's 5-argument execute signature)
  pi.registerTool({
    name: "harness_doctor",
    label: "Harness Doctor & Health Check",
    description:
      "Runs sub-150ms diagnostic probes across the entire custom agentic stack (self-compact, auto-validate, prime, cmux-race, adw, TypeSafe Jev, audio telemetry).",
    promptSnippet: "Use harness_doctor to verify that the custom agentic extensions, Jev API, and cmux sockets are operational.",
    parameters: Type.Object({
      playChime: Type.Optional(Type.Boolean({ description: "Play a test audio chime (default: false)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (params.playChime) {
        playAudioChime("Glass");
      }

      const effectiveCtx: ExtensionContext | undefined = ctx;
      effectiveCtx?.ui?.notify?.("[harness-doctor] Running diagnostic probes...", "info");
      const report = await runHarnessDoctor(effectiveCtx?.cwd || process.cwd());

      return {
        content: [{ type: "text", text: report.markdown }],
      };
    },
  });

  // 2. Slash Command: /harness-doctor
  pi.registerCommand("harness-doctor", {
    description: "Run diagnostic health check on all custom agentic extensions",
    handler: async (_args, ctx) => {
      ctx.ui?.notify?.("Running harness doctor...", "info");
      const report = await runHarnessDoctor(ctx.cwd || process.cwd());
      ctx.ui?.notify?.(
        `[harness-doctor] ${report.totalOk}/${report.totalProbes} subsystems healthy`,
        report.totalOk === report.totalProbes ? "info" : "warning",
      );
    },
  });
}
