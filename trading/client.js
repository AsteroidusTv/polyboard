import {createPublicClient, OrderSide, SignerType, production} from "@polymarket/client";
import {fetchBalanceAllowance} from "@polymarket/client/actions";

const clob = "https://clob.polymarket.com";
const gamma = "https://gamma-api.polymarket.com";
const geo = "https://polymarket.com/api/geoblock";
export const addressPattern = /^0x[0-9a-f]{40}$/i;
export const orderIdPattern = /^0x[0-9a-f]{64}$/i;
const polygon = 137;
const reads = {retries: 0, timeout: 12000};
const lower = (address) => String(address || "").toLowerCase();
const zero = "0x" + "0".repeat(64);

export class TicketError extends Error {}

function assert(condition, message) {
  if (!condition) throw new TicketError(message);
}

function transport(input, options) {
  const request = new Request(input, options);
  const url = new URL(request.url);
  const method = request.method;
  const allowed = (url.origin === gamma && method === "GET") ||
    (url.origin === clob && (method === "GET" ||
      method === "POST" && ["/auth/api-key", "/order"].includes(url.pathname) ||
      method === "DELETE" && url.pathname === "/order"));
  assert(allowed, "The trading client blocked an unexpected network request.");
  return fetch(new Request(request, {credentials: "omit", redirect: "error", cache: "no-store",
    referrerPolicy: "no-referrer", signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)])}));
}

const publicClient = createPublicClient({fetch: transport});

export async function verifyEligibility() {
  let state;
  try {
    const response = await fetch(geo, {cache: "no-store", credentials: "omit", redirect: "error",
      referrerPolicy: "no-referrer", signal: AbortSignal.timeout(10000)});
    if (response.ok) state = await response.json();
  } catch {
    // Fail closed when the official location check cannot be completed.
  }
  assert(typeof state?.blocked === "boolean", "Polymarket eligibility could not be verified. Try again.");
  assert(!state.blocked, "Polymarket does not allow new orders from your location.");
}

export async function currentSigner(provider, address) {
  const [accounts, chain] = await Promise.all([
    provider.request({method: "eth_accounts"}), provider.request({method: "eth_chainId"})
  ]);
  assert(Number(chain) === polygon, "Switch MetaMask to Polygon and reconnect.");
  assert(lower(accounts?.[0]) === lower(address), "The selected MetaMask account changed. Reconnect to continue.");
}

export async function connectWallet(provider) {
  assert(window.isSecureContext, "Trading requires a secure connection.");
  const accounts = await provider.request({method: "eth_requestAccounts"});
  const address = lower(accounts?.[0]);
  assert(addressPattern.test(address), "Select an account in MetaMask.");
  const chain = await provider.request({method: "eth_chainId"});
  if (Number(chain) !== polygon) {
    await provider.request({method: "wallet_switchEthereumChain", params: [{chainId: "0x89"}]});
  }
  await currentSigner(provider, address);
  return address;
}

export async function funderFor(address) {
  try {
    const profile = await publicClient.fetchPublicProfile({address}, reads);
    if (addressPattern.test(profile?.proxyWallet || "")) return lower(profile.proxyWallet);
  } catch {
    // A public profile is a convenience. The user can supply the address.
  }
  return "";
}

export function verifyOrderSignature(payload, session, intent) {
  const {domain, message, primaryType} = payload;
  const deposit = primaryType === "TypedDataSign";
  const order = deposit ? message.contents : message;
  const expectedSigner = deposit ? session.wallet : session.address;
  assert(["Order", "TypedDataSign"].includes(primaryType) && domain.name === "Polymarket CTF Exchange" &&
    lower(domain.verifyingContract) === intent.exchange && domain.version === intent.protocolVersion && order &&
    Number(order.signatureType) === session.client.account.walletType &&
    (!deposit || (message.name === "DepositWallet" && lower(message.verifyingContract) === session.wallet &&
      Number(message.chainId) === polygon)) &&
    lower(order.maker) === session.wallet && lower(order.signer) === expectedSigner &&
    BigInt(order.tokenId) === BigInt(intent.assetId) && Number(order.side) === (intent.side === OrderSide.BUY ? 0 : 1) &&
    lower(order.builder) === zero && lower(order.metadata) === zero,
  "The signature request does not match your order.");
  const buy = intent.side === OrderSide.BUY;
  assert(BigInt(order.makerAmount) === (buy ? intent.notional : intent.quantity) &&
    BigInt(order.takerAmount) === (buy ? intent.quantity : intent.notional),
  "The signed size or price does not match your review.");
}

async function sign(provider, session, payload, intent) {
  await currentSigner(provider, session.address);
  assert(Number(payload.domain.chainId) === polygon, "The signature is not for Polygon.");
  if (intent) verifyOrderSignature(payload, session, intent);
  else assert(payload.primaryType === "ClobAuth" && payload.domain.name === "ClobAuthDomain" &&
    payload.domain.version === "1" && !payload.domain.verifyingContract &&
    lower(payload.message.address) === session.address &&
    payload.message.message === "This message attests that I control the given wallet",
  "MetaMask refused an unexpected authentication request.");
  return provider.request({method: "eth_signTypedData_v4", params: [
    session.address, JSON.stringify(payload, (_, value) => typeof value === "bigint" ? String(value) : value)
  ]});
}

export async function authenticate(provider, address, wallet) {
  wallet = lower(wallet.trim());
  assert(addressPattern.test(wallet) && !/^0x0{40}$/.test(wallet), "Enter the public trading address shown on Polymarket.");
  await verifyEligibility();
  await currentSigner(provider, address);
  const session = {provider, address, wallet, client: null, intent: null};
  const signer = {
    getAddress: async () => address,
    signTypedData: async (payload) => {
      assert(session.intent, "A limit order must be reviewed before signing.");
      return sign(provider, session, payload, session.intent);
    },
    signMessage: async () => { throw new TicketError("Unexpected message signature blocked."); },
    sendTransaction: async () => { throw new TicketError("On-chain transactions must be managed on Polymarket."); }
  };
  // Use the SDK authentication workflow without its automatic wallet deployment.
  const workflow = await publicClient.beginAuthentication({wallet}, signer);
  try {
    assert((await workflow.next()).value?.kind === "requestAddress", "Unexpected wallet authentication request.");
    const step = await workflow.next(address);
    assert(step.value?.kind === "signAuthMessage", "Unexpected wallet authentication request.");
    const signature = await sign(provider, session, step.value.payload);
    await currentSigner(provider, address);
    const ready = await workflow.next(signature);
    assert(ready.done && ready.value?.account.signerType === SignerType.OWNER &&
      lower(ready.value.account.wallet) === wallet && lower(ready.value.account.signer) === address,
    "This MetaMask account does not control the selected Polymarket wallet.");
    session.client = ready.value;
    return session;
  } finally {
    await workflow.return();
  }
}

export function fixed(value, decimals) {
  const parts = /^(\d+)(?:\.(\d+))?$/.exec(String(value));
  assert(parts && parts[1].length <= 9 && (parts[2]?.length || 0) <= decimals, "Enter a valid price and share quantity.");
  return BigInt(parts[1] + (parts[2] || "").padEnd(6, "0"));
}

export function orderIntent(market, book, outcome, side, price, size) {
  assert([OrderSide.BUY, OrderSide.SELL].includes(side), "Choose Buy or Sell.");
  const sharePrice = fixed(price, 4);
  const quantity = fixed(size, 2);
  const tick = fixed(book.tickSize, 4);
  assert(tick > 0n && sharePrice >= tick && sharePrice <= 1000000n - tick && sharePrice % tick === 0n,
    "Use a price on the " + book.tickSize + " pUSD increment.");
  assert(quantity > 0n && quantity >= fixed(book.minOrderSize, 6), "Minimum order: " + book.minOrderSize + " shares.");
  const contracts = production.contracts;
  return {assetId: outcome.assetId, side, price, size, quantity, notional: quantity * sharePrice / 1000000n,
    protocolVersion: market.version === "v2" ? "3" : "2",
    exchange: lower(market.version === "v2" ? contracts.exchangeV3 :
      book.negRisk ? contracts.negRiskExchange : contracts.standardExchange)};
}

export async function marketFor(slug) {
  const market = await publicClient.fetchMarket({slug}, reads);
  assert(market.slug === slug && market.conditionId && !market.state.closed && market.state.acceptingOrders === true,
    "This market is no longer accepting orders.");
  assert(market.state.enableOrderBook !== false && (!market.version || ["v1", "v2"].includes(market.version)),
    "This market does not support order-book trading.");
  const outcomes = Object.values(market.outcomes).map((item) => ({
    label: item.label, tokenId: item.tokenId, assetId: market.version === "v2" ? item.positionId : item.tokenId
  }));
  assert(outcomes.length === 2 && new Set(outcomes.map(({assetId}) => assetId)).size === 2 &&
    outcomes.every(({assetId, label}) => label && /^(?:\d{1,78}|0x[0-9a-f]{64})$/i.test(assetId || "")),
  "Polymarket did not return two tradable outcomes.");
  return {...market, outcomes};
}

export async function bookFor(market, outcome) {
  const book = await publicClient.fetchOrderBook({assetId: outcome.assetId}, reads);
  assert(lower(book.conditionId) === lower(market.conditionId) && lower(book.assetId) === lower(outcome.assetId),
    "This order book does not match the selected outcome.");
  return book;
}

export function balanceFor(session, side, outcome) {
  const params = side === OrderSide.BUY ? {assetType: "COLLATERAL"} :
    {assetType: "CONDITIONAL", assetId: outcome.assetId};
  return fetchBalanceAllowance(session.client, params, reads);
}

export async function placeOrder(session, intent, dispatch) {
  await currentSigner(session.provider, session.address);
  session.intent = intent;
  let order;
  try {
    order = await session.client.createLimitOrder({
      assetId: intent.assetId, side: intent.side, price: intent.price, size: intent.size
    });
  } finally {
    session.intent = null;
  }
  assert(order.orderType === "GTC" && BigInt(order.expiration) === 0n, "Unexpected limit order duration.");
  await currentSigner(session.provider, session.address);
  dispatch();
  return session.client.postOrder(order);
}

export async function openOrders(session, market) {
  await currentSigner(session.provider, session.address);
  const rows = [];
  for await (const page of session.client.listOpenOrders({market: market.conditionId}, reads)) {
    rows.push(...page.items);
  }
  return rows;
}

export async function cancelOrder(session, orderId) {
  assert(orderIdPattern.test(orderId), "Invalid order identifier.");
  await currentSigner(session.provider, session.address);
  const response = await session.client.cancelOrder({orderId});
  assert(response.canceled.includes(orderId), "Cancellation wasn’t confirmed. Refresh your open orders.");
}

export {OrderSide};
