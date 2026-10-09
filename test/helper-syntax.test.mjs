/**
 * Syntax-check the generated helper scripts with the very shells that run them:
 * the real PowerShell parser for the Windows helper (and for the launcher
 * payload), `sh -n` for the POSIX helper. A shell that is not installed skips
 * its own check, so the suite still runs on the other platform.
 *
 * Run with `node test/helper-syntax.test.mjs`.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildPosixHelperScript,
  buildWindowsHelperScript,
  buildWindowsLauncherCommand,
  restartSpec,
} from "../lib/index.js";

const dir = mkdtempSync(join(tmpdir(), "dsh-restart-syntax-"));
let checks = 0;

/**
 * Run one named assertion.
 * @param label - Test name.
 * @param fn - Body.
 */
function test(label, fn) {
  fn();
  checks += 1;
  process.stdout.write(`ok ${checks} - ${label}\n`);
}

/**
 * Report a check that this machine cannot run.
 * @param label - Test name.
 * @param why - Reason.
 */
function skip(label, why) {
  process.stdout.write(`skip - ${label} (${why})\n`);
}

/**
 * Parse a PowerShell file with the real parser.
 * @param file - File to parse.
 * @returns `PARSE-OK`, or one line per parse error.
 */
function parsePowerShell(file) {
  const checker = join(dir, "parse.ps1");
  writeFileSync(
    checker,
    [
      "$errors = $null",
      "$text = Get-Content -Raw -LiteralPath $env:DSH_PARSE_TARGET",
      "[System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$null, [ref]$errors) | Out-Null",
      "if ($errors.Count -gt 0) {",
      "  foreach ($item in $errors) { Write-Output ($item.Extent.StartLineNumber.ToString() + ': ' + $item.Message) }",
      "  exit 1",
      "}",
      "Write-Output 'PARSE-OK'",
    ].join("\r\n"),
    "utf8",
  );
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", checker],
    {
      encoding: "utf8",
      env: Object.assign({}, process.env, { DSH_PARSE_TARGET: file }),
      windowsHide: true,
    },
  ).trim();
}

/**
 * Write a script and assert the parser accepts it.
 * @param name - File name inside the temporary directory.
 * @param script - Script text.
 * @param label - Test name.
 */
function checkPowerShell(name, script, label) {
  const file = join(dir, name);
  writeFileSync(file, `\uFEFF${script}`, "utf8");
  const output = parsePowerShell(file);
  assert.ok(output.includes("PARSE-OK"), `PowerShell rejected ${name}:\n${output}`);
}

const desktopSpec = restartSpec("desktop", {
  ppid: 4242,
  execPath: "C:\\Program Files\\deepseek harness\\DeepSeek Harness.exe",
  cwd: "D:\\work space",
  env: { DSH_PROFILE: "desktop", DSH_QUOTED: "it's", DSH_EMPTY: "" },
});

const webSpec = restartSpec("web", {
  pid: 99,
  execPath: "C:\\Program Files\\nodejs\\node.exe",
  execArgv: ["--expose-internals"],
  argv: ["node", "D:\\dsh\\bin.js", "web", "--port", "19387"],
  cwd: "D:\\work space",
  env: { PATH: "C:\\bin" },
});

if (process.platform === "win32") {
  test("the desktop helper is valid PowerShell", () => {
    checkPowerShell(
      "dsh-restart-helper.ps1",
      buildWindowsHelperScript(desktopSpec, { port: 19387 }),
      "desktop helper",
    );
  });

  test("the web helper is valid PowerShell", () => {
    checkPowerShell("dsh-restart-web-helper.ps1", buildWindowsHelperScript(webSpec), "web helper");
  });

  test("the launcher payload is valid PowerShell", () => {
    checkPowerShell(
      "launcher.ps1",
      buildWindowsLauncherCommand("C:\\Temp\\dsh-restart-helper.ps1"),
      "launcher",
    );
    checkPowerShell(
      "launcher-visible.ps1",
      buildWindowsLauncherCommand("C:\\Temp\\dsh-restart-helper.ps1", true),
      "visible launcher",
    );
  });
} else {
  skip("the Windows helper is valid PowerShell", "not running on Windows");
}

const posixSpec = restartSpec("web", {
  pid: 4711,
  execPath: "/usr/bin/node",
  execArgv: [],
  argv: ["node", "/opt/dsh/bin.js", "web"],
  cwd: "/srv/dsh work",
  env: {},
});

const posixAvailable = spawnSync("sh", ["-c", "true"], { stdio: "ignore" }).error === undefined;

if (posixAvailable) {
  test("the POSIX helper is valid sh", () => {
    const file = join(dir, "dsh-restart-helper.sh");
    writeFileSync(file, buildPosixHelperScript(posixSpec), "utf8");
    const result = spawnSync("sh", ["-n", file], { encoding: "utf8" });
    assert.equal(result.status, 0, `sh -n rejected the helper:\n${result.stderr}`);
  });
} else {
  skip("the POSIX helper is valid sh", "sh was not found");
}

process.stdout.write(`\n${checks} helper syntax tests passed\n`);
