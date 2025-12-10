export function buildTradingViewLink(symbol, interval = "15") {
  return `https://www.tradingview.com/chart/?symbol=BINANCE:${symbol}&interval=${interval}`;
}
