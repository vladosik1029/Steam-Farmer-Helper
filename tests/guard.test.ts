import { test } from "node:test";
import assert from "node:assert/strict";
import { assessDanger, kindOf, type GuardConfirmation } from "../electron/core/guard.ts";

const base: GuardConfirmation = {
  id: "1", type: 2, kind: "trade", title: "Trade with someone", sending: "", receiving: "",
  time: 0, icon: "", ours: false, danger: null
};

test("confirmation kinds", () => {
  assert.equal(kindOf(2, "Trade"), "trade");
  assert.equal(kindOf(3, "Sell - AK-47"), "market");
  assert.equal(kindOf(9, "Create API key"), "api-key");
  assert.equal(kindOf(1, "Web API Key"), "api-key");
  assert.equal(kindOf(5, "Phone"), "phone");
  assert.equal(kindOf(6, "Recovery"), "recovery");
  assert.equal(kindOf(12, "Something new"), "other");
});

test("routine confirmations are not dangerous", () => {
  assert.equal(assessDanger({ ...base, kind: "market", type: 3 }), null);
  assert.equal(assessDanger({ ...base, give: 1, receive: 1 }), null);
  // Gifts to your own accounts are fine
  assert.equal(assessDanger({ ...base, give: 3, receive: 0, partnerIsOwn: true }), null);
  // Our own offer to the partner we picked
  assert.equal(assessDanger({ ...base, give: 3, receive: 0, partnerSteamId: "76561198000000002", partnerIsOwn: true }, "76561198000000002"), null);
});

test("dangerous confirmations", () => {
  assert.match(assessDanger({ ...base, kind: "api-key", type: 9 })!, /API/);
  assert.ok(assessDanger({ ...base, kind: "phone", type: 5 }));
  assert.ok(assessDanger({ ...base, kind: "other", type: 12 }));
  // Giving away to a stranger for nothing
  assert.match(assessDanger({ ...base, give: 2, receive: 0, partnerIsOwn: false })!, /только отдаёте/);
  // Offer created by the app but the confirmation points to another partner
  assert.match(
    assessDanger({ ...base, give: 1, receive: 1, partnerSteamId: "76561198000000009" }, "76561198000000002")!,
    /не совпадает/
  );
});
