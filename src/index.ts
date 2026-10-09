/**
 * dsh-restart — Node half.
 *
 * Why a helper process is needed at all:
 * the Win32 desktop app runs its DSH server (`dsh-desktop-host`) as a child of
 * the Electron shell. Killing only that child makes the shell show its crash
 * recovery dialog, and the shell cannot be asked to relaunch itself from the
 * renderer (no Electron IPC channel exists for that). So a restart means:
 * terminate the Electron shell process tree, then start the shell again.
 *
 * A helper spawned from this process would die with it, so the helper is created
 * through WMI (`Win32_Process.Create`). Its parent is then WmiPrvSE.exe, which
 * puts it outside the DSH process tree and job object. The helper waits for the
 * HTTP response to flush, terminates the target, waits for it to disappear and
 * starts the application again.
 *
 * The application must not inherit this host's Node-mode environment flags, or it
 * comes back as a bare Node process: see {@link NODE_MODE_VARS}.
 *
 * `dsh web` keeps the simpler shape: the server *is* the process to replace, so
 * the helper terminates it and spawns the same command line again.
 *
 * @module dsh-restart
 */

import { execFile, spawn } from "node:child_process";
import { appendFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";

/** Plugin id — must equal the package name, the patch id and the client id. */
export const name = "dsh-restart";

/** Strict injection: the routes below are the only service this half touches. */
export const inject = ["webServer"];

const PLUGIN_ID = "dsh-restart";
/** Exact route answering a liveness/restart-completion probe. */
const ROUTE_PING = `/${PLUGIN_ID}/ping`;
/** Exact route performing the restart. */
const ROUTE_RESTART = `/${PLUGIN_ID}/restart`;
/** Diagnostics for the helper (the helper appends its own lines to the same file). */
const LOG_PATH = join(tmpdir(), `${PLUGIN_ID}.log`);
/** Identifies this host process across a restart; the client polls for a change. */
const BOOT = `${process.pid}-${Date.now()}`;
/** Time for the 200 response to reach the browser before the process is killed. */
const RESTART_DELAY_MS = 2000;
/** How long the helper waits for the terminated process to actually disappear. */
const KILL_WAIT_SECONDS = 20;
/** How long the helper waits for the old server to release the web port. */
const PORT_WAIT_SECONDS = 6;
/** Port assumed when the request carries no usable Host header. */
const DEFAULT_WEB_PORT = 19387;
/**
 * How long a freshly started process must stay alive to count as started.
 *
 * A launch can die in under a second for two known reasons, and both are silent:
 * the environment still carried Electron's Node-mode flag (see
 * {@link NODE_MODE_VARS}), or the desktop shell lost its single-instance
 * handshake (`claimDesktopSingleInstance` calls `application.quit()`, exit 0, no
 * window, no log). Survival therefore has to be observed, not assumed.
 */
const VERIFY_MS = 9000;
/** Launch attempts before giving up. */
const MAX_LAUNCH_ATTEMPTS = 5;
/** Pause between launch attempts. */
const RETRY_DELAY_MS = 2500;
/**
 * Variables the desktop shell adds for its Node-mode child process.
 *
 * The shell spawns `dsh-desktop-host` with `ELECTRON_RUN_AS_NODE: "1"`
 * (`app.asar/lib/main.js:3529`). This plugin runs inside that child, so the flag
 * sits in `process.env`; replaying the environment into the helper would make the
 * relaunched `DeepSeek Harness.exe` start as plain Node instead of the
 * application — it finds no script, reads a dead stdin and exits 0 after ~400 ms,
 * which looks exactly like a restart that did nothing.
 */
const NODE_MODE_VARS = ["ELECTRON_RUN_AS_NODE", "DSH_DESKTOP_NODE_EXECUTABLE"];
/**
 * How long the host waits for the helper to prove it is running.
 *
 * The helper rewrites its readiness marker as its very first statement, so this
 * only has to cover the launch of Windows PowerShell itself. When the wait runs
 * out the host does *not* kill the application: losing the restart is annoying,
 * losing the application with nothing left to bring it back is worse.
 */
const HELPER_READY_MS = 5000;
/** Poll interval while waiting for the helper's readiness marker. */
const HELPER_READY_POLL_MS = 50;
/** The desktop window's own origin; the shell protocol proxy strips Origin, but browsers may not. */
const DESKTOP_ORIGIN = "dsh-app://app";

/**
 * Append one line to the diagnostics log. Logging must never be the reason a
 * restart fails, so every failure is swallowed.
 * @param message - Line to append.
 */
function log(message) {
  try {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${message}\n`, "utf8");
  } catch {
    /* ignore */
  }
}

/**
 * Which process must be replaced, and with what.
 * @param argv - Process arguments (injectable for tests).
 * @returns `desktop` when this host runs inside the desktop shell.
 */
export function detectMode(argv = process.argv) {
  const desktop = argv
    .slice(1)
    .some((value) => typeof value === "string" && value.includes("dsh-desktop-host"));
  return desktop ? "desktop" : "web";
}

/**
 * The environment a relaunched application should inherit: everything this host
 * has, minus the Node-mode additions the shell makes for its own child process,
 * which describe *this* process rather than the application.
 * @param env - Source environment.
 * @returns A copy without the Node-mode variables.
 */
export function relaunchEnv(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (typeof value !== "string") continue;
    if (NODE_MODE_VARS.includes(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Decide whether a request may restart the application.
 *
 * The desktop shell proxies `dsh-app://app` requests to this server and deletes
 * the Origin header, so a missing Origin is the normal desktop case. Browsers on
 * `dsh web` send their own origin, which must match this server's host.
 * @param headers - Request headers.
 * @returns True when the request may proceed.
 */
export function requestOriginAllowed(headers) {
  const origin = headers?.origin;
  if (origin === undefined || origin === null || origin === "") return true;
  if (origin === DESKTOP_ORIGIN) return true;
  try {
    return new URL(String(origin)).host === headers?.host;
  } catch {
    return false;
  }
}

/**
 * The port this server was reached on, so the helper can wait for the old
 * server to release it before starting the replacement.
 * @param headers - Request headers.
 * @returns Port number.
 */
export function requestPort(headers) {
  const host = headers?.host;
  if (typeof host === "string") {
    const match = /:(\d{1,5})$/.exec(host.trim());
    if (match) {
      const port = Number.parseInt(match[1], 10);
      if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
    }
  }
  return DEFAULT_WEB_PORT;
}

/**
 * Quote one value for a single-quoted PowerShell string literal.
 * @param value - Raw value.
 * @returns Quoted literal.
 */
export function quotePs(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Quote one argument the way the Windows command line parser expects it.
 * @param value - Raw argument.
 * @returns Quoted argument, left bare when it needs no quoting.
 */
export function quoteArgWin(value) {
  const text = String(value);
  if (text !== "" && !/[\s"]/.test(text)) return text;
  let out = '"';
  let backslashes = 0;
  for (const char of text) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      out += `${"\\".repeat(backslashes * 2 + 1)}"`;
      backslashes = 0;
      continue;
    }
    out += "\\".repeat(backslashes) + char;
    backslashes = 0;
  }
  return `${out}${"\\".repeat(backslashes * 2)}"`;
}

/**
 * Environment assignments for the helper, so the relaunched application keeps the
 * environment this host was started with (the helper itself inherits the WMI
 * provider's environment, not ours). The Node-mode flags are left out: they belong
 * to this process, and the application would start as a bare Node REPL under them.
 *
 * These assignments carry values, so the generated script is a snapshot of the host
 * environment: it is written to a per-user `%TEMP%` file and the helper removes that
 * file as soon as the restart is over. Nothing the application actually needs can be
 * left behind here — dropping variables would silently change how it starts.
 * @param env - Environment to reproduce.
 * @returns PowerShell assignment lines.
 */
function envLines(env) {
  const lines = [];
  for (const [key, value] of Object.entries(env ?? {})) {
    if (typeof value !== "string") continue;
    if (NODE_MODE_VARS.includes(key)) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    lines.push(`Set-Item -LiteralPath ${quotePs(`Env:${key}`)} -Value ${quotePs(value)}`);
  }
  return lines;
}

/**
 * Describe the restart: which pid to terminate and which command line to start.
 * @param mode - `desktop` or `web`.
 * @param options - Overrides, for tests.
 * @returns The restart specification.
 */
export function restartSpec(mode, options = {}) {
  const execPath = options.execPath ?? process.execPath;
  const cwd = options.cwd ?? process.cwd();
  const env = relaunchEnv(options.env ?? process.env);
  if (mode === "desktop") {
    return {
      mode,
      relaunch: "shell",
      pid: options.ppid ?? process.ppid,
      exe: execPath,
      args: [],
      cwd,
      env,
    };
  }
  const argv = options.argv ?? process.argv;
  const execArgv = options.execArgv ?? process.execArgv;
  return {
    mode,
    relaunch: "self",
    pid: options.pid ?? process.pid,
    exe: execPath,
    args: [...execArgv, ...argv.slice(1)],
    cwd,
    env,
  };
}

/**
 * Build the PowerShell helper that performs the restart.
 * @param spec - Restart specification from {@link restartSpec}.
 * @param options - Log path, delay and wait overrides.
 * @returns Script text.
 */
export function buildWindowsHelperScript(spec, options = {}) {
  const logPath = options.logPath ?? LOG_PATH;
  const delayMs = options.delayMs ?? RESTART_DELAY_MS;
  const waitSeconds = options.waitSeconds ?? KILL_WAIT_SECONDS;
  const portWaitSeconds = options.portWaitSeconds ?? PORT_WAIT_SECONDS;
  const port = options.port ?? DEFAULT_WEB_PORT;
  const verifyMs = options.verifyMs ?? VERIFY_MS;
  const maxAttempts = options.maxAttempts ?? MAX_LAUNCH_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  const lines = [];

  lines.push("$ErrorActionPreference = 'Continue'");
  lines.push("$ProgressPreference = 'SilentlyContinue'");
  lines.push(`$log = ${quotePs(logPath)}`);
  lines.push(
    "function Write-Log([string] $message) { try { Add-Content -LiteralPath $log -Value ('[' + (Get-Date).ToString('o') + '] ' + $message) } catch { } }",
  );
  lines.push(`Write-Log ${quotePs(`helper started (${spec.mode}, target pid ${spec.pid})`)}`);
  // Proof of life for the host: the marker is rewritten before anything is killed,
  // so a helper that never got this far makes the host stand down instead of
  // leaving the user with a closed application and nothing bringing it back.
  if (options.helperReady) {
    lines.push(
      `try { Set-Content -LiteralPath ${quotePs(options.helperReady)} -Value (Get-Date).ToString('o') -Encoding ASCII } catch { }`,
    );
  }
  lines.push(...envLines(spec.env));
  // The helper may never have inherited these, but the application must not see
  // them under any circumstances.
  for (const key of NODE_MODE_VARS) {
    lines.push(`Remove-Item -LiteralPath ${quotePs(`Env:${key}`)} -ErrorAction SilentlyContinue`);
  }
  lines.push(`if (Test-Path -LiteralPath ${quotePs(spec.cwd)}) { Set-Location -LiteralPath ${quotePs(spec.cwd)} }`);
  lines.push(`Start-Sleep -Milliseconds ${delayMs}`);
  lines.push(
    `$target = Get-CimInstance Win32_Process -Filter "ProcessId = ${spec.pid}" -ErrorAction SilentlyContinue`,
  );

  if (spec.relaunch === "shell") {
    // Refuse to terminate something that is not the shell we were launched by.
    lines.push(
      `if ($null -ne $target -and $target.ExecutablePath -and ($target.ExecutablePath -ine ${quotePs(spec.exe)})) {`,
    );
    lines.push(`  Write-Log ('refusing to terminate pid ${spec.pid}: ' + $target.ExecutablePath)`);
    lines.push("  exit 1");
    lines.push("}");
    // A process id is reused: if the old shell is gone and this id now belongs to
    // some unrelated program, terminating its tree would hit an innocent app.
    lines.push("if ($null -ne $target -and $target.CreationDate -ne $null) {");
    lines.push("  $age = ((Get-Date) - $target.CreationDate).TotalSeconds");
    lines.push("  if ($age -lt 60) {");
    lines.push(
      `    Write-Log ('refusing to terminate pid ${spec.pid}: it is only ' + [int]$age + 's old, so this is a reused process id');`,
    );
    lines.push("    exit 1");
    lines.push("  }");
    lines.push("}");
    lines.push("Write-Log 'terminating the desktop shell process tree'");
  } else {
    lines.push("Write-Log 'terminating this host process'");
  }
  lines.push(`& taskkill.exe /PID ${spec.pid} /T /F 2>&1 | ForEach-Object { Write-Log ('taskkill: ' + $_) }`);

  lines.push(`$deadline = (Get-Date).AddSeconds(${waitSeconds})`);
  lines.push(
    `while ($null -ne (Get-Process -Id ${spec.pid} -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }`,
  );
  lines.push("Start-Sleep -Milliseconds 700");
  // The replacement cannot boot while the old server still owns the port.
  lines.push("Write-Log 'waiting for the old server to release the port'");
  lines.push("$portFree = $false");
  lines.push(`$portDeadline = (Get-Date).AddSeconds(${portWaitSeconds})`);
  lines.push("while ((Get-Date) -lt $portDeadline) {");
  lines.push("  $listening = $false");
  lines.push(
    `  try { $listening = [bool] (Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop) } catch { $listening = $false }`,
  );
  lines.push("  if (-not $listening) { $portFree = $true; break }");
  lines.push("  Start-Sleep -Milliseconds 250");
  lines.push("}");
  lines.push(`if (-not $portFree) { Write-Log 'port ${port} is still listening; starting anyway' }`);

  const argString = spec.args.map(quoteArgWin).join(" ");
  lines.push(`$exe = ${quotePs(spec.exe)}`);
  lines.push("$rest = ''");
  if (spec.relaunch === "shell") {
    // Reuse the shell's own command line, so a shortcut's arguments survive.
    lines.push("if ($null -ne $target -and $target.CommandLine) {");
    lines.push("  $cmd = [string] $target.CommandLine");
    lines.push("  if ($cmd.StartsWith('\"')) {");
    lines.push("    $end = $cmd.IndexOf('\"', 1)");
    lines.push("    if ($end -gt 0) { $rest = $cmd.Substring($end + 1).Trim() }");
    lines.push("  } else {");
    lines.push("    $space = $cmd.IndexOf(' ')");
    lines.push("    if ($space -gt 0) { $rest = $cmd.Substring($space + 1).Trim() }");
    lines.push("  }");
    lines.push("}");
    lines.push("$wd = $null");
  } else {
    lines.push(`$rest = ${quotePs(argString)}`);
    lines.push(`$wd = ${quotePs(spec.cwd)}`);
    lines.push("if (-not (Test-Path -LiteralPath $wd)) { $wd = $null }");
  }
  lines.push("Write-Log ('relaunching ' + $exe + ' ' + $rest)");
  if (spec.relaunch === "shell") {
    // Whether the application is already running again has to be answered by the
    // *app window*, not by the executable name.
    //
    // The desktop shell runs its server as `DeepSeek Harness.exe` in
    // ELECTRON_RUN_AS_NODE mode, so one executable carries three kinds of process:
    // the shell (has an app window), its host/renderer/GPU children, and — the trap
    // — a *reparented standalone* host that the packaged CLI leaves behind when it
    // spawns the server, which outlives the CLI and the shell it was started for.
    // Both the CLI wrapper and that orphan can exist concurrently, and neither ever
    // shows a window.
    //
    // A process-tree-root test cannot tell them apart: reparenting to a dead parent
    // makes the orphan a root too, and a root test would then adopt it as "an
    // instance is already running" and skip the relaunch — the app appears to be
    // killed and never comes back. Classifying by process instead left the shell
    // unrecognisable as well. So the test is the window: a real top-level,
    // visible, unowned, `Chrome_WidgetWin_1` window belonging to one of these
    // processes. Only the shell has one, and this deliberately never matches
    // `dsh web`, whose executable is plain node with no such window.
    lines.push("function Get-DshShells {");
    lines.push("  $byPid = @{}");
    lines.push(
      "  foreach ($p in @(Get-CimInstance Win32_Process -Filter \"Name = 'DeepSeek Harness.exe'\" -ErrorAction SilentlyContinue)) { $byPid[[uint32] $p.ProcessId] = $p }",
    );
    lines.push("  if ($byPid.Count -eq 0) { return @() }");
    lines.push("  try {");
    lines.push("    if (-not ('DshRestartWin32' -as [type])) {");
    lines.push("      Add-Type -TypeDefinition @'");
    lines.push("using System;");
    lines.push("using System.Text;");
    lines.push("using System.Runtime.InteropServices;");
    lines.push("public class DshRestartWin32 {");
    lines.push("  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);");
    lines.push("  [DllImport(\"user32.dll\")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);");
    lines.push("  [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);");
    lines.push("  [DllImport(\"user32.dll\", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder name, int max);");
    lines.push("  [DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr hWnd);");
    lines.push("  [DllImport(\"user32.dll\")] public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);");
    lines.push("}");
    lines.push("'@");
    lines.push("    }");
    lines.push("  } catch {");
    lines.push("    Write-Log ('the app could not be recognised by its window: ' + $_.Exception.Message)");
    lines.push("    Write-Log 'refusing to guess whether an instance is running; the app may need a manual start'");
    lines.push("    return @()");
    lines.push("  }");
    lines.push("  $found = New-Object System.Collections.Generic.List[int]");
    lines.push("  $probe = [DshRestartWin32+EnumProc] {");
    lines.push("    param($hWnd, $lParam)");
    lines.push("    $owner = [uint32] 0");
    lines.push("    [void] [DshRestartWin32]::GetWindowThreadProcessId($hWnd, [ref] $owner)");
    lines.push("    if (-not $byPid.ContainsKey($owner)) { return $true }");
    lines.push("    if (-not [DshRestartWin32]::IsWindowVisible($hWnd)) { return $true }");
    lines.push("    if ([DshRestartWin32]::GetWindow($hWnd, 4) -ne [IntPtr]::Zero) { return $true }");
    lines.push("    $name = New-Object System.Text.StringBuilder 256");
    lines.push("    [void] [DshRestartWin32]::GetClassName($hWnd, $name, 256)");
    lines.push("    if ($name.ToString() -ne 'Chrome_WidgetWin_1') { return $true }");
    lines.push("    if (-not $found.Contains([int] $owner)) { $found.Add([int] $owner) }");
    lines.push("    return $true");
    lines.push("  }");
    lines.push("  [void] [DshRestartWin32]::EnumWindows($probe, [IntPtr]::Zero)");
    lines.push("  return @($found)");
    lines.push("}");
  }
  // A launch that loses the desktop single-instance lock quits within a second,
  // and Chromium's singleton cleanup takes a few seconds after a hard kill, so
  // every attempt is watched and repeated until one of them survives.
  lines.push("$started = 0");
  lines.push(`for ($attempt = 1; $attempt -le ${maxAttempts}; $attempt++) {`);
  if (spec.relaunch === "shell") {
    lines.push("  $existing = @(Get-DshShells)");
    lines.push("  if ($existing.Count -gt 0) {");
    lines.push("    $started = $existing[0]");
    lines.push("    Write-Log ('an instance is already running (pid ' + $started + '); not launching another')");
    lines.push("    break");
    lines.push("  }");
  }
  lines.push("  $proc = $null");
  lines.push("  try {");
  lines.push("    if ($rest -ne '') {");
  lines.push(
    "      $proc = if ($null -ne $wd) { Start-Process -FilePath $exe -ArgumentList $rest -WorkingDirectory $wd -PassThru } else { Start-Process -FilePath $exe -ArgumentList $rest -PassThru }",
  );
  lines.push("    } else {");
  lines.push(
    "      $proc = if ($null -ne $wd) { Start-Process -FilePath $exe -WorkingDirectory $wd -PassThru } else { Start-Process -FilePath $exe -PassThru }",
  );
  lines.push("    }");
  lines.push("    Write-Log ('launch attempt ' + $attempt + ': started pid ' + $proc.Id)");
  lines.push("  } catch {");
  lines.push("    Write-Log ('launch attempt ' + $attempt + ' could not start: ' + $_.Exception.Message)");
  lines.push("  }");
  lines.push("  if ($null -ne $proc) {");
  lines.push("    $launchedAt = Get-Date");
  lines.push(`    $verifyUntil = $launchedAt.AddMilliseconds(${verifyMs})`);
  lines.push("    while ((Get-Date) -lt $verifyUntil) {");
  lines.push("      Start-Sleep -Milliseconds 400");
  lines.push("      if ($proc.HasExited) { break }");
  lines.push("    }");
  lines.push("    if ($proc.HasExited) {");
  lines.push(
    "      Write-Log ('launch attempt ' + $attempt + ': pid ' + $proc.Id + ' exited after ' + [int] ((Get-Date) - $launchedAt).TotalMilliseconds + ' ms, exit code ' + $proc.ExitCode)",
  );
  lines.push("    } else {");
  lines.push("      $started = $proc.Id");
  lines.push("      Write-Log ('launch attempt ' + $attempt + ': pid ' + $proc.Id + ' is still running')");
  lines.push("      break");
  lines.push("    }");
  lines.push("  }");
  lines.push(`  Start-Sleep -Milliseconds ${retryDelayMs}`);
  lines.push("}");
  lines.push(
    "if ($started -gt 0) { Write-Log ('restart complete (instance pid ' + $started + ')') } else { Write-Log 'every launch attempt ended early; start DSH by hand' }",
  );
  // This script contains a snapshot of the host environment, values included, so it
  // must not linger in %TEMP% after the restart. PowerShell parses the whole file
  // before executing it, which makes removing it in the final statement safe.
  lines.push("Remove-Item -LiteralPath $PSCommandPath -ErrorAction SilentlyContinue");

  return `${lines.join("\r\n")}\r\n`;
}

/**
 * Build the POSIX helper. It is a plain `/bin/sh` script started detached, so it
 * survives the process it terminates.
 * @param spec - Restart specification from {@link restartSpec}.
 * @param options - Log path, delay and wait overrides.
 * @returns Script text.
 */
export function buildPosixHelperScript(spec, options = {}) {
  const logPath = options.logPath ?? LOG_PATH;
  const delaySeconds = options.delaySeconds ?? Math.ceil(RESTART_DELAY_MS / 1000);
  const waitTicks = options.waitTicks ?? KILL_WAIT_SECONDS * 5;
  const maxAttempts = options.maxAttempts ?? MAX_LAUNCH_ATTEMPTS;
  const verifySeconds = options.verifySeconds ?? 6;
  const retrySeconds = options.retrySeconds ?? 3;
  const q = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
  const lines = ["#!/bin/sh"];
  // Same reason as the Windows helper: never hand the Node-mode flags to the app.
  lines.push(`unset ${NODE_MODE_VARS.join(" ")}`);

  lines.push(`exec >> ${q(logPath)} 2>&1`);
  lines.push(
    `echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] helper started (${spec.mode}, target pid ${spec.pid})"`,
  );
  lines.push(`sleep ${delaySeconds}`);
  lines.push(`kill -TERM ${spec.pid} 2>/dev/null`);
  lines.push(`i=0`);
  lines.push(
    `while [ $i -lt ${waitTicks} ] && kill -0 ${spec.pid} 2>/dev/null; do sleep 0.2; i=$((i+1)); done`,
  );
  lines.push(`kill -KILL ${spec.pid} 2>/dev/null`);
  lines.push("sleep 1");

  // The launch is retried: a replacement can exit at once (single-instance
  // handshake, a port still held), which is only visible by watching it.
  if (spec.relaunch === "shell") {
    // macOS desktop: the executable lives inside the bundle, which `open` starts.
    const bundle = spec.exe.replace(/\/Contents\/MacOS\/.*$/, "");
    const target = bundle.endsWith(".app") ? bundle : spec.exe;
    lines.push(`echo "relaunching ${target}"`);
    if (bundle.endsWith(".app")) {
      lines.push(`launch() { open -n ${q(target)}; }`);
    } else {
      lines.push(
        `launch() { cd ${q(spec.cwd)} 2>/dev/null || true; nohup ${q(spec.exe)} ${spec.args.map(q).join(" ")} >/dev/null 2>&1 & }`,
      );
    }
    lines.push(`survived() { pgrep -f ${q(target)} >/dev/null 2>&1; }`);
  } else {
    lines.push(`echo "relaunching ${spec.exe}"`);
    lines.push(
      `launch() { cd ${q(spec.cwd)} 2>/dev/null || true; nohup ${q(spec.exe)} ${spec.args.map(q).join(" ")} >/dev/null 2>&1 & }`,
    );
    lines.push(`survived() { pgrep -f ${q(spec.exe)} >/dev/null 2>&1; }`);
  }

  lines.push("started=0");
  lines.push("attempt=1");
  lines.push(`while [ $attempt -le ${maxAttempts} ]; do`);
  lines.push("  launch");
  lines.push(`  echo "launch attempt $attempt"`);
  lines.push(`  sleep ${verifySeconds}`);
  lines.push(`  if survived; then started=1; echo "attempt $attempt is running"; break; fi`);
  lines.push(`  echo "attempt $attempt exited; retrying"`);
  lines.push(`  sleep ${retrySeconds}`);
  lines.push("  attempt=$((attempt+1))");
  lines.push("done");
  lines.push(
    `if [ $started -eq 1 ]; then echo "restart complete"; else echo "every launch attempt ended early; start DSH by hand"; fi`,
  );

  return `${lines.join("\n")}\n`;
}

/**
 * Promisified `execFile` that reports stdout and stderr on failure too.
 * @param file - Executable.
 * @param args - Arguments.
 * @param options - `execFile` options.
 * @returns Captured output.
 */
function execFileCapture(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
        return;
      }
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

/**
 * Marker the helper writes as its very first statement.
 *
 * The helper is started through WMI, and that provider lies: it regularly hands
 * back a fresh process id for a process that never runs, or is gone again before
 * its first statement. Reporting "restarting" and then killing the application
 * on the strength of that number strands the user on the splash screen, so the
 * number alone is never treated as proof that the helper is alive.
 * @returns Absolute path of the liveness marker.
 */
function helperReadyPath() {
  return join(tmpdir(), `${PLUGIN_ID}-helper-ready`);
}

/**
 * Write the helper next to the diagnostics log. A BOM keeps Windows PowerShell
 * from mis-reading non-ASCII characters in the embedded environment.
 * @param fileName - Helper file name.
 * @param script - Script text.
 * @returns Absolute helper path.
 */
function writeHelper(fileName, script) {
  const helperPath = join(tmpdir(), fileName);
  writeFileSync(helperPath, `\uFEFF${script}`, "utf8");
  return helperPath;
}

/**
 * Quote a single shell word for PowerShell.
 * @param value - Raw value.
 * @returns The value wrapped in single quotes.
 */
function quotePsSingle(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Build the PowerShell that starts the helper and reports its process id.
 *
 * `Start-Process` goes through the .NET process APIs, the path that was measured
 * to actually work here: the child honours the requested window state and runs
 * its script. WMI `Win32_Process.Create` is deliberately *not* used, even though
 * its `WmiPrvSE.exe` parent would also leave this process tree — in practice it
 * hands back a process id for a process whose script never executes at all, and
 * everything downstream of that id (the window saying DSH is restarting, killing
 * the application) then strands the user on the splash screen with nothing left
 * to bring the app back. The process id is only ever a hint anyway; the launch
 * counts as real once the helper writes its own liveness marker.
 * @param helperPath - Helper script path.
 * @param wantsVisible - Allow a visible console (the retry after a hidden try).
 * @returns A `-Command` payload that prints `<hidden|visible>|<pid>`.
 */
export function buildWindowsLauncherCommand(helperPath, wantsVisible = false) {
  const windowStyle = wantsVisible ? "Normal" : "Hidden";
  return [
    `$file = ${quotePsSingle(helperPath)}`,
    "$argList = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $file)",
    `$proc = Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -WindowStyle ${windowStyle} -PassThru -ErrorAction Stop`,
    `'${wantsVisible ? "visible" : "hidden"}' + '|' + $proc.Id`,
  ].join("; ");
}

/**
 * Wait until the freshly written helper proves it is running.
 *
 * A process id is not liveness — the helper can die before its first statement —
 * so a launch only counts once the marker the helper writes upfront has been
 * rewritten by this attempt.
 * @param helperReady - Marker path.
 * @param notBefore - Only a marker written after this instant counts.
 * @param timeoutMs - How long to wait for the marker.
 * @returns True once the helper reported for duty.
 */
async function waitForHelperReady(helperReady, notBefore, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (statSync(helperReady).mtimeMs >= notBefore) return true;
    } catch {
      // The helper has not written its marker yet.
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, HELPER_READY_POLL_MS));
  }
}

/**
 * Launch the helper and prove it is running before anything is killed.
 * @param helperPath - Helper script path.
 * @param helperReady - Marker path the helper writes first.
 * @returns How it was started and its pid.
 */
async function launchWindowsHelper(helperPath, helperReady) {
  let lastError = "";
  const attempts = [
    { mode: "hidden", via: "start-process-hidden" },
    { mode: "visible", via: "start-process-visible" },
  ];
  for (const attempt of attempts) {
    const notBefore = Date.now();
    try {
      const { stdout } = await execFileCapture(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", buildWindowsLauncherCommand(helperPath, attempt.mode === "visible")],
        { encoding: "utf8", windowsHide: true, timeout: 20000 },
      );
      const created = /^(hidden|visible)\|(\d+)$/.exec(stdout.trim());
      if (created === null) throw new Error(`the launcher reported no process id (${JSON.stringify(stdout.trim())})`);
      const pid = Number.parseInt(created[2], 10);
      if (await waitForHelperReady(helperReady, notBefore, HELPER_READY_MS)) {
        if (attempt.mode === "visible") log("the helper needed a visible console (the hidden window state was rejected)");
        return { via: attempt.via, pid };
      }
      lastError = `pid ${pid} never ran the helper`;
      log(`the helper was handed a process id but never reported for duty (${lastError})`);
    } catch (error) {
      lastError = String(error && error.message ? error.message : error);
      log(`starting the helper failed: ${lastError}`);
    }
  }
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", helperPath],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  child.unref();
  if (typeof child.pid !== "number") throw new Error(`the restart helper could not be started (${lastError})`);
  return { via: "detached-spawn", pid: child.pid };
}

/**
 * Start the helper with a clean liveness marker in place.
 * @param helperPath - Helper script path.
 * @returns How it was started and its pid.
 */
async function startWindowsHelper(helperPath) {
  const helperReady = helperReadyPath();
  try {
    rmSync(helperReady, { force: true });
  } catch {
    // A stale marker would make a dead helper look alive.
  }
  return launchWindowsHelper(helperPath, helperReady);
}

/**
 * Create the restart helper for the current platform.
 * @param mode - `desktop` or `web`.
 * @param options - Port the old server was reached on.
 * @returns How it was started and its pid.
 */
async function launchHelper(mode, options = {}) {
  const spec = restartSpec(mode);
  if (platform() === "win32") {
    const script = buildWindowsHelperScript(spec, { port: options.port, helperReady: helperReadyPath() });
    return startWindowsHelper(writeHelper(`${PLUGIN_ID}-helper.ps1`, script));
  }
  const helperPath = writeHelper(`${PLUGIN_ID}-helper.sh`, buildPosixHelperScript(spec));
  const child = spawn("/bin/sh", [helperPath], {
    detached: true,
    stdio: "ignore",
    env: relaunchEnv(),
  });
  child.unref();
  if (typeof child.pid !== "number") throw new Error("the restart helper could not be started");
  return { via: "detached-sh", pid: child.pid };
}

/**
 * Write one JSON response.
 * @param res - HTTP response.
 * @param status - Status code.
 * @param body - JSON body.
 */
function sendJson(res, status, body) {
  try {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(payload),
    });
    res.end(payload);
  } catch {
    /* the client may be gone already */
  }
}

/**
 * Consume a request body so the socket is not held open.
 * @param req - HTTP request.
 */
function drain(req) {
  try {
    if (typeof req.resume === "function") req.resume();
  } catch {
    /* ignore */
  }
}

/** Guards against two overlapping restart requests. */
let restarting = false;

/**
 * Report liveness, boot identity and the restart mode.
 * @param req - HTTP request.
 * @param res - HTTP response.
 */
function handlePing(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { ok: false, error: "method not allowed" });
    return;
  }
  if (!requestOriginAllowed(req.headers)) {
    sendJson(res, 403, { ok: false, error: "untrusted origin" });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    plugin: PLUGIN_ID,
    boot: BOOT,
    pid: process.pid,
    platform: platform(),
    mode: detectMode(),
  });
}

/**
 * Start the restart helper. The helper does the terminating, after the response
 * below has had time to flush.
 * @param req - HTTP request.
 * @param res - HTTP response.
 */
async function handleRestart(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "method not allowed" });
    return;
  }
  if (!requestOriginAllowed(req.headers)) {
    sendJson(res, 403, { ok: false, error: "untrusted origin" });
    return;
  }
  if (restarting) {
    sendJson(res, 409, { ok: false, error: "a restart is already in progress" });
    return;
  }
  restarting = true;
  drain(req);
  const mode = detectMode();
  const port = requestPort(req.headers);
  try {
    const started = await launchHelper(mode, { port });
    log(`restart requested (mode=${mode}, port=${port}), helper pid ${started.pid} via ${started.via}`);
    sendJson(res, 200, { ok: true, plugin: PLUGIN_ID, boot: BOOT, mode, port, via: started.via });
  } catch (error) {
    restarting = false;
    const message = String(error && error.message ? error.message : error);
    log(`restart failed: ${message}`);
    sendJson(res, 500, { ok: false, error: message });
  }
}

/**
 * Register the plugin routes.
 * @param ctx - Cordis context with the injected `webServer`.
 */
export function apply(ctx) {
  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({ kind: "exact", path: ROUTE_PING, handler: handlePing }),
      ctx.webServer.register({ kind: "exact", path: ROUTE_RESTART, handler: handleRestart }),
    ];
    log(`routes registered (${ROUTE_PING}, ${ROUTE_RESTART}; mode=${detectMode()}, boot=${BOOT})`);
    return () => {
      for (const dispose of disposers) {
        if (typeof dispose === "function") dispose();
      }
    };
  }, `${PLUGIN_ID}: http routes`);
}
