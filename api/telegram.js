export const config = { runtime: "nodejs" };

import { addPair, removePair, getActivePairs } from "../utils/pairsStore.js";

const TOKEN = process.env.TELEGRAM_TOKEN;

export default async function handler(req, res) {
  const body = req.body;

  if (!body?.message) return res.json({ ok: true });

  const chatId = body.message.chat.id;
  const text = body.message.text?.trim() || "";

  // /pairs
  if (text === "/pairs") {
    const pairs = await getActivePairs();
    await send(chatId, "📊 Aktif Pariteler:\n" + pairs.map(p => `• ${p}`).join("\n"));
    return res.json({ ok: true });
  }

  // /addpair
  if (text.startsWith("/addpair")) {
    const symbol = text.split(" ")[1]?.toUpperCase();
    if (!symbol) {
      await send(chatId, "Kullanım: /addpair BTCUSDT");
      return res.json({ ok: true });
    }

    const pairs = await addPair(symbol);

    await send(chatId, `✅ Pair eklendi: ${symbol}\nYeni Liste:\n${pairs.join("\n")}`);
    return res.json({ ok: true });
  }

  // /rmpair
  if (text.startsWith("/rmpair")) {
    const symbol = text.split(" ")[1]?.toUpperCase();
    if (!symbol) {
      await send(chatId, "Kullanım: /rmpair BTCUSDT");
      return res.json({ ok: true });
    }

    const pairs = await removePair(symbol);
    await send(chatId, `🗑 Silindi: ${symbol}\nYeni Liste:\n${pairs.join("\n")}`);
    return res.json({ ok: true });
  }

  return res.json({ ok: true });
}

async function send(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" })
  });
}
