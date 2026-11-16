/** Reachability probes must work in explicit no-auth mode without granting local authority. */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { it } from "node:test";
import { startServer } from "./support/server.ts";

it("answers no-auth status probes without inventing an authenticated local credential", async (t) => {
  const base = await startServer(
    t,
    resolve(import.meta.dirname, ".."),
    ["--import", "tsx", "src/main.ts"],
    [],
  );
  const response = await fetch(new URL("/api/auth/status", base));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { authenticated: false, local: false });
  assert.equal(response.headers.get("set-cookie"), null);
});

it("still requires a valid credential for status probes when authentication is enabled", async (t) => {
  const base = await startServer(
    t,
    resolve(import.meta.dirname, ".."),
    ["--import", "tsx", "src/main.ts"],
    ["--token", "auth-status-regression-token"],
    { authenticated: true },
  );
  assert.equal((await fetch(new URL("/api/auth/status", base))).status, 401);
  const response = await fetch(new URL("/api/auth/status", base), {
    headers: { authorization: "Bearer auth-status-regression-token" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { authenticated: true, local: true });
});
