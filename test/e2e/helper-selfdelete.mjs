/**
 * Runtime check for the helper's last statement: it deletes its own script.
 *
 * PowerShell parses a script file before executing it, so removing the file from
 * inside the running script should be harmless — but "should be" is not good enough
 * when the cost of being wrong is an application that stays dead. This runs a real
 * helper against a throwaway node process and verifies both halves: the restart
 * completes, and the script file (which carries an environment snapshot) is gone.
 *
 * It kills processes and writes to `%TEMP%`, so it is deliberately kept out of
 * `npm test`; run it with `npm run test:e2e`. Nothing here touches DSH itself.
 * @module test/e2e/helper-selfdelete
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWindowsHelperScript, buildWindowsLauncherCommand } from "../../lib/index.js";

if (process.platform !== "win32") {
  console.log("skip - the helper self-delete check needs Windows");
  process.exit(0);
}

const logPath = join(tmpdir(), "dsh-restart-selfdelete.log");
const helperPath = join(tmpdir(), "dsh-restart-selfdelete.ps1");
const failures = [];

/**
 * Check one condition.
 * @param label - What is being checked.
 * @param ok - Result.
 * @param detail - Context for a failure.
 */
function expect(label, ok, detail = "") {
  if (ok) {
    console.log(`ok - ${label}`);
    return;
  }
  failures.push(label);
  console.log(`FAIL - ${label}${detail ? ` (${detail})` : ""}`);
}

/** @returns The log file contents, or an empty string when it does not exist yet. */
function logText() {
  try {
    return readFileSync(logPath, "utf8");
  } catch {
    return "";
  }
}

/**
 * Whether a pid still exists.
 * @param pid - Process id to probe.
 * @returns True when the process is alive.
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A helper appends to its log, so leftovers from an earlier run would satisfy the
// wait below before this run has done anything. Start from a clean slate.
rmSync(logPath, { force: true });
rmSync(helperPath, { force: true });

// A stand-in for the DSH host: a plain node process we can kill without consequences.
const target = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
await new Promise((resolve) => setTimeout(resolve, 300));

const spec = {
  mode: "web",
  relaunch: "self",
  pid: target.pid,
  exe: process.execPath,
  args: ["-e", "setTimeout(() => {}, 4000)"],
  cwd: process.cwd(),
  env: { DSH_SELFTEST: "1" },
};
const script = buildWindowsHelperScript(spec, {
  logPath,
  delayMs: 200,
  waitSeconds: 4,
  portWaitSeconds: 1,
  verifyMs: 800,
  maxAttempts: 2,
  retryDelayMs: 100,
});
writeFileSync(helperPath, script, "utf8");
expect("the helper script was written", existsSync(helperPath));
expect("the script contains an environment snapshot", script.includes("Env:DSH_SELFTEST"));
expect(
  "the script removes itself as its last statement",
  /Remove-Item -LiteralPath \$PSCommandPath[^\n]*\n$/.test(script),
);

const payload = buildWindowsLauncherCommand(helperPath);
await new Promise((resolve, reject) => {
  execFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", payload],
    { windowsHide: true, timeout: 30000 },
    (error, stdout) => (error ? reject(error) : resolve(String(stdout).trim())),
  );
});

// Wait for the helper to report the end of the restart.
const deadline = Date.now() + 30000;
let text = "";
while (Date.now() < deadline) {
  text = logText();
  if (/restart complete|start DSH by hand/.test(text)) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}

expect(
  "the helper finished its work",
  /restart complete/.test(text),
  text.trim().split("\n").slice(-3).join(" | "),
);

// The script deletes itself after writing that last line, so give it a moment.
let scriptGone = false;
const goneDeadline = Date.now() + 5000;
while (Date.now() < goneDeadline) {
  if (!existsSync(helperPath)) {
    scriptGone = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
expect("the helper script is gone afterwards", scriptGone);
expect("the relaunched process survived", /is still running/.test(text));
expect("the helper terminated the target before relaunching", !isAlive(target.pid));

try {
  process.kill(target.pid);
} catch {
  /* the helper already terminated it */
}
// The relaunched stand-in exits on its own; make sure no stray one is left behind.
for (const line of text.split("\n")) {
  const match = /launch attempt \d+: started pid (\d+)/.exec(line);
  if (match) {
    try {
      process.kill(Number(match[1]));
    } catch {
      /* already gone */
    }
  }
}

if (failures.length > 0) {
  console.log(`\nSELF-DELETE E2E FAIL (${failures.length})`);
  process.exit(1);
}
console.log("\nSELF-DELETE E2E PASS");
