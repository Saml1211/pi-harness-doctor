# pi-harness-doctor

Unified diagnostic doctor and audio telemetry suite for the **Pi Coding Agent**, verifying all 5 custom Agentic Engineering extensions:
1. `self-compact` (context lifecycle & 3-tier thresholds)
2. `auto-validate` (sub-20ms deterministic syntax catchers)
3. `prime` (dynamic context bundle assembler)
4. `cmux-race` (parallel competitive runners in cmux)
5. `adw` (verification gate)
Plus **TypeSafe Jev System One** connectivity and **macOS Audio Telemetry** (`afplay`).

## Usage

- Command: `/harness-doctor`
- Tool: `harness_doctor(playChime?: boolean)`

## Verification

```bash
bun run test.ts   # with Pi packages on NODE_PATH; node --input-type=module fails on Node 24
```

## What the checks mean

They are a quick inventory, not proof that anything works. The extension probes ask Pi's own registry (`getAllTools`/`getCommands`) whether each extension is loaded, so `pi install` packages count, and fall back to the legacy `~/.pi/agent/extensions/<name>.ts` file. Messages say `loaded` or `file present`. On Windows the python and shell checks run without a shell (Git Bash via Pi's `getShellConfig`, `python` accepted for `python3`), and the cmux and audio probes are reported as not applicable and left out of the pass count. The auto-validate probe checks that its checker binaries are present, and the cmux probe checks that the socket file exists without connecting to it. Only the Jev probe makes a live call. Each extension's own `test.ts` and `e2e.ts` exercise its behaviour.
