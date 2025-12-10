export function buildTradingViewLink(symbol, tf="15") {
  return `https://www.tradingview.com/chart/?symbol=BINANCE:${symbol}&interval=${tf}`;
}
