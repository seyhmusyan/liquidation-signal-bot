export async function sendTelegramMessage(text, overrideChat) {
  const token = process.env.TELEGRAM_TOKEN;
  const chat = overrideChat || process.env.TELEGRAM_CHAT;

  if (!token || !chat) return;

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML" })
  });
}
