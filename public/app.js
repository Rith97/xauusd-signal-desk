const chart = document.querySelector("#chart");
const ctx = chart.getContext("2d");
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
const takeProfitLevel = document.querySelector("#takeProfitLevel");
const strategyList = document.querySelector("#strategyList");

let activeInterval = "5m";
let refreshTimer = null;
let liveSocket = null;
let lastPayload = null;
let lastCandles = [];

const fmt = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

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
  const stop = direction === "BUY" ? latest.close - atrLatest * 1.4 : direction === "SELL" ? latest.close + atrLatest * 1.4 : null;
  const takeProfit = direction === "BUY" ? latest.close + atrLatest * 2.2 : direction === "SELL" ? latest.close - atrLatest * 2.2 : null;

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
    entry: latest.close,
    stop,
    takeProfit
  };
}

function resizeCanvas() {
  const rect = chart.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  chart.width = Math.max(800, Math.floor(rect.width * scale));
  chart.height = Math.max(420, Math.floor(rect.height * scale));
}

function drawChart(candles, analysis) {
  resizeCanvas();
  const width = chart.width;
  const height = chart.height;
  const padding = { top: 24, right: 64, bottom: 34, left: 48 };
  const visible = candles.slice(-120);
  const highs = visible.map((candle) => candle.high);
  const lows = visible.map((candle) => candle.low);
  const max = Math.max(...highs);
  const min = Math.min(...lows);
  const range = max - min || 1;
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  const candleW = Math.max(4, plotW / visible.length * 0.62);

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#11161a";
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "#253039";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 5; i += 1) {
    const y = padding.top + (plotH / 5) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
    const price = max - (range / 5) * i;
    ctx.fillStyle = "#9aa8a5";
    ctx.font = `${12 * (window.devicePixelRatio || 1)}px sans-serif`;
    ctx.fillText(fmt.format(price), width - padding.right + 8, y + 4);
  }

  const yFor = (price) => padding.top + ((max - price) / range) * plotH;

  visible.forEach((candle, index) => {
    const x = padding.left + (plotW / Math.max(visible.length - 1, 1)) * index;
    const openY = yFor(candle.open);
    const closeY = yFor(candle.close);
    const highY = yFor(candle.high);
    const lowY = yFor(candle.low);
    const bullish = candle.close >= candle.open;
    ctx.strokeStyle = bullish ? "#1fbf75" : "#e25252";
    ctx.fillStyle = bullish ? "#1fbf75" : "#e25252";
    ctx.beginPath();
    ctx.moveTo(x, highY);
    ctx.lineTo(x, lowY);
    ctx.stroke();
    const bodyY = Math.min(openY, closeY);
    const bodyH = Math.max(2, Math.abs(closeY - openY));
    ctx.fillRect(x - candleW / 2, bodyY, candleW, bodyH);
  });

  if (analysis.stop && analysis.takeProfit) {
    const lines = [
      ["Entry", analysis.entry, "#d8a83f"],
      ["Stop", analysis.stop, "#e25252"],
      ["TP", analysis.takeProfit, "#1fbf75"]
    ];
    lines.forEach(([label, price, color]) => {
      const y = yFor(price);
      ctx.strokeStyle = color;
      ctx.setLineDash([8, 8]);
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.fillText(`${label} ${fmt.format(price)}`, padding.left + 8, y - 6);
    });
  }
}

function render(payload) {
  const candles = payload.candles || [];
  if (candles.length < 60) throw new Error("Not enough candles returned");
  lastPayload = payload;
  lastCandles = candles;
  const analysis = analyze(candles);
  drawChart(candles, analysis);

  lastPrice.textContent = fmt.format(analysis.latest.close);
  providerState.textContent = `Provider: ${payload.provider}`;
  spreadState.textContent = `${payload.symbol} ${payload.interval}`;
  const ageSeconds = Math.round((Date.now() - payload.marketTime) / 1000);
  marketClock.textContent = `Last candle ${new Date(payload.marketTime).toLocaleString()} (${ageSeconds}s old)`;
  connectionDot.className = "dot live";

  signalCard.className = `signal-card ${analysis.direction.toLowerCase()}`;
  signalText.textContent = analysis.direction;
  confidenceText.textContent = `${analysis.confidence}% confidence score ${analysis.score}`;
  trendMetric.textContent = analysis.trend;
  rsiMetric.textContent = analysis.rsi ? analysis.rsi.toFixed(1) : "--";
  macdMetric.textContent = analysis.macd ? analysis.macd.toFixed(2) : "--";
  atrMetric.textContent = fmt.format(analysis.atr);
  entryLevel.textContent = fmt.format(analysis.entry);
  stopLevel.textContent = analysis.stop ? fmt.format(analysis.stop) : "--";
  takeProfitLevel.textContent = analysis.takeProfit ? fmt.format(analysis.takeProfit) : "--";

  strategyList.innerHTML = "";
  for (const [name, value] of analysis.checks) {
    const item = document.createElement("li");
    item.innerHTML = `<span>${name}</span><strong>${value}</strong>`;
    strategyList.append(item);
  }
}

function renderLiveCandle(candle) {
  if (!lastPayload || !lastCandles.length) return;
  const candles = [...lastCandles];
  const last = candles.at(-1);
  if (last && last.time === candle.time) {
    candles[candles.length - 1] = candle;
  } else if (!last || candle.time > last.time) {
    candles.push(candle);
  } else {
    return;
  }

  lastPayload = {
    ...lastPayload,
    candles,
    marketTime: candle.time,
    fetchedAt: Date.now()
  };
  render(lastPayload);
  marketClock.textContent = `Live ${new Date(candle.time).toLocaleString()}`;
}

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
    marketClock.textContent = `Live stream ${payload.tradeSymbol}`;
  };
  liveSocket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      const kline = data.k;
      if (!kline) return;
      renderLiveCandle({
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
    marketClock.textContent = "Live stream error, using refresh fallback";
  };
  liveSocket.onclose = () => {
    liveSocket = null;
    if (autoRefresh.checked) {
      marketClock.textContent = "Live stream closed, reconnecting";
      setTimeout(() => loadCandles().catch(showError), 3000);
    }
  };
}

async function loadCandles() {
  connectionDot.className = "dot";
  marketClock.textContent = "Fetching market data";
  const response = await fetch(`/api/candles?interval=${encodeURIComponent(activeInterval)}`, { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.detail || payload.error || "Market data request failed");
  render(payload);
  connectLiveStream(payload);
}

function scheduleRefresh() {
  clearInterval(refreshTimer);
  if (!autoRefresh.checked) return;
  const intervalMs = activeInterval === "1m" ? 15000 : 30000;
  refreshTimer = setInterval(() => loadCandles().catch(showError), intervalMs);
}

function showError(error) {
  connectionDot.className = "dot error";
  marketClock.textContent = error.message;
}

timeframes.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-interval]");
  if (!button) return;
  activeInterval = button.dataset.interval;
  closeLiveSocket();
  for (const item of timeframes.querySelectorAll("button")) item.classList.toggle("active", item === button);
  loadCandles().catch(showError);
  scheduleRefresh();
});

autoRefresh.addEventListener("change", () => {
  scheduleRefresh();
  if (autoRefresh.checked) loadCandles().catch(showError);
  else closeLiveSocket();
});
window.addEventListener("resize", () => {
  if (lastCandles.length > 60) drawChart(lastCandles, analyze(lastCandles));
});

loadCandles().catch(showError);
scheduleRefresh();
