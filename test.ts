import assert from "node:assert";
import { execFileSync } from "node:child_process";
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
// Real audio only when asked for: PI_TEST_AUDIO=1 bun run test.ts
if (process.env.PI_TEST_AUDIO === "1") assert(playAudioChime("Glass"), "Allowed macOS system chime 'Glass' must play");
assert.equal(playAudioChime("NotAllowlisted"), false, "Sounds outside the allowlist must not play");

const traversalBlocked = playAudioChime("../../etc/passwd");
assert.equal(traversalBlocked, false, "Path traversal in audio sound name must be strictly blocked");
console.log("✓ Audio telemetry allowlist verified (path traversal strictly prevented)");

// 3. Harness Doctor Health Probes Test
console.log("Running runHarnessDoctor probes...");
const report = await runHarnessDoctor(cwd);

assert(report.totalProbes >= 6, "Must run at least 6 probes");
// Host-independent: how many probes pass depends on what is installed here; the arithmetic must not.
assert.equal(report.totalOk, report.probes.filter((p) => p.ok && !p.na).length, "totalOk must count the ok, applicable probes");
assert(report.totalOk <= report.totalProbes);
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
  assert.equal(selfCompactThresholds({} as any), "Nudge 75%, Auto-compact 88%, Force 94% of the whole window");
  assert.equal(selfCompactThresholds({ PI_SELF_COMPACT_AUTO_PCT: "90", PI_SELF_COMPACT_FORCE_PCT: "96" } as any), "Nudge 75%, Auto-compact 90%, Force 96% of the whole window");
  assert.equal(selfCompactThresholds({ PI_SELF_COMPACT_WORKING_WINDOW: "200000" } as any), "Nudge 75%, Auto-compact 88%, Force 94% of min(window, 200K)");
  assert.equal(selfCompactThresholds({ PI_SELF_COMPACT_AUTO_PCT: "95" } as any), "Nudge 75%, Auto-compact 88%, Force 94% of the whole window", "misordered → defaults");
  assert.equal(selfCompactThresholds({ PI_SELF_COMPACT_ENABLED: "false" } as any), "Nudge 75%, Auto-compact 88%, Force 94% of the whole window [DISABLED]");
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

// Detection follows Pi's registry (package installs), and Windows marks mac-only probes n/a
{
  const { runHarnessDoctor } = await import("./index.ts");
  const assert = (await import("node:assert")).default;
  const fakePi = {
    getAllTools: () => ["self_compact", "prime", "adw", "cmux_race"].map((name) => ({ name, sourceInfo: { path: "/x/ext.ts", source: "local" } })),
    getCommands: () => [{ name: "auto-validate", source: "extension", sourceInfo: { path: "/x/ext.ts" } }],
    getSettings: () => ({}),
  };
  const rep = await runHarnessDoctor(process.cwd(), { pi: fakePi as any });
  const msg = (n: string) => rep.probes.find((p) => p.name === n)!.message;
  assert.match(msg("self-compact"), /Installed \(loaded;/);
  assert.match(msg("prime"), /Installed \(loaded;/);
  assert.match(msg("adw (verification gate)"), /Installed \(loaded;/);
  assert.match(msg("auto-validate"), /^Installed \(loaded\)|Missing components/, "auto-validate seen via its command");
  assert.doesNotMatch(msg("auto-validate"), /not found/);

  const win = await runHarnessDoctor(process.cwd(), { platform: "win32" });
  const na = win.probes.filter((p) => p.na).map((p) => p.name).sort();
  assert.deepEqual(na, ["Audio Telemetry", "cmux-race"]);
  assert.equal(win.totalProbes, win.probes.length - 2, "n/a probes are not counted");
  assert.match(win.markdown, /Not applicable on Windows/);
  console.log("✓ registry-based detection and win32 n/a probes verified");
}

// Regression helpers: isolated HOME (no legacy extension files) and a PATH of shims only.
const fs2 = await import("node:fs"), os2 = await import("node:os"), path2 = await import("node:path");
const sandbox = fs2.mkdtempSync(path2.join(os2.tmpdir(), "doc-sandbox-"));
const shim = (dir: string, name: string, body = "exit 0") => {
  fs2.writeFileSync(path2.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
};
const withEnv = async <T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> => {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
};
const probeMsg = (rep: any, n: string) => rep.probes.find((p: any) => p.name === n);

try {
  // Finding 2: prompt templates / skills / built-ins sharing an extension's name are not the extension
  {
    const collide = {
      getAllTools: () => ["self_compact", "prime", "adw", "cmux_race"].map((name) => ({ name, sourceInfo: { path: `builtin:${name}`, source: "builtin" } })),
      getCommands: () => [
        { name: "self-compact", source: "prompt" }, { name: "prime", source: "skill" },
        { name: "adw", source: "prompt" }, { name: "auto-validate", source: "skill" }, { name: "cmux-race", source: "prompt" },
      ],
      getSettings: () => ({}),
    };
    const rep = await withEnv({ HOME: sandbox, TYPESAFE_API_KEY: undefined }, () => runHarnessDoctor(process.cwd(), { pi: collide as any, home: sandbox }));
    for (const n of ["self-compact", "auto-validate", "prime", "cmux-race", "adw (verification gate)"]) {
      assert.doesNotMatch(probeMsg(rep, n).message, /Installed/, `${n}: a name collision must not report Installed`);
    }
    const real = {
      getAllTools: () => [],
      getCommands: () => [{ name: "adw", source: "extension", sourceInfo: { path: "/x/adw.ts" } }],
      getSettings: () => ({}),
    };
    const rep2 = await withEnv({ HOME: sandbox, TYPESAFE_API_KEY: undefined }, () => runHarnessDoctor(process.cwd(), { pi: real as any, home: sandbox }));
    assert.match(probeMsg(rep2, "adw (verification gate)").message, /Installed \(loaded;/, "an extension command still counts");
    console.log("✓ registry detection ignores prompt/skill/built-in name collisions");
  }

  if (process.platform !== "win32") {
    // PATH-dependent probes run in a child process: Bun resolves executables from the PATH it started with.
    const child = path2.join(sandbox, "child.ts");
    fs2.writeFileSync(child, `import { runHarnessDoctor } from ${JSON.stringify(path2.resolve("index.ts"))};
const rep = await runHarnessDoctor(process.cwd(), { platform: process.env.T_PLATFORM as any, home: process.env.T_HOME });
console.log(JSON.stringify(rep.probes.find((p) => p.name === "auto-validate")));`);
    const runChild = (dir: string, platform: string) => {
      const t = Date.now();
      const out = execFileSync(process.execPath, [child], {
        env: { ...process.env, PATH: dir, T_PLATFORM: platform, T_HOME: sandbox, TYPESAFE_API_KEY: "" }, encoding: "utf8",
      });
      return { message: JSON.parse(out.trim().split("\n").pop()!).message as string, elapsed: Date.now() - t };
    };

    // Finding 3: probe the interpreter auto-validate invokes (python on win32, python3 elsewhere)
    const only = (platform: string, exe: string) => {
      const d = fs2.mkdtempSync(path2.join(sandbox, "py-"));
      for (const n of ["bun", "bash", "git", exe]) shim(d, n);
      return runChild(d, platform).message;
    };
    assert.match(only("win32", "python3"), /Missing components:[^;]*\bpython\b/, "win32 must not certify python when only python3 works");
    assert.doesNotMatch(only("win32", "python"), /Missing components:[^;]*\bpython/, "win32 python works");
    assert.match(only("darwin", "python"), /Missing components:[^;]*\bpython3\b/, "posix must not certify python3 when only python works");
    assert.doesNotMatch(only("darwin", "python3"), /Missing components:[^;]*\bpython/, "posix python3 works");
    console.log("\u2713 python probe matches the interpreter auto-validate invokes");

    // Finding 4: a hung probe is killed, not waited on
    const hang = fs2.mkdtempSync(path2.join(sandbox, "hang-"));
    for (const n of ["bun", "bash", "git"]) shim(hang, n);
    shim(hang, "python3", "exec /bin/sleep 20");
    const { message, elapsed } = runChild(hang, "darwin");
    assert(elapsed < 8000, `a hung interpreter must be timed out (took ${elapsed}ms)`);
    assert.match(message, /Missing components:[^;]*python3/, "a timed-out probe counts as missing");
    console.log(`\u2713 subprocess probes time out (hung python3 cut off; whole run ${elapsed}ms)`);
  }
} finally {
  fs2.rmSync(sandbox, { recursive: true, force: true });
}
