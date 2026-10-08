#!/usr/bin/env node
/**
 * Zero-dependency build for dsh-restart.
 *
 * The plugin ships without any third-party tooling: both halves are authored as
 * plain ECMAScript under `src/` and emitted verbatim into `lib/`, which is the
 * path the DSH plugin contract expects. This script is the only writer of
 * `lib/`, so the shipped artifacts can never drift from the sources.
 *
 * It also enforces the two contract facts that are easy to break by accident:
 * the browser half must register itself under the package name, and it must
 * treat the shell-provided React runtime as external.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

/**
 * Modules the desktop shell already provides to every client plugin. They are
 * resolved through the ModuleLoader's `require`, never bundled: inlining a
 * second React copy breaks hooks with
 * `Cannot read properties of null (reading 'useState')`.
 */
const CLIENT_EXTERNALS = ["react", "react/jsx-runtime", "react-dom", "react-dom/client"];

const TARGETS = [
  { from: "src/index.ts", to: "lib/index.js", half: "host" },
  { from: "src/client/index.ts", to: "lib/client.js", half: "client" },
];

/**
 * Abort the build with a contract violation.
 * @param message - What went wrong.
 */
function fail(message) {
  process.stderr.write(`[build] ${message}\n`);
  process.exit(1);
}

for (const target of TARGETS) {
  const source = readFileSync(join(ROOT, target.from), "utf8");

  if (target.half === "client") {
    const expected = `window.__ModuleLoader__.load({ id: "${pkg.name}"`;
    if (!source.includes(expected)) {
      fail(`${target.from} must register as \`${expected}\``);
    }
    for (const external of CLIENT_EXTERNALS) {
      if (external.startsWith("react-dom") && source.includes(`require("${external}")`)) {
        fail(`${target.from} must not require ${external}; the shell owns the runtime`);
      }
    }
    const official = source.match(/require\("(@deepseek-ai\/[^"]+)"\)/);
    if (official !== null) {
      fail(`${target.from} must not require the official package ${official[1]}`);
    }
  }

  const output = join(ROOT, target.to);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, source, "utf8");
  process.stdout.write(
    `[build] ${target.from} -> ${target.to} (${Buffer.byteLength(source)} bytes)\n`,
  );
}

process.stdout.write(`[build] ${pkg.name}@${pkg.version} is ready\n`);
