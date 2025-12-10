import { getActivePairs } from "../utils/pairsStore.js";
import { getMarket, inferBaseFromMarketSymbol } from "./providers/market";
import { getCombinedHeatmap } from "./providers/heatmap";
import { buildSignal } from "./strategy.js";
import { sendTelegramMessage } from "../../utils/telegram";
import { buildTradingViewLink } from "../../utils/tradingview";

export const config = { runtime: "nodejs" };

export default async function handler() {
  const pairs = await getActivePairs();
  const out = [];

  for (const symbol of pairs) {
    const base = inferBaseFromMarketSymbol(symbol);

    const { price } = await getMarket(symbol);
    const heatmap = await getCombinedHeatmap(symbol, base, price);
    const signal = buildSignal({ price, heatmap });

    if (signal) {
      const tv = buildTradingViewLink(symbol);

      const msg = `
🚨 <b>${symbol} Liquidation Signal</b>
📊 Type: <b>${signal.type}</b>
💰 Entry: ${signal.entry}
🎯 Target: ${signal.target}
🛑 Stop: ${signal.stop}
📈 Confidence: %${signal.confidence}

📉 TradingView:
${tv}

🕒 ${new Date().toUTCString()}
      `.trim();

      await sendTelegramMessage(msg);
    }

    out.push({ symbol, signal });
  }

  return new Response(JSON.stringify(out), { status: 200 });
}
