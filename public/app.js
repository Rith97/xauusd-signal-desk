const timeframes = document.querySelector("#timeframes");
const autoRefresh = document.querySelector("#autoRefresh");
const connectionDot = document.querySelector("#connectionDot");
const marketClock = document.querySelector("#marketClock");
const lastPrice = document.querySelector("#lastPrice");
const providerState = document.querySelector("#providerState");
const spreadState = document.querySelector("#spreadState");
const signalCard = document.querySelector("#signalCard");
const signalText = document.querySelector("#signalText");
const confidenceText = document.querySelector("#confidenceText");
const trendMetric = document.querySelector("#trendMetric");
const rsiMetric = document.querySelector("#rsiMetric");
const macdMetric = document.querySelector("#macdMetric");
const atrMetric = document.querySelector("#atrMetric");
const entryLevel = document.querySelector("#entryLevel");
const stopLevel = document.querySelector("#stopLevel");
const tp1Level = document.querySelector("#tp1Level");
const tp2Level = document.querySelector("#tp2Level");
const setupSide = document.querySelector("#setupSide");
const levelMap = document.querySelector("#levelMap");
const strategyList = document.querySelector("#strategyList");
const tvChart = document.querySelector("#tvChart");

const TV_SYMBOL = "OANDA:XAUUSD";

// Our timeframe buttons mapped to TradingView chart intervals.
const tvIntervals = {
  "1m": "1",
  "5m": "5",
  "15m": "15",
  "30m": "30",
  "1h": "60",
  "4h": "240",
  "1d": "D"
};

let activeInterval = "5m";
let refreshTimer = null;
let liveSocket = null;
let lastPayload = null;
let lastCandles = [];
let lastPaint = 0;
let paintQueued = false;

const fmt = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

/* ---------- Live chart (TradingView Advanced Chart widget) ---------- */

function mountChart(interval) {
  if (!tvChart) return;
  tvChart.innerHTML = "";

  const container = document.createElement("div");
  container.className = "tradingview-widget-container";

  const widget = document.createElement("div");
  widget.className = "tradingview-widget-container__widget";
  container.append(widget);

  const script = document.createElement("script");
  script.type = "text/javascript";
  script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
  script.async = true;
  script.innerHTML = JSON.stringify({
    autosize: true,
    symbol: TV_SYMBOL,
    interval: tvIntervals[interval] || "5",
    timezone: "Etc/UTC",
    theme: "dark",
    style: "1",
    locale: "en",
    enable_publishing: false,
    allow_symbol_change: true,
    hide_side_toolbar: false,
    studies: ["MAExp@tv-basicstudies", "RSI@tv-basicstudies"],
    support_host: "https://www.tradingview.com"
  });

  container.append(script);
  tvChart.append(container);
}

/* ---------- Indicators ---------- */

function sma(values, period) {
  return values.map((_, index) => {
    if (index + 1 < period) return null;
    const slice = values.slice(index + 1 - period, index + 1);
    return slice.reduce((sum, value) => sum + value, 0) / period;
  });
}

function ema(values, period) {
  const multiplier = 2 / (period + 1);
  const output = [];
  let previous = values[0];
  values.forEach((value, index) => {
    if (index === 0) {
      output.push(value);
      return;
    }
    previous = value * multiplier + previous * (1 - multiplier);
    output.push(previous);
  });
  return output;
}

function rsi(values, period = 14) {
  const output = Array(values.length).fill(null);
  let gains = 0;
  let losses = 0;

  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;
  output[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    output[index] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return output;
}

function atr(candles, period = 14) {
  const tr = candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    const previousClose = candles[index - 1].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose)
    );
  });
  return sma(tr, period);
}

function macd(values) {
  const ema12 = ema(values, 12);
  const ema26 = ema(values, 26);
  const line = values.map((_, index) => ema12[index] - ema26[index]);
  const signal = ema(line, 9);
  return { line, signal, histogram: line.map((value, index) => value - signal[index]) };
}

function candlePattern(candles) {
  const current = candles.at(-1);
  const previous = candles.at(-2);
  if (!current || !previous) return { name: "None", score: 0 };

  const body = Math.abs(current.close - current.open);
  const range = Math.max(current.high - current.low, 0.01);
  const upperWick = current.high - Math.max(current.open, current.close);
  const lowerWick = Math.min(current.open, current.close) - current.low;
  const bullishEngulfing = current.close > current.open && previous.close < previous.open && current.close > previous.open && current.open < previous.close;
  const bearishEngulfing = current.close < current.open && previous.close > previous.open && current.open > previous.close && current.close < previous.open;

  if (bullishEngulfing) return { name: "Bullish engulfing", score: 18 };
  if (bearishEngulfing) return { name: "Bearish engulfing", score: -18 };
  if (lowerWick > body * 2.2 && upperWick < body * 1.2) return { name: "Hammer / demand rejection", score: 12 };
  if (upperWick > body * 2.2 && lowerWick < body * 1.2) return { name: "Shooting star / supply rejection", score: -12 };
  if (body / range < 0.12) return { name: "Doji indecision", score: 0 };
  return { name: current.close >= current.open ? "Bullish candle" : "Bearish candle", score: current.close >= current.open ? 4 : -4 };
}

function supportResistance(candles) {
  const window = candles.slice(-80);
  return {
    support: Math.min(...window.map((candle) => candle.low)),
    resistance: Math.max(...window.map((candle) => candle.high))
  };
}

function analyze(candles) {
  const closes = candles.map((candle) => candle.close);
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const rsiValues = rsi(closes);
  const macdValues = macd(closes);
  const atrValues = atr(candles);
  const pattern = candlePattern(candles);
  const levels = supportResistance(candles);
  const latest = candles.at(-1);
  const i = candles.length - 1;

  let score = 0;
  const checks = [];
  const trendBull = ema21[i] > ema50[i];
  const shortBull = ema9[i] > ema21[i];
  const rsiLatest = rsiValues[i];
  const macdHist = macdValues.histogram[i];
  const atrLatest = atrValues[i] || latest.close * 0.0015;

  score += trendBull ? 18 : -18;
  checks.push(["EMA trend", trendBull ? "Bullish" : "Bearish"]);
  score += shortBull ? 16 : -16;
  checks.push(["EMA momentum", shortBull ? "9 EMA above 21 EMA" : "9 EMA below 21 EMA"]);

  if (rsiLatest > 58 && rsiLatest < 72) score += 14;
  else if (rsiLatest < 42 && rsiLatest > 28) score -= 14;
  else if (rsiLatest >= 72) score -= 8;
  else if (rsiLatest <= 28) score += 8;
  checks.push(["RSI zone", rsiLatest ? rsiLatest.toFixed(1) : "--"]);

  score += macdHist > 0 ? 14 : -14;
  checks.push(["MACD histogram", macdHist > 0 ? "Positive" : "Negative"]);

  score += pattern.score;
  checks.push(["Candlestick", pattern.name]);

  const nearSupport = latest.close - levels.support < atrLatest * 1.5;
  const nearResistance = levels.resistance - latest.close < atrLatest * 1.5;
  if (nearSupport) score += 8;
  if (nearResistance) score -= 8;
  checks.push(["Key level", nearSupport ? "Near support" : nearResistance ? "Near resistance" : "Mid-range"]);

  const direction = score >= 35 ? "BUY" : score <= -35 ? "SELL" : "HOLD";
  const confidence = Math.min(96, Math.max(35, Math.round(Math.abs(score) * 1.15)));

  // Long unless the signal is a SELL (or a bearish-leaning HOLD). Risk = 1.4 ATR;
  // targets are projected at 1R (TP1) and 2R (TP2) from entry.
  const bias = direction === "SELL" || (direction === "HOLD" && score < 0) ? -1 : 1;
  const risk = atrLatest * 1.4;
  const entry = latest.close;
  const stop = entry - bias * risk;
  const tp1 = entry + bias * risk * 1;
  const tp2 = entry + bias * risk * 2;

  return {
    direction,
    confidence,
    score,
    checks,
    latest,
    trend: trendBull ? "Bullish" : "Bearish",
    rsi: rsiLatest,
    macd: macdHist,
    atr: atrLatest,
    side: bias === 1 ? "Long" : "Short",
    entry,
    stop,
    tp1,
    tp2
  };
}

/* ---------- Trade-level map (SVG marker lines) ---------- */

function drawLevelMap(analysis) {
  if (!levelMap) return;

  const rows = [
    { key: "TP2", price: analysis.tp2, color: "#27d17c" },
    { key: "TP1", price: analysis.tp1, color: "#1fbf75" },
    { key: "Entry", price: analysis.entry, color: "#d8a83f" },
    { key: "SL", price: analysis.stop, color: "#e25252" }
  ].filter((row) => Number.isFinite(row.price));

  const prices = rows.map((row) => row.price);
  const max = Math.max(...prices);
  const min = Math.min(...prices);
  const span = max - min || 1;

  const W = 320;
  const H = 184;
  const padY = 20;
  const lineX1 = 12;
  const lineX2 = 196;
  const dotX = lineX2 + 12;
  const yFor = (price) => padY + (1 - (price - min) / span) * (H - padY * 2);

  // Vertical guide spanning the full SL-to-TP2 range.
  const guide = `<line x1="${dotX}" y1="${yFor(max).toFixed(1)}" x2="${dotX}" y2="${yFor(min).toFixed(1)}" stroke="#303942" stroke-width="2" />`;

  const items = rows.map((row) => {
    const y = yFor(row.price).toFixed(1);
    return (
      `<line x1="${lineX1}" y1="${y}" x2="${lineX2}" y2="${y}" stroke="${row.color}" stroke-width="2" stroke-dasharray="6 5" />` +
      `<circle cx="${dotX}" cy="${y}" r="3.5" fill="${row.color}" />` +
      `<text x="${lineX1}" y="${(Number(y) - 5).toFixed(1)}" fill="${row.color}" font-size="11" font-family="sans-serif">${row.key}</text>` +
      `<text x="${dotX + 10}" y="${(Number(y) + 4).toFixed(1)}" fill="${row.color}" font-size="12" font-weight="600" font-family="sans-serif">${fmt.format(row.price)}</text>`
    );
  }).join("");

  levelMap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Entry, TP1, TP2 and SL price levels">${guide}${items}</svg>`;
}

/* ---------- Signal panel rendering ---------- */

function paintSignal() {
  paintQueued = false;
  lastPaint = Date.now();

  const payload = lastPayload;
  const candles = lastCandles;
  if (!payload || candles.length < 60) return;

  const analysis = analyze(candles);

  lastPrice.textContent = fmt.format(analysis.latest.close);
  providerState.textContent = `Signal feed: ${payload.provider}`;
  spreadState.textContent = `${payload.symbol} ${payload.interval}`;
  if (payload.marketTime) {
    const ageSeconds = Math.max(0, Math.round((Date.now() - payload.marketTime) / 1000));
    marketClock.textContent = `Signal candle ${new Date(payload.marketTime).toLocaleTimeString()} · ${ageSeconds}s old`;
  }
  connectionDot.className = liveSocket ? "dot live" : "dot";

  signalCard.className = `signal-card ${analysis.direction.toLowerCase()}`;
  signalText.textContent = analysis.direction;
  confidenceText.textContent = `${analysis.confidence}% confidence · score ${analysis.score}`;
  trendMetric.textContent = analysis.trend;
  rsiMetric.textContent = analysis.rsi ? analysis.rsi.toFixed(1) : "--";
  macdMetric.textContent = analysis.macd ? analysis.macd.toFixed(2) : "--";
  atrMetric.textContent = fmt.format(analysis.atr);
  entryLevel.textContent = fmt.format(analysis.entry);
  stopLevel.textContent = fmt.format(analysis.stop);
  tp1Level.textContent = fmt.format(analysis.tp1);
  tp2Level.textContent = fmt.format(analysis.tp2);
  setupSide.textContent = analysis.side;
  setupSide.className = `side-tag ${analysis.side.toLowerCase()}`;
  drawLevelMap(analysis);

  strategyList.innerHTML = "";
  for (const [name, value] of analysis.checks) {
    const item = document.createElement("li");
    item.innerHTML = `<span>${name}</span><strong>${value}</strong>`;
    strategyList.append(item);
  }
}

// Coalesce rapid live ticks into at most ~4 repaints/second so the UI stays smooth.
function requestPaint(force = false) {
  if (force) {
    paintSignal();
    return;
  }
  if (paintQueued) return;
  const elapsed = Date.now() - lastPaint;
  const wait = Math.max(0, 250 - elapsed);
  paintQueued = true;
  setTimeout(() => requestAnimationFrame(paintSignal), wait);
}

function applyPayload(payload) {
  const candles = payload.candles || [];
  if (candles.length < 60) throw new Error("Not enough candles returned");
  lastPayload = payload;
  lastCandles = candles;
  requestPaint(true);
}

function updateLiveCandle(candle) {
  if (!lastPayload || !lastCandles.length) return;
  const last = lastCandles.at(-1);
  if (last && last.time === candle.time) {
    lastCandles[lastCandles.length - 1] = candle;
  } else if (!last || candle.time > last.time) {
    lastCandles.push(candle);
    if (lastCandles.length > 1500) lastCandles.shift();
  } else {
    return;
  }
  lastPayload.marketTime = candle.time;
  lastPayload.fetchedAt = Date.now();
  requestPaint();
}

/* ---------- Live signal feed (Binance WebSocket + REST fallback) ---------- */

function closeLiveSocket() {
  if (!liveSocket) return;
  liveSocket.onclose = null;
  liveSocket.close();
  liveSocket = null;
}

function connectLiveStream(payload) {
  closeLiveSocket();
  if (payload.dataProvider !== "binance" || !payload.wsStream) return;

  liveSocket = new WebSocket(payload.wsStream);
  liveSocket.onopen = () => {
    connectionDot.className = "dot live";
  };
  liveSocket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      const kline = data.k;
      if (!kline) return;
      updateLiveCandle({
        time: Number(kline.t),
        open: Number(kline.o),
        high: Number(kline.h),
        low: Number(kline.l),
        close: Number(kline.c),
        volume: Number(kline.v),
        closeTime: Number(kline.T)
      });
    } catch (error) {
      showError(error);
    }
  };
  liveSocket.onerror = () => {
    connectionDot.className = "dot error";
  };
  liveSocket.onclose = () => {
    liveSocket = null;
    if (autoRefresh.checked) {
      setTimeout(() => loadSignals().catch(showError), 3000);
    }
  };
}

async function loadSignals() {
  if (!lastPayload) marketClock.textContent = "Fetching signal data";
  const response = await fetch(`/api/candles?interval=${encodeURIComponent(activeInterval)}`, { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.detail || payload.error || "Market data request failed");
  applyPayload(payload);
  if (autoRefresh.checked) connectLiveStream(payload);
}

function scheduleRefresh() {
  clearInterval(refreshTimer);
  if (!autoRefresh.checked) return;
  const intervalMs = activeInterval === "1m" ? 15000 : 30000;
  refreshTimer = setInterval(() => loadSignals().catch(showError), intervalMs);
}

function showError(error) {
  connectionDot.className = "dot error";
  marketClock.textContent = error.message;
}

/* ---------- Controls ---------- */

timeframes.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-interval]");
  if (!button) return;
  activeInterval = button.dataset.interval;
  for (const item of timeframes.querySelectorAll("button")) item.classList.toggle("active", item === button);
  closeLiveSocket();
  mountChart(activeInterval);
  loadSignals().catch(showError);
  scheduleRefresh();
});

autoRefresh.addEventListener("change", () => {
  scheduleRefresh();
  if (autoRefresh.checked) loadSignals().catch(showError);
  else closeLiveSocket();
});

mountChart(activeInterval);
loadSignals().catch(showError);
scheduleRefresh();
