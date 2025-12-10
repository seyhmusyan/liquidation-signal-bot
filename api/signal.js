export const config = { runtime: "nodejs" };

import { getActivePairs, toCoinglassSymbol } from "../utils/pairsStore.js";
import { sendTelegramMessage } from "../utils/telegram.js";
import { getFunding, getOI, getLongShort, getLiqMap } from "../utils/coinglass.js";

// Binance fiyat + 1m değişim
async function fetch1m(symbol) {
  try {
    const r = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=2`
    );

    const data = await r.json();
    const prev = Number(data[0][4]);
    const last = Number(data[1][4]);

    return {
      price: last,
      changePct: ((last - prev) / prev) * 100
    };
  } catch {
    return { price: null, changePct: 0 };
  }
}

export default async function handler(req, res) {
  const pairs = await getActivePairs();
  const output = [];

  for (const symbol of pairs) {
    const { price, changePct } = await fetch1m(symbol);
    if (!price) continue;

    const funding = await getFunding(symbol);
    const oi = await getOI(symbol);
    const ls = await getLongShort(symbol);
    const liq = await getLiqMap(toCoinglassSymbol(symbol), price);

    output.push({ symbol, price, changePct, funding, oi, ls, liq });
  }

  // Telegram mesajı
  let msg = "📊 <b>Analiz</b>\n\n";

  for (const x of output) {
    msg += `
<b>${x.symbol}</b>
Fiyat: ${x.price}
1m: ${x.changePct.toFixed(2)}%
Funding: ${x.funding ?? "N/A"}
OI: ${x.oi ?? "N/A"}
L/S: ${x.ls ?? "N/A"}
Liq: ${x.liq?.nearestLong?.price ?? "?"} / ${x.liq?.nearestShort?.price ?? "?"}
`;
  }

  await sendTelegramMessage(msg);

  res.json({ ok: true, count: output.length });
}
