import assert from "node:assert";
import registerDoctor, { runHarnessDoctor, playAudioChime } from "./index.ts";

console.log("=== Testing pi-harness-doctor extension ===");

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

// 2. Audio Chime Test
const audioPlayed = playAudioChime("Glass");
assert(audioPlayed, "macOS Glass chime must be playable");
console.log("✓ Audio telemetry verified via afplay");

// 3. Harness Doctor Health Probes Test
console.log("Running runHarnessDoctor probes...");
const report = await runHarnessDoctor(cwd);

assert(report.totalProbes >= 6, "Must run at least 6 probes");
assert(report.totalOk >= 5, "Majority of probes must be OK");
assert(report.markdown.includes("Harness Doctor Report"), "Report must include markdown header");

console.log("✓ Harness Doctor diagnostic report assembled:");
console.log(report.markdown);

// 4. Tool Execution Test
const doctorTool = registeredTools.get("harness_doctor");
const toolRes = await doctorTool.execute("call-doc-1", { playChime: false }, { cwd, ui: { notify: () => {} } });
assert(toolRes.content[0].text.includes("Harness Doctor Report"), "Tool execution must output report");
console.log("✓ harness_doctor tool execution verified");

console.log("\nALL TESTS PASSED! pi-harness-doctor is fully verified.");
