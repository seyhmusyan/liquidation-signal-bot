export const config = { runtime: "nodejs" };

import { getActivePairs } from "../utils/pairsStore.js";
import { sendTelegramMessage } from "../utils/telegram.js";
import { getFunding, getOI, getLongShort, getLiqMap } from "../utils/coinglass.js";

async function fetchPrice(symbol) {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
    if (r.ok) return Number((await r.json()).price);
  } catch {}
  return null;
}

async function fetchBinance1m(symbol) {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=2`);
    if (!r.ok) return { price: await fetchPrice(symbol), changePct: 0 };

    const data = await r.json();
    const prev = Number(data[0][4]);
    const last = Number(data[1][4]);

    const price = last;
    const changePct = ((last - prev) / prev) * 100;

    return { price, changePct };
  } catch {
    return { price: await fetchPrice(symbol), changePct: 0 };
  }
}

export default async function handler(req, res) {
  const pairs = await getActivePairs();
  const results = [];

  for (const symbol of pairs) {
    const { price, changePct } = await fetchBinance1m(symbol);
    if (!price) continue;

    const funding = await getFunding(symbol);
    const oi = await getOI(symbol);
    const ls = await getLongShort(symbol);
    const liq = await getLiqMap(symbol, price);

    results.push({ symbol, price, changePct, funding, oi, ls, liq });
  }

  // Telegram summary
  let msg = "📊 <b>Piyasa Özeti</b>\n\n";

  for (const r of results) {
    msg += `
<b>${r.symbol}</b>
Fiyat: ${r.price}
Değişim: ${r.changePct.toFixed(2)}%
Funding: ${r.funding ?? "N/A"}
OI: ${r.oi ?? "N/A"}
Long/Short: ${r.ls ?? "N/A"}
Liq Yakın: ${r.liq?.nearestLong?.price ?? "?"} / ${r.liq?.nearestShort?.price ?? "?"}

`;
  }

  await sendTelegramMessage(msg);

  return res.json({ ok: true, count: results.length });
}
