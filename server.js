import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = join(process.cwd(), "public");
const DATA_PROVIDER = (process.env.DATA_PROVIDER || "binance").toLowerCase();
const BINANCE_SYMBOL = process.env.BINANCE_SYMBOL || "PAXGUSDT";
const BINANCE_REST_URL = process.env.BINANCE_REST_URL || "https://data-api.binance.vision";
const YAHOO_SYMBOL = process.env.YAHOO_SYMBOL || "GC=F";
const DISPLAY_SYMBOL = process.env.DISPLAY_SYMBOL || "XAUUSD";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const intervalRanges = {
  "1m": "1d",
  "2m": "1d",
  "5m": "5d",
  "15m": "5d",
  "30m": "1mo",
  "60m": "1mo",
  "90m": "1mo",
  "1h": "1mo",
  "4h": "3mo",
  "1d": "1y",
  "1wk": "5y"
};

const yahooIntervals = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "60m",
  "4h": "60m",
  "1d": "1d",
  "1wk": "1wk"
};

const binanceIntervals = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1h",
  "4h": "4h",
  "1d": "1d",
  "1wk": "1w"
};

function json(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function wsSymbol(symbol) {
  return symbol.toLowerCase();
}

function aggregateCandles(candles, hours) {
  if (!hours) return candles;
  const bucketMs = hours * 60 * 60 * 1000;
  const buckets = new Map();

  for (const candle of candles) {
    const bucket = Math.floor(candle.time / bucketMs) * bucketMs;
    const current = buckets.get(bucket);
    if (!current) {
      buckets.set(bucket, { ...candle, time: bucket });
      continue;
    }
    current.high = Math.max(current.high, candle.high);
    current.low = Math.min(current.low, candle.low);
    current.close = candle.close;
    current.volume += candle.volume || 0;
  }

  return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
}

async function fetchBinanceCandles(interval) {
  const sourceInterval = binanceIntervals[interval] || "5m";
  const url = new URL("/api/v3/klines", BINANCE_REST_URL);
  url.searchParams.set("symbol", BINANCE_SYMBOL);
  url.searchParams.set("interval", sourceInterval);
  url.searchParams.set("limit", "1000");

  const response = await fetch(url, {
    headers: {
      "accept": "application/json",
      "user-agent": "Mozilla/5.0 xauusd-signal-desk"
    }
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Binance responded ${response.status}: ${detail.slice(0, 160)}`);
  }

  const rows = await response.json();
  const candles = rows
    .map((row) => ({
      time: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
      closeTime: Number(row[6])
    }))
    .filter((candle) =>
      Number.isFinite(candle.time) &&
      Number.isFinite(candle.open) &&
      Number.isFinite(candle.high) &&
      Number.isFinite(candle.low) &&
      Number.isFinite(candle.close)
    );

  return {
    symbol: DISPLAY_SYMBOL,
    tradeSymbol: BINANCE_SYMBOL,
    provider: `Binance ${BINANCE_SYMBOL}`,
    dataProvider: "binance",
    interval,
    sourceInterval,
    wsStream: `wss://stream.binance.com:9443/ws/${wsSymbol(BINANCE_SYMBOL)}@kline_${sourceInterval}`,
    candles,
    fetchedAt: Date.now(),
    marketTime: candles.at(-1)?.time || null,
    note: "Binance does not list spot XAUUSD directly. The default live feed uses PAXGUSDT as a gold-backed crypto proxy."
  };
}

async function fetchYahooCandles(interval) {
  const yahooInterval = yahooIntervals[interval] || "5m";
  const range = intervalRanges[interval] || "5d";
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(YAHOO_SYMBOL)}`);
  url.searchParams.set("interval", yahooInterval);
  url.searchParams.set("range", range);
  url.searchParams.set("includePrePost", "true");

  const response = await fetch(url, {
    headers: {
      "accept": "application/json",
      "user-agent": "Mozilla/5.0 xauusd-signal-desk"
    }
  });

  if (!response.ok) {
    throw new Error(`Yahoo Finance responded ${response.status}`);
  }

  const body = await response.json();
  const result = body?.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0] || {};

  let candles = timestamps
    .map((stamp, index) => ({
      time: stamp * 1000,
      open: quote.open?.[index],
      high: quote.high?.[index],
      low: quote.low?.[index],
      close: quote.close?.[index],
      volume: quote.volume?.[index] || 0
    }))
    .filter((candle) =>
      Number.isFinite(candle.time) &&
      Number.isFinite(candle.open) &&
      Number.isFinite(candle.high) &&
      Number.isFinite(candle.low) &&
      Number.isFinite(candle.close)
    );

  if (interval === "4h") candles = aggregateCandles(candles, 4);

  return {
    symbol: DISPLAY_SYMBOL,
    tradeSymbol: YAHOO_SYMBOL,
    provider: `Yahoo Finance ${YAHOO_SYMBOL}`,
    dataProvider: "yahoo",
    interval,
    sourceInterval: yahooInterval,
    candles,
    fetchedAt: Date.now(),
    marketTime: candles.at(-1)?.time || null,
    note: "Yahoo Finance can be delayed and the default feed is gold futures. For live spot XAUUSD execution-grade signals, connect a paid real-time metals/forex feed."
  };
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const interval = url.searchParams.get("interval") || "5m";
  const provider = (url.searchParams.get("provider") || DATA_PROVIDER).toLowerCase();

  if (!Object.hasOwn(binanceIntervals, interval) && !Object.hasOwn(yahooIntervals, interval)) {
    json(res, 400, { error: "Unsupported interval" });
    return;
  }

  try {
    const payload = provider === "yahoo"
      ? await fetchYahooCandles(interval)
      : await fetchBinanceCandles(interval);
    json(res, 200, payload);
  } catch (error) {
    json(res, 502, {
      error: "Could not fetch XAUUSD market data",
      detail: error.message,
      provider: provider === "yahoo" ? `Yahoo Finance ${YAHOO_SYMBOL}` : `Binance ${BINANCE_SYMBOL}`
    });
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const cleanPath = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  const filePath = cleanPath === "\\" || cleanPath === "/" ? join(PUBLIC_DIR, "index.html") : join(PUBLIC_DIR, cleanPath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      "content-type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "cache-control": "no-cache"
    });
    res.end(data);
  } catch {
    const fallback = await readFile(join(PUBLIC_DIR, "index.html"));
    res.writeHead(200, { "content-type": mimeTypes[".html"] });
    res.end(fallback);
  }
}

const server = createServer((req, res) => {
  if (req.url?.startsWith("/api/candles")) {
    handleApi(req, res);
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`XAUUSD Signal Desk running on http://localhost:${PORT}`);
});
