import { test } from "node:test";
import assert from "node:assert/strict";
import { community, cooldownUntil } from "../electron/core/community.ts";

test("user actions go before background price lookups", async () => {
  const order: string[] = [];
  const proxy = "socks5://order.test:1080";
  const low = community(proxy, async () => { order.push("low"); }, "low");
  const high = community(proxy, async () => { order.push("high"); });
  await Promise.all([low, high]);
  assert.deepEqual(order, ["high", "low"]);
});

test("a 429 pauses the IP and later calls fail at once", async () => {
  const proxy = "socks5://limited.test:1080";
  await assert.rejects(
    community(proxy, async () => { throw new Error("HTTP error 429"); }),
    (err: any) => err.status === 429 && /429/.test(err.message)
  );
  assert.ok((cooldownUntil(proxy) ?? 0) > Date.now() + 50_000);

  let called = false;
  await assert.rejects(community(proxy, async () => { called = true; }), (err: any) => err.code === "RATE_LIMITED");
  assert.equal(called, false);
  // Other IPs are not affected
  assert.equal(cooldownUntil("socks5://other.test:1080"), null);
});
