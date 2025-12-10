export const config = { runtime: "nodejs" };

import { addPair, removePair, getActivePairs, toCoinglassSymbol } from "../utils/pairsStore.js";
import { loadConfig, saveConfig } from "../utils/configStore.js";
import { isAdmin } from "../utils/admins.js";
import { generateMMReport } from "../utils/mmreport.js";

const TOKEN = process.env.TELEGRAM_TOKEN;

export default async function handler(req, res) {
  const body = req.body;

  if (!body?.message) return res.json({ ok: true });

  const chatId = body.message.chat.id;
  const userId = body.message.from.id;
  const text = body.message.text?.trim() || "";

  // Komut: /pairs
  if (text === "/pairs") {
    const pairs = await getActivePairs();
    const msg = "📊 Aktif Pariteler:\n" + pairs.map(p => `• ${p}`).join("\n");
    await send(chatId, msg);
    return res.json({ ok: true });
  }

  // 🔒 Admin olmayanı engelle
  if (!isAdmin(userId)) {
    await send(chatId, "⛔ Bu komutu kullanma yetkin yok.");
    return res.json({ ok: true });
  }

  // ==============================
  // ➕ PAIR EKLE
  // ==============================
  if (text.startsWith("/addpair")) {
    const parts = text.split(" ");
    if (parts.length < 2) {
      await send(chatId, "Kullanım: /addpair BTCUSDT");
      return res.json({ ok: true });
    }

    const symbol = parts[1].toUpperCase();
    const pairs = await addPair(symbol);

    await send(chatId, `✅ Pair eklendi: ${symbol}\n\nYeni Liste:\n${pairs.join("\n")}`);
    return res.json({ ok: true });
  }

  // ==============================
  // ➖ PAIR SİL
  // ==============================
  if (text.startsWith("/rmpair")) {
    const parts = text.split(" ");
    if (parts.length < 2) {
      await send(chatId, "Kullanım: /rmpair BTCUSDT");
      return res.json({ ok: true });
    }

    const symbol = parts[1].toUpperCase();
    const pairs = await removePair(symbol);

    await send(chatId, `🗑 Pair silindi: ${symbol}\n\nYeni Liste:\n${pairs.join("\n")}`);
    return res.json({ ok: true });
  }

  // ==============================
  // 🔥 MODE AYARLARI
  // ==============================
  if (text === "/mode scalp") {
    const config = loadConfig();
    config.mode = "SCALP";
    saveConfig(config);
    await send(chatId, "⚡ Bot modu SCALP olarak ayarlandı (daha agresif).");
    return res.json({ ok: true });
  }

  if (text === "/mode swing") {
    const config = loadConfig();
    config.mode = "SWING";
    saveConfig(config);
    await send(chatId, "🌙 Bot modu SWING olarak ayarlandı (daha sakin).");
    return res.json({ ok: true });
  }

  // ==============================
  // 🔥 MM RAPOR
  // ==============================
  if (text === "/mmreport") {
    const report = await generateMMReport();
    await send(chatId, report);
    return res.json({ ok: true });
  }

  return res.json({ ok: true });
}

async function send(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML"
    })
  });
}
