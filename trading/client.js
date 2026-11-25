import {createPublicClient, OrderSide, OrderType, SignerType, production} from "@polymarket/client";
import {fetchBalanceAllowance} from "@polymarket/client/actions";

const clob = "https://clob.polymarket.com";
const gamma = "https://gamma-api.polymarket.com";
const geo = "https://polymarket.com/api/geoblock";
export const addressPattern = /^0x[0-9a-f]{40}$/i;
export const orderIdPattern = /^0x[0-9a-f]{64}$/i;
const polygon = 137;
const reads = {retries: 0, timeout: 12000};
const lower = (address) => String(address || "").toLowerCase();
const unit = 1000000n;
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
  const maker = BigInt(order.makerAmount);
  const taker = BigInt(order.takerAmount);
  if (intent.type === "market") {
    // The SDK floors BUY shares. Its implied price must stay below the next possible exchange tick.
    const protectedPrice = buy ? maker * unit < taker * (intent.bound + 100n) : taker * unit >= maker * intent.bound;
    assert(maker > 0n && taker > 0n && protectedPrice &&
      (buy ? maker <= intent.budget : maker === intent.quantity), "The signed size or price exceeds your review.");
    return;
  }
  assert(maker === (buy ? intent.notional : intent.quantity) && taker === (buy ? intent.quantity : intent.notional),
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

export function decimal(units) {
  const digits = String(units).padStart(7, "0");
  return (digits.slice(0, -6) + "." + digits.slice(-6)).replace(/\.?0+$/, "");
}

function orderIdentity(market, book, outcome, side) {
  assert([OrderSide.BUY, OrderSide.SELL].includes(side), "Choose Buy or Sell.");
  const contracts = production.contracts;
  return {assetId: outcome.assetId, side, protocolVersion: market.version === "v2" ? "3" : "2",
    exchange: lower(market.version === "v2" ? contracts.exchangeV3 :
      book.negRisk ? contracts.negRiskExchange : contracts.standardExchange)};
}

function validTick(book, price) {
  const tick = fixed(book.tickSize, 4);
  return tick > 0n && price >= tick && price <= unit - tick && price % tick === 0n;
}

export function orderIntent(market, book, outcome, side, price, size) {
  const sharePrice = fixed(price, 4);
  const quantity = fixed(size, 2);
  assert(validTick(book, sharePrice), "Use a price on the " + Number(book.tickSize) * 100 + "¢ increment.");
  assert(quantity > 0n && quantity >= fixed(book.minOrderSize, 6), "Minimum limit order: " + book.minOrderSize + " shares.");
  return {...orderIdentity(market, book, outcome, side), type: "limit", price, size, quantity,
    notional: quantity * sharePrice / unit};
}

function depth(book, side) {
  const buy = side === OrderSide.BUY;
  const normalized = (value) => fixed(String(value).includes(".") ? String(value).replace(/\.?0+$/, "") : value, 6);
  return (buy ? book.asks : book.bids).flatMap(({price, size}) => {
    try {
      const level = {price: normalized(price), size: normalized(size)};
      return validTick(book, level.price) && level.size > 0n ? [level] : [];
    } catch (error) {
      if (!(error instanceof TicketError)) throw error;
      return [];
    }
  }).sort((a, b) => Number(buy ? a.price - b.price : b.price - a.price));
}

export function marketIntent(market, book, outcome, side, input) {
  const identity = orderIdentity(market, book, outcome, side);
  const buy = side === OrderSide.BUY;
  const total = fixed(input, 2);
  assert(total > 0n, buy ? "Enter a positive amount." : "Enter a positive share quantity.");
  let remaining = total;
  let shares = 0n;
  let gross = 0n;
  let bound;
  let fees = 0n;
  const schedule = market.trading?.feeSchedule;
  const rate = Number(schedule?.rate);
  const exponent = Number(schedule?.exponent);
  const feeKnown = market.trading?.feesEnabled === false || (Number.isFinite(rate) && rate >= 0 && rate <= 1 &&
    Number.isFinite(exponent) && exponent >= 0);
  for (const level of depth(book, side)) {
    const price = Number(level.price) / Number(unit);
    const feePerShare = feeKnown && market.trading?.feesEnabled !== false ? rate * (price * (1 - price)) ** exponent : 0;
    const feeUnits = BigInt(Math.ceil(feePerShare * Number(unit)));
    const demand = buy ? remaining * unit / (level.price + feeUnits) : remaining;
    if (demand === 0n) break;
    const filled = demand < level.size ? demand : level.size;
    const cost = filled * level.price / unit;
    if (cost === 0n) continue;
    const fee = filled * feeUnits / unit;
    gross += cost;
    fees += fee;
    shares += filled;
    bound = level.price;
    remaining -= buy ? cost + fee : filled;
    if (filled === demand || remaining === 0n) break;
  }
  assert(bound, buy ? "No offers can fill that amount." : "No bids are available for this outcome.");
  const partiallyQuoted = buy ? remaining >= 10000n : remaining > 0n;
  return {...identity, type: "market", input, bound, shares, gross, fee: feeKnown ? fees : null, partiallyQuoted,
    budget: buy ? total : null, quantity: buy ? null : total};
}

export function recheckOrder(market, book, outcome, intent) {
  const checked = intent.type === "market" ? orderIdentity(market, book, outcome, intent.side) :
    orderIntent(market, book, outcome, intent.side, intent.price, intent.size);
  assert(checked.exchange === intent.exchange && checked.protocolVersion === intent.protocolVersion,
    "The trading contract changed. Reopen this ticket.");
  if (intent.type !== "market") return;
  const buy = intent.side === OrderSide.BUY;
  assert(validTick(book, intent.bound) && depth(book, intent.side)
    .some(({price}) => buy ? price <= intent.bound : price >= intent.bound),
  "The book moved past your price protection. Edit and review a fresh quote.");
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
    const common = {assetId: intent.assetId, side: intent.side};
    if (intent.type === "market") {
      const bound = decimal(intent.bound);
      const params = intent.side === OrderSide.BUY ?
        {amount: intent.input, maxSpend: intent.input, maxPrice: bound} : {shares: intent.input, minPrice: bound};
      order = await session.client.createMarketOrder({...common, ...params, orderType: OrderType.FAK});
    } else {
      order = await session.client.createLimitOrder({...common, price: intent.price, size: intent.size});
    }
  } finally {
    session.intent = null;
  }
  const expectedType = intent.type === "market" ? OrderType.FAK : OrderType.GTC;
  assert(order.orderType === expectedType && BigInt(order.expiration) === 0n, "Unexpected order duration.");
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
