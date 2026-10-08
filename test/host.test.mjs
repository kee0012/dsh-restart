/**
 * Node-half tests: mode detection, quoting, helper scripts and the origin guard.
 * Run with `node test/host.test.mjs`.
 */
import assert from "node:assert/strict";
import {
  buildPosixHelperScript,
  buildWindowsHelperScript,
  buildWindowsLauncherCommand,
  detectMode,
  quoteArgWin,
  quotePs,
  relaunchEnv,
  requestOriginAllowed,
  requestPort,
  restartSpec,
} from "../lib/index.js";

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

test("detectMode recognises the desktop host command line", () => {
  const desktopArgv = [
    "DeepSeek Harness.exe",
    "--expose-internals",
    "C:\\Program Files\\deepseek harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js",
    "D:\\DSH\\.dsh\\profiles\\desktop",
  ];
  assert.equal(detectMode(desktopArgv), "desktop");
});

test("detectMode treats every other host as web", () => {
  assert.equal(detectMode(["node", "D:\\dsh\\bin.js", "web"]), "web");
  assert.equal(detectMode(["node", "/usr/local/lib/dsh/bin.js"]), "web");
});

test("quotePs escapes embedded single quotes", () => {
  assert.equal(quotePs("plain"), "'plain'");
  assert.equal(quotePs("it's"), "'it''s'");
});

test("quoteArgWin leaves simple arguments bare and quotes the rest", () => {
  assert.equal(quoteArgWin("web"), "web");
  // An argument with neither whitespace nor a quote needs no quoting at all.
  assert.equal(quoteArgWin(String.raw`C:\dsh\bin.js`), String.raw`C:\dsh\bin.js`);
  assert.equal(quoteArgWin(String.raw`C:\Program Files\dsh\bin.js`), String.raw`"C:\Program Files\dsh\bin.js"`);
  // A trailing backslash inside quotes must be doubled, or it escapes the quote.
  const trailing = "C:\\Program Files\\";
  assert.equal(quoteArgWin(trailing), '"C:\\Program Files\\\\"');
  assert.equal(quoteArgWin('say "hi"'), String.raw`"say \"hi\""`);
});

test("restartSpec targets the shell parent in desktop mode", () => {
  const spec = restartSpec("desktop", {
    ppid: 4242,
    execPath: "C:\\App\\DeepSeek Harness.exe",
    cwd: "D:\\work",
    env: { PATH: "C:\\bin" },
  });
  assert.equal(spec.mode, "desktop");
  assert.equal(spec.relaunch, "shell");
  assert.equal(spec.pid, 4242);
  assert.deepEqual(spec.args, []);
  assert.equal(spec.exe, "C:\\App\\DeepSeek Harness.exe");
});

test("restartSpec replays the exact command line in web mode", () => {
  const spec = restartSpec("web", {
    pid: 99,
    execPath: "C:\\node\\node.exe",
    execArgv: ["--expose-internals"],
    argv: ["C:\\node\\node.exe", "D:\\dsh\\bin.js", "web", "--port", "19387"],
    cwd: "D:\\work",
    env: {},
  });
  assert.equal(spec.relaunch, "self");
  assert.equal(spec.pid, 99);
  assert.deepEqual(spec.args, ["--expose-internals", "D:\\dsh\\bin.js", "web", "--port", "19387"]);
});

const desktopSpec = restartSpec("desktop", {
  ppid: 4242,
  execPath: "C:\\Program Files\\deepseek harness\\DeepSeek Harness.exe",
  cwd: "D:\\work",
  env: { DSH_PROFILE: "desktop" },
});

test("the desktop helper kills the shell tree, waits and relaunches with verification", () => {
  const script = buildWindowsHelperScript(desktopSpec, {
    logPath: "C:\\Temp\\dsh-restart.log",
    port: 19387,
  });
  assert.match(script, /& taskkill\.exe \/PID 4242 \/T \/F/);
  assert.match(script, /ExecutablePath -ine 'C:\\Program Files\\deepseek harness\\DeepSeek Harness\.exe'/);
  assert.match(script, /Set-Item -LiteralPath 'Env:DSH_PROFILE' -Value 'desktop'/);
  assert.match(script, /Start-Sleep -Milliseconds 2000/);
  assert.match(script, /Get-Process -Id 4242/);
  // The replacement cannot boot while the old server still owns the port.
  assert.match(script, /Get-NetTCPConnection -LocalPort 19387 -State Listen/);
  // Losing the desktop single-instance lock makes a new shell quit instantly, so
  // every launch is watched and repeated instead of fired once.
  assert.match(script, /Get-DshShells/);
  assert.match(script, /for \(\$attempt = 1; \$attempt -le 5; \$attempt\+\+\)/);
  assert.match(script, /\$verifyUntil = \$launchedAt\.AddMilliseconds\(9000\)/);
  assert.match(script, /exited after/);
  assert.match(script, /is still running/);
  assert.match(script, /Start-Sleep -Milliseconds 2500/);
  assert.match(script, /restart complete \(instance pid /);
  assert.match(script, /start DSH by hand/);
  // The script holds a snapshot of the host environment, values included, so it has
  // to remove itself once the restart is over.
  assert.match(script, /Remove-Item -LiteralPath \$PSCommandPath -ErrorAction SilentlyContinue/);
});

test("the desktop helper only watches its own shots at the desktop lock", () => {
  const script = buildWindowsHelperScript(desktopSpec);
  // The executable alone cannot identify the shell: the packaged CLI leaves a
  // reparented, windowless host behind, and a process-tree-root test would adopt
  // that orphan as "already running" and skip the relaunch, so the app would be
  // killed and never come back. Only the shell owns a real app window.
  assert.match(script, /Get-ClassName|GetClassName/);
  assert.match(script, /Chrome_WidgetWin_1/);
  assert.match(script, /\[DshRestartWin32\]::IsWindowVisible\(\$hWnd\)/);
  assert.match(script, /\[DshRestartWin32\]::GetWindow\(\$hWnd, 4\)/);
  assert.match(script, /EnumWindows/);
  // Recognising the app must never fail towards "an instance is running": if the
  // window probe breaks, the helper logs it and launches instead of skipping.
  assert.match(script, /catch \{[\s\S]*?return @\(\)[\s\S]*?\}/);
  assert.match(script, /if \(\$existing\.Count -gt 0\) \{/);
  // The orphan never had a window, so a purely window-based test cannot see it.
  assert.doesNotMatch(script, /ParentProcessId/);
});

test("the web helper terminates this process and replays its arguments", () => {
  const spec = restartSpec("web", {
    pid: 99,
    execPath: "C:\\node\\node.exe",
    execArgv: [],
    argv: ["node", "D:\\dsh\\bin.js", "web"],
    cwd: "D:\\work space",
    env: {},
  });
  const script = buildWindowsHelperScript(spec);
  assert.match(script, /& taskkill\.exe \/PID 99 \/T \/F/);
  assert.match(script, /\$rest = 'D:\\dsh\\bin\.js web'/);
  assert.match(script, /-ArgumentList \$rest/);
  assert.match(script, /\$wd = 'D:\\work space'/);
  assert.match(script, /-WorkingDirectory \$wd/);
  // `dsh web` runs plain node, where the desktop shell-root test would match any
  // unrelated node process and decide a restart is unnecessary.
  assert.doesNotMatch(script, /Get-DshShells/);
  assert.doesNotMatch(script, /an instance is already running/);
});

test("the WMI launcher hides the helper console through the STARTUPINFO", () => {
  const command = buildWindowsLauncherCommand("C:\\Temp\\dsh-restart-helper.ps1");
  // An Int32 ShowWindow makes Invoke-CimMethod fail with HRESULT 0x80041005, and
  // the helper then comes back with a console flashing over the screen.
  assert.match(command, /Win32_ProcessStartup -ClientOnly -Property @\{ ShowWindow = \[uint16\] 0 \}/);
  assert.match(command, /ProcessStartupInformation = \$startup/);
  // If the startup record cannot be built or used, the plain call still has to run.
  assert.match(command, /if \(\$null -eq \$created\) \{ \$mode = 'visible'; \$created = Invoke-CimMethod/);
  assert.match(command, /-File "C:\\Temp\\dsh-restart-helper\.ps1"/);
  assert.match(command, /\$mode \+ '\|' \+ \$created\.ProcessId/);
  assert.doesNotMatch(command, /\}; else \{/);
});

test("the POSIX helper kills the target and restarts it detached", () => {
  const spec = restartSpec("web", {
    pid: 4711,
    execPath: "/usr/bin/node",
    execArgv: [],
    argv: ["node", "/opt/dsh/bin.js", "web"],
    cwd: "/srv/dsh work",
    env: {},
  });
  const script = buildPosixHelperScript(spec);
  assert.match(script, /^#!\/bin\/sh/);
  assert.match(script, /kill -TERM 4711/);
  assert.match(script, /kill -KILL 4711/);
  assert.match(script, /cd '\/srv\/dsh work'/);
  assert.match(script, /nohup '\/usr\/bin\/node' '\/opt\/dsh\/bin\.js' 'web'/);
  // The replacement is verified and retried, like the Windows helper.
  assert.match(script, /survived\(\) \{ pgrep -f '\/usr\/bin\/node'/);
  assert.match(script, /while \[ \$attempt -le 5 \]; do/);
  assert.match(script, /if survived; then started=1/);
  assert.match(script, /start DSH by hand/);
});

test("the POSIX desktop helper reopens the app bundle", () => {
  const spec = restartSpec("desktop", {
    ppid: 1234,
    execPath: "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness",
    cwd: "/Users/dsh",
    env: {},
  });
  const script = buildPosixHelperScript(spec);
  assert.match(script, /kill -TERM 1234/);
  assert.match(script, /open -n '\/Applications\/DeepSeek Harness\.app'/);
  assert.match(script, /survived\(\) \{ pgrep -f '\/Applications\/DeepSeek Harness\.app'/);
});

test("the Node-mode environment flags never reach the relaunched application", () => {
  // The desktop shell spawns its host child with ELECTRON_RUN_AS_NODE=1
  // (app.asar/lib/main.js:3529). This plugin runs inside that child, so the flag is
  // in process.env; replaying it makes the relaunched exe start as a bare Node
  // REPL, which reads a dead stdin and exits 0 after ~400 ms — a restart that
  // silently does nothing.
  const filtered = relaunchEnv({
    PATH: "C:\\bin",
    DSH_PROFILE: "desktop",
    ELECTRON_RUN_AS_NODE: "1",
    DSH_DESKTOP_NODE_EXECUTABLE: "C:\\app.exe",
  });
  assert.deepEqual(filtered, { PATH: "C:\\bin", DSH_PROFILE: "desktop" });

  const spec = restartSpec("desktop", {
    ppid: 4242,
    execPath: "C:\\app.exe",
    cwd: "C:\\work",
    env: { ELECTRON_RUN_AS_NODE: "1", DSH_PROFILE: "desktop" },
  });
  assert.deepEqual(spec.env, { DSH_PROFILE: "desktop" });

  const script = buildWindowsHelperScript(spec, { logPath: "C:\\Temp\\dsh-restart.log" });
  assert.match(script, /Set-Item -LiteralPath 'Env:DSH_PROFILE' -Value 'desktop'/);
  assert.doesNotMatch(script, /Set-Item -LiteralPath 'Env:ELECTRON_RUN_AS_NODE'/);
  assert.doesNotMatch(script, /Set-Item -LiteralPath 'Env:DSH_DESKTOP_NODE_EXECUTABLE'/);
  // Belt and braces: the helper clears them even if the WMI provider passed them on.
  assert.match(
    script,
    /Remove-Item -LiteralPath 'Env:ELECTRON_RUN_AS_NODE' -ErrorAction SilentlyContinue/,
  );
  assert.match(
    script,
    /Remove-Item -LiteralPath 'Env:DSH_DESKTOP_NODE_EXECUTABLE' -ErrorAction SilentlyContinue/,
  );

  const posix = buildPosixHelperScript(spec, { logPath: "/tmp/dsh-restart.log" });
  assert.match(posix, /^unset ELECTRON_RUN_AS_NODE DSH_DESKTOP_NODE_EXECUTABLE$/m);
});

test("requestPort reads the port the old server was reached on", () => {
  assert.equal(requestPort({ host: "127.0.0.1:19387" }), 19387);
  assert.equal(requestPort({ host: "localhost:5555" }), 5555);
  assert.equal(requestPort({ host: "127.0.0.1" }), 19387);
  assert.equal(requestPort({}), 19387);
  assert.equal(requestPort({ host: "dsh-app://app" }), 19387);
});

test("the origin guard accepts same-origin, the desktop origin and no origin", () => {
  assert.equal(requestOriginAllowed({ host: "127.0.0.1:19387" }), true);
  assert.equal(requestOriginAllowed({ host: "127.0.0.1:19387", origin: "dsh-app://app" }), true);
  assert.equal(requestOriginAllowed({ host: "127.0.0.1:19387", origin: "http://127.0.0.1:19387" }), true);
});

test("the origin guard rejects foreign and opaque origins", () => {
  assert.equal(requestOriginAllowed({ host: "127.0.0.1:19387", origin: "https://evil.example" }), false);
  assert.equal(requestOriginAllowed({ host: "127.0.0.1:19387", origin: "http://127.0.0.1:1234" }), false);
  assert.equal(requestOriginAllowed({ host: "127.0.0.1:19387", origin: "null" }), false);
  assert.equal(requestOriginAllowed({ host: "127.0.0.1:19387", origin: "not a url" }), false);
});

process.stdout.write(`\n${checks} host tests passed\n`);
