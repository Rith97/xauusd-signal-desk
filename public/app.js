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
const strategyList = document.querySelector("#strategyList");
const tvChart = document.querySelector("#tvChart");

// TradingView's Lightweight Charts library (standalone build, global: LightweightCharts).
const LWC_URL = "https://unpkg.com/lightweight-charts@4/dist/lightweight-charts.standalone.production.js";

let activeInterval = "5m";
let refreshTimer = null;
let liveSocket = null;
let lastPayload = null;
let lastCandles = [];
let lastPaint = 0;
let paintQueued = false;

let chart = null;
let candleSeries = null;
let ema9Series = null;
let ema21Series = null;
let priceLines = [];
let chartReady = false;
let fitNextData = true;

const fmt = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

/* ---------- Live candlestick chart (TradingView Lightweight Charts) ---------- */

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("chart library failed to load"));
    document.head.append(script);
  });
}

async function initChart() {
  await loadScript(LWC_URL);
  const LWC = window.LightweightCharts;
  if (!LWC) throw new Error("chart library unavailable");
  tvChart.innerHTML = "";

  chart = LWC.createChart(tvChart, {
    width: tvChart.clientWidth || 800,
    height: tvChart.clientHeight || 460,
    layout: {
      background: { color: "#11161a" },
      textColor: "#9aa8a5",
      fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    },
    grid: {
      vertLines: { color: "#1b2228" },
      horzLines: { color: "#1b2228" }
    },
    rightPriceScale: { borderColor: "#303942" },
    timeScale: { borderColor: "#303942", timeVisible: true, secondsVisible: false },
    crosshair: { mode: LWC.CrosshairMode.Normal },
    localization: { priceFormatter: (price) => fmt.format(price) }
  });

  candleSeries = chart.addCandlestickSeries({
    upColor: "#1fbf75",
    downColor: "#e25252",
    wickUpColor: "#1fbf75",
    wickDownColor: "#e25252",
    borderVisible: false,
    priceFormat: { type: "price", precision: 2, minMove: 0.01 }
  });

  ema9Series = chart.addLineSeries({
    color: "#4aa3ff",
    lineWidth: 1,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false
  });
  ema21Series = chart.addLineSeries({
    color: "#b07cf0",
    lineWidth: 1,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false
  });

  // Keep the drawing buffer matched to the container.
  const fit = () => {
    const w = tvChart.clientWidth;
    const h = tvChart.clientHeight;
    if (w > 0 && h > 0) chart.resize(w, h);
  };
  new ResizeObserver(fit).observe(tvChart);
  fit();

  chartReady = true;
}

const toBar = (candle) => ({
  time: Math.floor(candle.time / 1000),
  open: candle.open,
  high: candle.high,
  low: candle.low,
  close: candle.close
});

function setChartData(candles) {
  if (!chartReady) return;
  candleSeries.setData(candles.map(toBar));

  const closes = candles.map((candle) => candle.close);
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  ema9Series.setData(candles.map((candle, i) => ({ time: Math.floor(candle.time / 1000), value: e9[i] })));
  ema21Series.setData(candles.map((candle, i) => ({ time: Math.floor(candle.time / 1000), value: e21[i] })));

  if (fitNextData) {
    chart.timeScale().fitContent();
    fitNextData = false;
  }
}

function updateChartLast(candle) {
  if (!chartReady) return;
  candleSeries.update(toBar(candle));
  const closes = lastCandles.map((item) => item.close);
  const time = Math.floor(candle.time / 1000);
  ema9Series.update({ time, value: ema(closes, 9).at(-1) });
  ema21Series.update({ time, value: ema(closes, 21).at(-1) });
}

// Draw Entry / TP1 / TP2 / SL as dashed price lines directly on the candles.
function drawChartLevels(analysis) {
  if (!chartReady) return;
  const LWC = window.LightweightCharts;
  for (const line of priceLines) candleSeries.removePriceLine(line);
  priceLines = [];

  const levels = [
    { price: analysis.tp2, color: "#27d17c", title: "TP2" },
    { price: analysis.tp1, color: "#1fbf75", title: "TP1" },
    { price: analysis.entry, color: "#d8a83f", title: "Entry" },
    { price: analysis.stop, color: "#e25252", title: "SL" }
  ];

  for (const level of levels) {
    if (!Number.isFinite(level.price)) continue;
    priceLines.push(candleSeries.createPriceLine({
      price: level.price,
      color: level.color,
      lineWidth: 2,
      lineStyle: LWC.LineStyle.Dashed,
      axisLabelVisible: true,
      title: level.title
    }));
  }
}

function showChartError(error) {
  if (tvChart) tvChart.innerHTML = `<p class="tv-loading">Live chart unavailable (${error.message}). Signals still running.</p>`;
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

/* ---------- Signal panel rendering ---------- */

function paintSignal() {
  paintQueued = false;
  lastPaint = Date.now();

  const payload = lastPayload;
  const candles = lastCandles;
  if (!payload || candles.length < 60) return;

  const analysis = analyze(candles);
  drawChartLevels(analysis);

  lastPrice.textContent = fmt.format(analysis.latest.close);
  providerState.textContent = `Feed: ${payload.provider}`;
  spreadState.textContent = `${payload.symbol} ${payload.interval}`;
  if (payload.marketTime) {
    const ageSeconds = Math.max(0, Math.round((Date.now() - payload.marketTime) / 1000));
    marketClock.textContent = `Candle ${new Date(payload.marketTime).toLocaleTimeString()} · ${ageSeconds}s old`;
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
  setChartData(candles);
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
  updateChartLast(candle);
  requestPaint();
}

/* ---------- Live feed (Binance WebSocket + REST fallback) ---------- */

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
  if (!lastPayload) marketClock.textContent = "Fetching market data";
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
  fitNextData = true;
  loadSignals().catch(showError);
  scheduleRefresh();
});

autoRefresh.addEventListener("change", () => {
  scheduleRefresh();
  if (autoRefresh.checked) loadSignals().catch(showError);
  else closeLiveSocket();
});

(async () => {
  try {
    await initChart();
  } catch (error) {
    showChartError(error);
  }
  loadSignals().catch(showError);
  scheduleRefresh();
})();
