export const config = { runtime: "nodejs" };

import { addPair, removePair, getActivePairs } from "../utils/pairsStore.js";
const TOKEN = process.env.TELEGRAM_TOKEN;

// === BASİT & SORUNSUZ TELEGRAM WEBHOOK HANDLER ===
export default async function handler(req, res) {
  const body = req.body;

  if (!body?.message) {
    return res.json({ ok: true });
  }

  const msg = body.message;
  const chatId = msg.chat.id;
  const text = msg.text?.trim() || "";

  // /pairs
  if (text === "/pairs") {
    const pairs = await getActivePairs();
    await send(chatId, "📊 Aktif Pariteler:\n" + pairs.map(p => `• ${p}`).join("\n"));
    return res.json({ ok: true });
  }

  // /addpair XXXUSDT
  if (text.startsWith("/addpair")) {
    const parts = text.split(" ");
    if (parts.length < 2) {
      await send(chatId, "Kullanım: /addpair BTCUSDT");
      return res.json({ ok: true });
    }
    const symbol = parts[1].toUpperCase();
    const pairs = await addPair(symbol);
    await send(chatId, `✅ Pair eklendi: ${symbol}\nYeni Liste:\n${pairs.join("\n")}`);
    return res.json({ ok: true });
  }

  // /rmpair XXXUSDT
  if (text.startsWith("/rmpair")) {
    const parts = text.split(" ");
    if (parts.length < 2) {
      await send(chatId, "Kullanım: /rmpair BTCUSDT");
      return res.json({ ok: true });
    }
    const symbol = parts[1].toUpperCase();
    const pairs = await removePair(symbol);
    await send(chatId, `🗑 Silindi: ${symbol}\nYeni Liste:\n${pairs.join("\n")}`);
    return res.json({ ok: true });
  }

  // default response
  await send(chatId, "Komut tanınmadı. Kullanılabilir komutlar:\n/pairs\n/addpair BTCUSDT\n/rmpair BTCUSDT");

  return res.json({ ok: true });
}

async function send(chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML"
      })
    });
  } catch (e) {
    console.error("Telegram send error", e);
  }
}
