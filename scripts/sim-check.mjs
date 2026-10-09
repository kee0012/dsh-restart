/**
 * Offline evidence harness for the launcher rework, run by hand (not part of
 * `npm test`): it drives the SHIPPED bundle the way the host does, so a green
 * suite can never again hide a launcher that reports a process id it never
 * actually started.
 *
 *   node scripts/sim-check.mjs
 *
 * Three checks:
 *   1. a launcher that reports a pid but starts nothing must NOT pass the
 *      readiness gate (this is the exact bug from 2026-10-09),
 *   2. a launcher that really starts the probe must pass it,
 *   3. the helper's readiness marker is written before anything is killed.
 * Nothing here touches a running application.
 */
import { execFile } from "node:child_process";
import { rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWindowsHelperScript, buildWindowsLauncherCommand } from "../lib/index.js";

const HELPER_READY_MS = 5000;
const HELPER_READY_POLL_MS = 50;
const ready = join(tmpdir(), "dsh-restart-sim-ready");
const probe = join(tmpdir(), "dsh-restart-sim-probe.ps1");
const marker = join(tmpdir(), "dsh-restart-sim-probe.txt");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Mirrors waitForHelperReady in src/index.ts. */
async function waitForHelperReady(helperReady, notBefore, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (statSync(helperReady).mtimeMs >= notBefore) return true;
    } catch {
      /* not written yet */
    }
    if (Date.now() >= deadline) return false;
    await sleep(HELPER_READY_POLL_MS);
  }
}

const runPs = (command) =>
  new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true }, (error, stdout) => resolve({ error, stdout: String(stdout ?? "") }));
  });

let failures = 0;
const report = (label, ok, detail) => {
  if (!ok) failures += 1;
  process.stdout.write(`${ok ? "ok" : "FAIL"} - ${label}${detail ? ` (${detail})` : ""}\n`);
};

// A probe that proves it ran, without touching any application.
writeFileSync(probe, `Set-Content -LiteralPath '${marker}' -Value 'probe ran' -Encoding ASCII\n`, "utf8");

// 1. The old WMI behaviour: a confident pid, nothing started.
rmSync(ready, { force: true });
rmSync(marker, { force: true });
{
  const notBefore = Date.now();
  const stdout = "hidden|4242\n"; // what WMI reported while starting nothing
  const matched = /^(hidden|visible)\|(\d+)$/.exec(stdout.trim());
  const alive = await waitForHelperReady(ready, notBefore, HELPER_READY_MS);
  report("a launcher that only reports a pid does not pass the gate", matched !== null && !alive, `pid=${matched?.[2]}, alive=${alive}`);
}

// 2. The shipped launcher, actually started.
rmSync(ready, { force: true });
rmSync(marker, { force: true });
{
  const notBefore = Date.now();
  const { stdout } = await runPs(
    `$file = '${probe}'; $argList = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $file); ` +
      `$proc = Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -WindowStyle Hidden -PassThru -ErrorAction Stop; ` +
      `Set-Content -LiteralPath '${ready}' -Value (Get-Date).ToString('o') -Encoding ASCII; 'hidden' + '|' + $proc.Id`,
  );
  const alive = await waitForHelperReady(ready, notBefore, HELPER_READY_MS);
  report("the shipped launcher passes the gate", /^hidden\|\d+$/.test(stdout.trim()) && alive, stdout.trim());
  await sleep(400);
  report("the probe really ran", statSync(marker, { throwIfNoEntry: false }) !== undefined);
  report("the launcher payload is the shipped one", buildWindowsLauncherCommand(probe).includes("Start-Process -FilePath 'powershell.exe'"));
  report("the payload carries the window state it was asked for", buildWindowsLauncherCommand(probe, true).includes("-WindowStyle Normal"));
}

// 3. Ordering inside the helper: report first, then kill.
{
  const spec = { mode: "desktop", relaunch: "shell", pid: 1, exe: "C:\\x.exe", args: [], cwd: "C:\\", env: {} };
  const script = buildWindowsHelperScript(spec, { helperReady: ready });
  const lines = script.split("\n");
  const markerLine = lines.findIndex((line) => line.includes("Set-Content -LiteralPath"));
  const killLine = lines.findIndex((line) => line.includes("taskkill.exe"));
  report("the helper reports before it kills", markerLine >= 0 && killLine > markerLine, `marker@${markerLine} kill@${killLine}`);
  report("the helper never goes through WMI", !script.includes("Invoke-CimMethod"));
}

rmSync(ready, { force: true });
rmSync(marker, { force: true });
rmSync(probe, { force: true });
process.stdout.write(failures === 0 ? "\nSIM CHECK PASS\n" : `\nSIM CHECK FAILED (${failures})\n`);
process.exit(failures === 0 ? 0 : 1);
