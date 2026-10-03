import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync, execSync, spawn } from "node:child_process";
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
  /** Not applicable on this platform: shown, but excluded from the pass count. */
  na?: boolean;
}

export interface DoctorOptions {
  /** Pi's registry (getAllTools/getCommands/getSettings); lets detection see package-installed extensions. */
  pi?: Partial<Pick<ExtensionAPI, "getAllTools" | "getCommands" | "getSettings">>;
  platform?: NodeJS.Platform;
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

// ponytail: mirrors self-compact's resolveConfig (same env vars, defaults, ordering rule) instead of
// importing it, since the extensions ship as separate repos. Update both if the thresholds change.
export function selfCompactThresholds(env: NodeJS.ProcessEnv = process.env): string {
  const pct = (v: string | undefined, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 10 && n <= 99 ? Math.round(n) : d;
  };
  let [nudge, auto, force] = [pct(env.PI_SELF_COMPACT_WARNING_PCT, 70), pct(env.PI_SELF_COMPACT_AUTO_PCT, 80), pct(env.PI_SELF_COMPACT_FORCE_PCT, 88)];
  if (!(nudge < auto && auto < force)) [nudge, auto, force] = [70, 80, 88];
  return `Nudge ${nudge}%, Auto-compact ${auto}%, Force ${force}%`;
}

// Installed = registered with Pi (also true for `pi install` packages) OR the legacy extensions/<file> exists.
function detect(pi: DoctorOptions["pi"], extDir: string, file: string, tools: string[], commands: string[]): "loaded" | "file present" | null {
  try {
    const t = new Set(pi?.getAllTools?.().map((x) => x.name));
    const c = new Set(pi?.getCommands?.().map((x) => x.name));
    if (tools.some((n) => t.has(n)) || commands.some((n) => c.has(n))) return "loaded";
  } catch {}
  return existsSync(join(extDir, file)) ? "file present" : null;
}

const notFound = (file: string) => `Not registered with Pi and ~/.pi/agent/extensions/${file} not found`;

// No shell: cmd.exe on Windows does not honour single quotes.
function runs(cmd: string, args: string[], input?: string): boolean {
  try {
    execFileSync(cmd, args, { stdio: [input === undefined ? "ignore" : "pipe", "ignore", "ignore"], input });
    return true;
  } catch {
    return false;
  }
}

// Windows: `bash` on PATH may be WSL, so probe the shell Pi itself would use (Git Bash by default).
async function shellWorks(win: boolean, shellPath?: string): Promise<boolean> {
  if (!win) return runs("bash", ["-c", "exit 0"]);
  try {
    const { getShellConfig } = await import("@earendil-works/pi-coding-agent");
    const c = getShellConfig(shellPath);
    return c.commandTransport === "stdin" ? runs(c.shell, c.args, "exit 0\n") : runs(c.shell, [...c.args, "exit 0"]);
  } catch {}
  return runs(join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"), ["-c", "exit 0"]);
}

export async function runHarnessDoctor(cwd = process.cwd(), opts: DoctorOptions = {}): Promise<DoctorReport> {
  const probes: ProbeResult[] = [];
  const extDir = join(homedir(), ".pi/agent/extensions");
  const { pi } = opts;
  const win = (opts.platform ?? process.platform) === "win32";

  // 1. self-compact probe
  const t0 = Date.now();
  const sc = detect(pi, extDir, "self-compact.ts", ["self_compact"], ["self-compact"]);
  const stateDir = process.env.PI_SELF_COMPACT_STATE_DIR || join(homedir(), ".pi/state/continuation-notes"); // matches self-compact
  probes.push({
    name: "self-compact",
    ok: !!sc,
    message: sc
      ? `Installed (${sc}; ${selfCompactThresholds()} | State: ${stateDir})`
      : notFound("self-compact.ts"),
    latencyMs: Date.now() - t0,
  });

  // 2. auto-validate probe
  const t1 = Date.now();
  const av = detect(pi, extDir, "auto-validate.ts", [], ["auto-validate"]);
  let bunOk = false;
  let pyOk = false;
  let shOk = false;
  try {
    const bunBin = existsSync(join(homedir(), ".bun/bin/bun")) ? join(homedir(), ".bun/bin/bun") : "bun";
    execSync(`${bunBin} --version`, { stdio: "ignore" });
    bunOk = true;
  } catch {}
  const pyArgs = ["-I", "-c", "import sys"];
  pyOk = runs("python3", pyArgs) || (win && runs("python", pyArgs));
  shOk = await shellWorks(win, pi?.getSettings?.().shellPath);

  const avOk = !!av && bunOk && pyOk && shOk;
  probes.push({
    name: "auto-validate",
    ok: avOk,
    message: avOk
      ? `Installed (${av}); checker binaries present (bun, ${win ? "python" : "python3"}, ${win ? "shell" : "bash"})`
      : [
          av ? "" : notFound("auto-validate.ts"),
          bunOk && pyOk && shOk ? "" : `Missing components: ${[!bunOk && "bun", !pyOk && "python3", !shOk && "bash"].filter(Boolean).join(" ")}`,
        ].filter(Boolean).join("; "),
    latencyMs: Date.now() - t1,
  });

  // 3. prime probe
  const t2 = Date.now();
  const prime = detect(pi, extDir, "prime.ts", ["prime"], ["prime"]);
  let gitBranch = "unknown";
  try {
    gitBranch =
      execSync("git branch --show-current || git rev-parse --abbrev-ref HEAD", {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || "main";
  } catch {}
  const primeOk = !!prime && gitBranch !== "unknown";
  probes.push({
    name: "prime",
    ok: primeOk,
    message: primeOk
      ? `Installed (${prime}; git branch here: ${gitBranch})`
      : !prime ? notFound("prime.ts") : "Git unreachable (no branch here)",
    latencyMs: Date.now() - t2,
  });

  // 4. cmux-race probe
  const t3 = Date.now();
  const cmux = detect(pi, extDir, "cmux-race.ts", ["cmux_race"], ["cmux-race"]);
  const cmuxSocket = process.env.CMUX_SOCKET_PATH;
  // An env var alone, or an ordinary file at that path, is not a socket (still not a connectivity test)
  let socketExists = false;
  try {
    socketExists = Boolean(cmuxSocket) && statSync(cmuxSocket!).isSocket();
  } catch {}
  probes.push({
    name: "cmux-race",
    ok: win || (!!cmux && socketExists),
    na: win,
    message: win
      ? "Not applicable on Windows (cmux is macOS-only)"
      : !cmux
      ? notFound("cmux-race.ts")
      : socketExists
      ? `Installed (${cmux}); cmux socket present (not connected to)`
      : cmuxSocket
      ? `Installed (${cmux}); CMUX_SOCKET_PATH is not a socket`
      : `Installed (${cmux}); not inside cmux (no socket)`,
    latencyMs: Date.now() - t3,
  });

  // 5. adw probe
  const t4 = Date.now();
  const adw = detect(pi, extDir, "adw.ts", ["adw"], ["adw"]);
  probes.push({
    name: "adw (verification gate)",
    ok: !!adw,
    message: adw
      ? `Installed (${adw}; verification gate: Jev scope, tests, diff stat, readiness)`
      : notFound("adw.ts"),
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
  const audioOk = win || (existsSync("/usr/bin/afplay") && existsSync("/System/Library/Sounds/Glass.aiff"));
  probes.push({
    name: "Audio Telemetry",
    ok: audioOk,
    na: win,
    message: win
      ? "Not applicable on Windows (afplay is macOS-only)"
      : audioOk ? "afplay and system sounds present" : "afplay or audio assets missing",
    latencyMs: Date.now() - t6,
  });

  const counted = probes.filter((p) => !p.na);
  const totalOk = counted.filter((p) => p.ok).length;
  const lines: string[] = [
    `### 🩺 Pi Agentic Harness Doctor Report`,
    `Status: **${totalOk}/${counted.length} checks passed** (${Math.round((totalOk / counted.length) * 100)}%). These are presence checks (Pi registry or extension files, binaries, socket); only the Jev probe makes a live call. Extension behaviour is not exercised here; each repo's tests do that.\n`,
  ];

  for (const p of probes) {
    const icon = p.na ? "➖" : p.ok ? "✅" : "⚠️";
    const lat = p.latencyMs !== undefined ? ` [${p.latencyMs}ms]` : "";
    lines.push(`- ${icon} **${p.name}**: ${p.message}${lat}`);
  }

  return {
    timestamp: new Date().toISOString(),
    totalOk,
    totalProbes: counted.length,
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
    promptSnippet: "Use harness_doctor for a quick inventory: extension files, checker binaries, cmux socket, live Jev reachability.",
    parameters: Type.Object({
      playChime: Type.Optional(Type.Boolean({ description: "Play a test audio chime (default: false)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (params.playChime) {
        playAudioChime("Glass");
      }

      const effectiveCtx: ExtensionContext | undefined = ctx;
      effectiveCtx?.ui?.notify?.("[harness-doctor] Running diagnostic probes...", "info");
      const report = await runHarnessDoctor(effectiveCtx?.cwd || process.cwd(), { pi });

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
      const report = await runHarnessDoctor(ctx.cwd || process.cwd(), { pi });
      ctx.ui?.notify?.(
        `[harness-doctor] ${report.totalOk}/${report.totalProbes} checks passed (presence inventory)`,
        report.totalOk === report.totalProbes ? "info" : "warning",
      );
    },
  });
}
