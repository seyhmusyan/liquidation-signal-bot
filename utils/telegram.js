export async function sendTelegramMessage(text, overrideChat) {
  const token = process.env.TELEGRAM_TOKEN;
  const chatId = overrideChat || process.env.TELEGRAM_CHAT;
  if (!token || !chatId) return;

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" })
  });
}
