import assert from "node:assert";
import registerDoctor, { runHarnessDoctor, playAudioChime } from "./index.ts";

console.log("=== Testing pi-harness-doctor extension (Hardened) ===");

const cwd = process.cwd();

// 1. Tool and Command Registration Test
const registeredTools = new Map();
const registeredCommands = new Map();

const mockPi = {
  registerTool(tool: any) {
    registeredTools.set(tool.name, tool);
  },
  registerCommand(name: string, cmd: any) {
    registeredCommands.set(name, cmd);
  },
  on() {},
};

registerDoctor(mockPi as any);

assert(registeredTools.has("harness_doctor"), "harness_doctor tool must be registered");
assert(registeredCommands.has("harness-doctor"), "/harness-doctor command must be registered");
console.log("✓ Tool 'harness_doctor' and command '/harness-doctor' verified");

// 2. Audio Chime Allowlist & Traversal Prevention Test
const allowedPlayed = playAudioChime("Glass");
assert(allowedPlayed, "Allowed macOS system chime 'Glass' must play");

const traversalBlocked = playAudioChime("../../etc/passwd");
assert.equal(traversalBlocked, false, "Path traversal in audio sound name must be strictly blocked");
console.log("✓ Audio telemetry allowlist verified (path traversal strictly prevented)");

// 3. Harness Doctor Health Probes Test
console.log("Running runHarnessDoctor probes...");
const report = await runHarnessDoctor(cwd);

assert(report.totalProbes >= 6, "Must run at least 6 probes");
assert(report.totalOk >= 5, "Majority of probes must be OK");
assert(report.markdown.includes("Harness Doctor Report"), "Report must include markdown header");

console.log("✓ Harness Doctor diagnostic report assembled:");
console.log(report.markdown);

// 4. Five-argument tool execution test
const doctorTool = registeredTools.get("harness_doctor");
const mockCtx: any = { cwd, ui: { notify: () => {} } };
const controller = new AbortController();

const toolRes = await doctorTool.execute("call-doc-1", { playChime: false }, controller.signal, () => {}, mockCtx);
assert(toolRes.content[0].text.includes("Harness Doctor Report"), "Tool execution must output report");
console.log("✓ Pi 5-argument tool.execute contract verified");

console.log("\nALL TESTS PASSED! pi-harness-doctor is fully hardened.");

// self-compact threshold reporting mirrors self-compact's resolveConfig
{
  const { selfCompactThresholds } = await import("./index.ts");
  const assert = (await import("node:assert")).default;
  assert.equal(selfCompactThresholds({} as any), "Nudge 70%, Auto-compact 80%, Force 88%");
  assert.equal(selfCompactThresholds({ PI_SELF_COMPACT_AUTO_PCT: "85", PI_SELF_COMPACT_FORCE_PCT: "92" } as any), "Nudge 70%, Auto-compact 85%, Force 92%");
  assert.equal(selfCompactThresholds({ PI_SELF_COMPACT_AUTO_PCT: "95" } as any), "Nudge 70%, Auto-compact 80%, Force 88%", "misordered → defaults");
  console.log("✓ self-compact thresholds reported from env, matching resolveConfig");
}

// cmux probe: an ordinary file at CMUX_SOCKET_PATH is not a socket
{
  const { runHarnessDoctor } = await import("./index.ts");
  const assert = (await import("node:assert")).default;
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "doc-")), "not-a-socket");
  fs.writeFileSync(fake, "text");
  const saved = process.env.CMUX_SOCKET_PATH;
  process.env.CMUX_SOCKET_PATH = fake;
  const rep = await runHarnessDoctor(process.cwd());
  process.env.CMUX_SOCKET_PATH = saved;
  const probe = (rep as any).probes.find((p: any) => p.name === "cmux-race");
  assert.equal(probe.ok, false, "regular file must not pass as the cmux socket");
  assert.match(probe.message, /not a socket/);
  console.log("✓ cmux probe requires an actual socket");
}
