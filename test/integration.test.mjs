/**
 * Integration tests: run the shipped host half against a stubbed Cordis context
 * and drive the real route handlers. Nothing here may reach the restart path —
 * a test process on this machine is a live DSH host, so the `restart` handler is
 * only exercised through the guards that return before it launches anything.
 * The last test asserts that no helper script was written, which is what proves
 * the safety property above.
 *
 * Run with `node test/integration.test.mjs`.
 */
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { apply, inject, name } from "../lib/index.js";

/** Helpers from an earlier real restart may still be on disk; only new ones count. */
const runStarted = Date.now();
let checks = 0;

/**
 * Run one named assertion.
 * @param label - Test name.
 * @param fn - Body, may be async.
 */
async function test(label, fn) {
  await fn();
  checks += 1;
  process.stdout.write(`ok ${checks} - ${label}\n`);
}

/** A response stub that records what the handler wrote. */
function makeResponse() {
  return {
    statusCode: 0,
    headers: null,
    body: "",
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(chunk) {
      this.body = chunk === undefined || chunk === null ? "" : String(chunk);
    },
  };
}

/** A request stub; `sameOrigin` adds the host header a browser would send. */
function makeRequest(method, origin) {
  const headers = { host: "127.0.0.1:19387" };
  if (origin !== undefined) headers.origin = origin;
  return {
    method,
    headers,
    resumed: false,
    resume() {
      this.resumed = true;
    },
  };
}

/** Mount the plugin on a stub context and return the routes it registered. */
function mount() {
  const routes = [];
  const disposed = [];
  const captured = {};
  const ctx = {
    effect(callback, label) {
      captured.label = label;
      captured.cleanup = callback();
    },
    webServer: {
      register(route) {
        routes.push(route);
        return () => disposed.push(route.path);
      },
    },
  };
  apply(ctx);
  return { routes, disposed, captured };
}

const { routes, disposed, captured } = mount();
const byPath = Object.fromEntries(routes.map((route) => [route.path, route]));

await test("the host half exports the Cordis contract", () => {
  assert.equal(name, "dsh-restart", "the plugin name must equal the package name");
  assert.deepEqual(inject, ["webServer"], "every ctx service used must be injected");
  assert.equal(typeof apply, "function");
});

await test("apply registers both routes inside ctx.effect", () => {
  assert.equal(captured.label, "dsh-restart: http routes");
  assert.equal(routes.length, 2);
  assert.deepEqual(
    routes.map((route) => [route.kind, route.path]),
    [
      ["exact", "/dsh-restart/ping"],
      ["exact", "/dsh-restart/restart"],
    ],
  );
  assert.equal(routes.every((route) => typeof route.handler === "function"), true);
});

await test("the effect disposer unregisters both routes", () => {
  assert.equal(typeof captured.cleanup, "function");
  captured.cleanup();
  assert.deepEqual(disposed, ["/dsh-restart/ping", "/dsh-restart/restart"]);
});

await test("ping reports the boot marker, mode and platform", async () => {
  const res = makeResponse();
  await byPath["/dsh-restart/ping"].handler(makeRequest("GET"), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(res.headers["cache-control"], "no-store");
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.plugin, "dsh-restart");
  assert.equal(body.pid, process.pid);
  assert.equal(body.mode, "web", "a plain node host is not the desktop shell");
  assert.match(body.boot, /^\d+-\d+$/, "boot must be a pid-timestamp marker");
});

await test("HEAD ping is allowed, other methods are not", async () => {
  const head = makeResponse();
  await byPath["/dsh-restart/ping"].handler(makeRequest("HEAD"), head);
  assert.equal(head.statusCode, 200);

  const post = makeResponse();
  await byPath["/dsh-restart/ping"].handler(makeRequest("POST"), post);
  assert.equal(post.statusCode, 405);
  assert.equal(JSON.parse(post.body).ok, false);
});

await test("the desktop shell origin is accepted, foreign origins are not", async () => {
  const desktop = makeResponse();
  await byPath["/dsh-restart/ping"].handler(makeRequest("GET", "dsh-app://app"), desktop);
  assert.equal(desktop.statusCode, 200, "dsh-app://app is the desktop renderer origin");

  const foreign = makeResponse();
  await byPath["/dsh-restart/restart"].handler(makeRequest("POST", "https://evil.example"), foreign);
  assert.equal(foreign.statusCode, 403);
  assert.equal(JSON.parse(foreign.body).error, "untrusted origin");
});

await test("restart only answers POST", async () => {
  const res = makeResponse();
  await byPath["/dsh-restart/restart"].handler(makeRequest("GET"), res);
  assert.equal(res.statusCode, 405);
});

await test("no restart helper was written while running these tests", () => {
  for (const file of ["dsh-restart-helper.ps1", "dsh-restart-helper.sh"]) {
    const path = join(tmpdir(), file);
    // A helper left behind by an earlier real restart is expected here; one
    // written during this run would mean a test reached the real restart path.
    if (existsSync(path)) {
      assert.ok(statSync(path).mtimeMs < runStarted, `${file} was written during this run`);
    }
  }
});

process.stdout.write(`\n${checks} integration tests passed\n`);
