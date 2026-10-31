import { cachedJson } from "./market.js";

const CACHE_KEY = "https://cache.opentrading.internal/symbols";
const BINANCE = "https://api.binance.com";

const POPULAR = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "BNBUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "ADAUSDT",
  "AVAXUSDT",
  "LINKUSDT",
  "TONUSDT",
  "DOTUSDT",
  "SUIUSDT",
  "LTCUSDT",
  "BCHUSDT",
  "TRXUSDT",
  "NEARUSDT",
  "APTUSDT",
  "ARBUSDT",
  "OPUSDT",
  "PEPEUSDT",
  "SHIBUSDT",
  "UNIUSDT",
  "ATOMUSDT",
  "FILUSDT",
  "INJUSDT",
  "SEIUSDT",
  "TIAUSDT",
  "FETUSDT",
  "WIFUSDT",
  "RNDRUSDT",
];

const STABLES = new Set([
  "USDC",
  "FDUSD",
  "TUSD",
  "BUSD",
  "DAI",
  "USDP",
  "USDD",
  "AEUR",
  "EUR",
  "GBP",
]);

const POPULAR_INDEX = new Map(POPULAR.map((symbol, index) => [symbol, index]));

const FALLBACK_SYMBOLS = POPULAR.map((symbol) => ({
  symbol,
  base: symbol.slice(0, -4),
  quote: "USDT",
}));

function toInfo(symbol, base, quote) {
  return { symbol, base, quote };
}

function sortSymbols(list) {
  return list.sort((a, b) => {
    const aIndex = POPULAR_INDEX.has(a.symbol) ? POPULAR_INDEX.get(a.symbol) : 1000;
    const bIndex = POPULAR_INDEX.has(b.symbol) ? POPULAR_INDEX.get(b.symbol) : 1000;
    if (aIndex !== bIndex) return aIndex - bIndex;
    return a.symbol.localeCompare(b.symbol);
  });
}

async function fetchExchangeInfo() {
  const response = await fetch(`${BINANCE}/api/v3/exchangeInfo`, {
    headers: { accept: "application/json", "user-agent": "OpenTrading/1.0" },
    signal: AbortSignal.timeout(9000),
  });

  if (!response.ok) throw new Error(`binance_http_${response.status}`);

  const data = await response.json();
  if (!data || !Array.isArray(data.symbols)) throw new Error("bad_exchange_info");

  const seen = new Set();
  const list = [];

  for (const item of data.symbols) {
    if (!item || item.status !== "TRADING") continue;
    if (item.quoteAsset !== "USDT") continue;
    if (item.isSpotTradingAllowed === false) continue;

    const base = String(item.baseAsset || "");
    if (!base || STABLES.has(base)) continue;
    if (/(UP|DOWN|BULL|BEAR)$/.test(base)) continue;

    const symbol = String(item.symbol || "");
    if (seen.has(symbol)) continue;

    seen.add(symbol);
    list.push(toInfo(symbol, base, "USDT"));
  }

  if (list.length < 10) throw new Error("too_few_symbols");
  return list;
}

export async function getSymbolList() {
  return cachedJson(CACHE_KEY, 3600, async () => {
    try {
      const symbols = sortSymbols(await fetchExchangeInfo());
      return { symbols, source: "binance" };
    } catch {
      return { symbols: FALLBACK_SYMBOLS.slice(), source: "fallback" };
    }
  });
}

export function searchSymbols(symbols, query, limit) {
  const normalized = String(query || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  if (!normalized) return symbols.slice(0, limit);

  const matches = [];

  for (const item of symbols) {
    let score = -1;

    if (item.symbol === normalized) score = 0;
    else if (item.symbol.startsWith(normalized)) score = 1;
    else if (item.base.startsWith(normalized)) score = 2;
    else if (item.symbol.includes(normalized) || item.base.includes(normalized)) score = 3;

    if (score >= 0) matches.push({ score, item });
  }

  matches.sort(
    (a, b) => a.score - b.score || a.item.symbol.localeCompare(b.item.symbol),
  );

  return matches.slice(0, limit).map((match) => match.item);
}
