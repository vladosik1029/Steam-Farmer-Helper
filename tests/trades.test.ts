import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTradeLink, tradeLinkFor, requireOfferItems } from "../electron/core/trades.ts";

test("trade link is parsed into SteamID64 and token", () => {
  const link = parseTradeLink(" https://steamcommunity.com/tradeoffer/new/?partner=40266080&token=AbC-12_x ");
  assert.equal(link.steamId, "76561198000531808");
  assert.equal(link.token, "AbC-12_x");
  assert.equal(link.url, "https://steamcommunity.com/tradeoffer/new/?partner=40266080&token=AbC-12_x");
  assert.equal(tradeLinkFor(link.steamId, link.token), link.url);
});

test("bad trade links are rejected", () => {
  for (const bad of [
    "",
    "steamcommunity.com/tradeoffer/new/?partner=1&token=abcdefgh",
    "http://steamcommunity.com/tradeoffer/new/?partner=1&token=abcdefgh",
    "https://steamcommunity.com.evil.ru/tradeoffer/new/?partner=1&token=abcdefgh",
    "https://steamcommunity.com/tradeoffer/new/?partner=abc&token=abcdefgh",
    "https://steamcommunity.com/tradeoffer/new/?partner=40266080",
    "https://steamcommunity.com/profiles/76561198000531808"
  ]) {
    assert.throws(() => parseTradeLink(bad), undefined, bad);
  }
});

test("offer items are validated", () => {
  assert.deepEqual(requireOfferItems([{ appid: 730, contextid: "2", assetid: "123", amount: 0 }]), [{ appid: 730, contextid: "2", assetid: "123", amount: 1 }]);
  assert.throws(() => requireOfferItems([{ appid: 730, contextid: "2", assetid: "x" }]));
  assert.throws(() => requireOfferItems(Array.from({ length: 201 }, (_, i) => ({ appid: 730, contextid: "2", assetid: String(i) }))));
});
