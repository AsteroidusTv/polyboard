import assert from "node:assert/strict";
import test from "node:test";
import {marketIntent, OrderSide, orderIntent, recheckOrder, verifyOrderSignature} from "./client.js";

const market = {version: "v1"};
const book = {tickSize: 0.01, minOrderSize: "5", negRisk: false};
const outcome = {assetId: "123"};
const wallet = "0x" + "1".repeat(40);
const zero = "0x" + "0".repeat(64);

test("limit orders use exact decimal amounts and enforce tick and quantity", () => {
  const intent = orderIntent(market, book, outcome, OrderSide.BUY, "0.52", "5.25");
  assert.equal(intent.quantity, 5250000n);
  assert.equal(intent.notional, 2730000n);
  assert.throws(() => orderIntent(market, book, outcome, OrderSide.BUY, "0.525", "5.25"), /increment/);
  assert.throws(() => orderIntent(market, book, outcome, OrderSide.BUY, "0.52", "4.99"), /Minimum/);
  assert.throws(() => orderIntent(market, book, outcome, OrderSide.BUY, "0.52", "5.251"), /valid price and share quantity/);
});

test("MetaMask signature must match the reviewed asset, maker, contract and amounts", () => {
  const intent = orderIntent(market, book, outcome, OrderSide.SELL, "0.52", "10");
  const session = {wallet, address: wallet, client: {account: {walletType: 0}}};
  const domain = {name: "Polymarket CTF Exchange", version: "2", verifyingContract: intent.exchange};
  const message = {maker: wallet, signer: wallet, makerAmount: 10000000n, takerAmount: 5200000n,
    tokenId: 123n, side: 1, signatureType: 0, builder: zero, metadata: zero};
  const payload = {primaryType: "Order", domain, message};
  assert.doesNotThrow(() => verifyOrderSignature(payload, session, intent));
  assert.throws(() => verifyOrderSignature({...payload, message: {...message, takerAmount: 5000000n}}, session, intent), /price/);
  assert.throws(() => verifyOrderSignature({...payload, message: {...message, tokenId: 124n}}, session, intent), /does not match/);
  assert.throws(() => verifyOrderSignature({...payload, domain: {...domain, verifyingContract: wallet}}, session, intent), /does not match/);
});

test("Deposit Wallet orders bind the outer signature request and maker to the funding account", () => {
  const intent = orderIntent({version: "v2"}, book, {assetId: "0x" + "3".repeat(64)}, OrderSide.BUY, "0.52", "10");
  const session = {wallet, address: "0x" + "2".repeat(40), client: {account: {walletType: 3}}};
  const domain = {name: "Polymarket CTF Exchange", version: "3", verifyingContract: intent.exchange};
  const contents = {maker: wallet, signer: wallet, makerAmount: 5200000n, takerAmount: 10000000n,
    tokenId: BigInt(intent.assetId), side: 0, signatureType: 3, builder: zero, metadata: zero};
  const message = {name: "DepositWallet", verifyingContract: wallet, chainId: 137, contents};
  const payload = {primaryType: "TypedDataSign", domain, message};
  assert.doesNotThrow(() => verifyOrderSignature(payload, session, intent));
  assert.throws(() => verifyOrderSignature({...payload, message: {...message, verifyingContract: session.address}}, session, intent), /does not match/);
});

test("market quotes consume the book and expose the worst reviewed price", () => {
  const tradable = {...book,
    asks: [{price: "0.6", size: "20"}, {price: "0.5", size: "4"}],
    bids: [{price: "0.4", size: "2"}, {price: "0.45", size: "3"}]};
  const feeFree = {version: "v1", trading: {feesEnabled: false}};
  const buy = marketIntent(feeFree, tradable, outcome, OrderSide.BUY, "5");
  assert.equal(buy.shares, 9000000n);
  assert.equal(buy.gross, 5000000n);
  assert.equal(buy.bound, 600000n);
  const sell = marketIntent(feeFree, tradable, outcome, OrderSide.SELL, "8");
  assert.equal(sell.shares, 5000000n);
  assert.equal(sell.gross, 2150000n);
  assert.equal(sell.bound, 400000n);
  assert.equal(sell.partiallyQuoted, true);
  assert.throws(() => recheckOrder(feeFree, {...tradable, asks: [{price: "0.61", size: "10"}]}, outcome, buy), /price protection/);
  assert.doesNotThrow(() => recheckOrder(feeFree, {...tradable, asks: [{price: "0.59", size: "10"}]}, outcome, buy));
});

test("market estimates include known taker fees and guard against excess spend or worse prices", () => {
  const tradable = {...book, asks: [{price: "0.5", size: "100"}], bids: [{price: "0.5", size: "100"}]};
  const feeMarket = {version: "v1", trading: {feesEnabled: true, feeSchedule: {rate: 0.04, exponent: 1}}};
  const buy = marketIntent(feeMarket, tradable, outcome, OrderSide.BUY, "5.10");
  assert.equal(buy.shares, 10000000n);
  assert.equal(buy.fee, 100000n);
  const session = {wallet, address: wallet, client: {account: {walletType: 0}}};
  const domain = {name: "Polymarket CTF Exchange", version: "2", verifyingContract: buy.exchange};
  const message = {maker: wallet, signer: wallet, makerAmount: 5000000n, takerAmount: 10000000n,
    tokenId: 123n, side: 0, signatureType: 0, builder: zero, metadata: zero};
  const payload = {primaryType: "Order", domain, message};
  assert.doesNotThrow(() => verifyOrderSignature(payload, session, buy));
  assert.throws(() => verifyOrderSignature({...payload, message: {...message, makerAmount: 5200000n}}, session, buy), /exceeds/);
  assert.throws(() => verifyOrderSignature({...payload, message: {...message, takerAmount: 9900000n}}, session, buy), /exceeds/);
  const sell = marketIntent(feeMarket, tradable, outcome, OrderSide.SELL, "10");
  assert.throws(() => verifyOrderSignature({...payload, message: {...message, side: 1, makerAmount: 10000000n,
    takerAmount: 4900000n}}, session, sell), /exceeds/);
});
