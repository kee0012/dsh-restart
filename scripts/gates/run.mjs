#!/usr/bin/env node
/**
 * Consistency gates for this plugin (the `pnpm run gates` step of the
 * dsh-plugin-studio workflow). Everything the plugin contract makes mandatory is
 * checked here, so a broken rename or a hand-edited `lib/` fails loudly instead of
 * disappearing into a silent no-op at load time.
 *
 * Zero dependencies: Node built-ins only.
 * @module scripts/gates/run
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const failures = [];
let checks = 0;

/**
 * Record one gate result.
 * @param label - What is being checked.
 * @param ok - Result.
 * @param detail - Extra context for a failure.
 */
function gate(label, ok, detail = "") {
  checks += 1;
  if (ok) {
    process.stdout.write(`ok ${checks} - ${label}\n`);
    return;
  }
  failures.push(detail ? `${label}: ${detail}` : label);
  process.stdout.write(`NOT OK ${checks} - ${label}${detail ? ` (${detail})` : ""}\n`);
}

/**
 * Read a text file below the project root.
 * @param relative - Path relative to the project root.
 * @returns File contents.
 */
function read(relative) {
  return readFileSync(join(ROOT, relative), "utf8");
}

const pkg = JSON.parse(read("package.json"));
const patch = read("cordis.patch.yml");
const host = read("lib/index.js");
const client = read("lib/client.js");
const hostSource = read("src/index.ts");
const clientSource = read("src/client/index.ts");
const name = pkg.name;

// 1. package identity and entry points.
gate("package name is a valid package name", /^[a-z0-9][a-z0-9._-]*$/.test(name), name);
gate("package.json declares `type: module`", pkg.type === "module", String(pkg.type));
gate("main points at lib/index.js", pkg.main === "lib/index.js", String(pkg.main));
gate("exports[.] is the built host half", pkg.exports?.["."] === "./lib/index.js", String(pkg.exports?.["."]));
gate("exports[./client] is the built client half", pkg.exports?.["./client"] === "./lib/client.js", String(pkg.exports?.["./client"]));
gate("exports[./cordis.patch.yml] is published", pkg.exports?.["./cordis.patch.yml"] === "./cordis.patch.yml");
gate("exports[./package.json] is published", pkg.exports?.["./package.json"] === "./package.json");

// 2. dsh bundle + client contract.
gate("dsh.bundle.patch points at the patch file", pkg.dsh?.bundle?.patch === "./cordis.patch.yml", String(pkg.dsh?.bundle?.patch));
gate("dsh.client.platform is web", pkg.dsh?.client?.platform === "web", String(pkg.dsh?.client?.platform));
gate("dsh.client.inject is a non-empty list", Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0);
gate(
  "no @deepseek-ai/* dependency is declared",
  [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})].every((id) => !id.startsWith("@deepseek-ai/")),
  "the DSH profile provides them",
);
gate("files covers the shipped artefacts", ["lib", "cordis.patch.yml", "README.md", "LICENSE"].every((entry) => (pkg.files ?? []).includes(entry)), JSON.stringify(pkg.files));
gate("scripts expose build, bundle and gates", ["build", "bundle", "gates"].every((key) => typeof pkg.scripts?.[key] === "string"), JSON.stringify(pkg.scripts));

// 3. one name everywhere: package.json == cordis insert == ModuleLoader id.
gate("cordis.patch.yml inserts this package name", new RegExp(`^\\s*-?\\s*insert:`, "m").test(patch) && patch.includes(`id: ${name}`) && patch.includes(`name: ${name}`));
gate("client bundle registers this package name", client.includes(`window.__ModuleLoader__.load({ id: "${name}"`), "ModuleLoader id must equal the package name");

// 4. React stays external, no official package is bundled.
gate("client requires react", client.includes(`require("react")`));
gate("client leaves react-dom to the host", !client.includes("react-dom"));
gate("client does not bundle @deepseek-ai/*", !client.includes("@deepseek-ai/"));

// 5. both halves export the plugin contract.
gate("host half exports apply", /export\s*\{[^}]*\bapply\b/.test(host) || /export function apply/.test(host));
gate("host half injects only webServer", /export const inject = \["webServer"\]/.test(host), "ctx.* use must match inject");
gate("client half exports apply", /exports\.apply = apply/.test(client) || /module\.exports\.apply/.test(client));
gate("client half injects only slots", /const inject = \["slots"\]/.test(client), "ctx.* use must match inject");

// 6. both seats are registered, and they exclude each other.
gate("client registers the title bar seat", client.includes('"shell.overlay"'));
gate("client registers the header fallback seat", client.includes('"conversation.session.header.utilities"'));
gate("client keeps the desktop-only guard", client.includes("data-windows-titlebar"));

// 7. the restart path keeps its safety rails.
// The helper must not flash a console over the screen: it is started hidden, and
// only a hidden launch that never reports for duty is retried with a console.
gate(
  "host hides the helper console",
  host.includes('wantsVisible ? "Normal" : "Hidden"') && host.includes("-WindowStyle ${windowStyle}"),
  "the helper is started through Start-Process with a hidden window state",
);
gate(
  "host requires the helper to prove it is alive",
  host.includes("HELPER_READY_MS") && host.includes("-helper-ready") && host.includes("waitForHelperReady"),
  "a process id is not liveness; the helper rewrites its marker before anything is killed",
);
gate(
  "host never creates the helper through WMI",
  !host.includes("Win32_ProcessStartup") && !host.includes("Invoke-CimMethod -ClassName Win32_Process"),
  "WMI reported a pid for a process whose script never ran",
);
gate(
  "host filters the Node-mode variables",
  host.includes('const NODE_MODE_VARS = ["ELECTRON_RUN_AS_NODE", "DSH_DESKTOP_NODE_EXECUTABLE"]'),
  "the shell starts this host with ELECTRON_RUN_AS_NODE=1",
);
gate("host never assigns a Node-mode variable", !host.includes("Env:ELECTRON_RUN_AS_NODE"));
gate("host removes the helper script when done", host.includes("Remove-Item -LiteralPath $PSCommandPath"));

// 8. lib/ is derived, never edited by hand, and not stale.
gate("lib/index.js matches src/index.ts", host === hostSource, "run `npm run bundle`");
gate("lib/client.js matches src/client/index.ts", client === clientSource, "run `npm run bundle`");

if (failures.length > 0) {
  process.stdout.write(`\n${failures.length} of ${checks} gates failed:\n`);
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
  process.exit(1);
}
process.stdout.write(`\n${checks} gates passed\n`);
