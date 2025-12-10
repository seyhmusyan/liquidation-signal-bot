const TOKEN = process.env.TELEGRAM_TOKEN;
const DEFAULT_CHAT = process.env.TELEGRAM_CHAT;

export async function sendTelegramMessage(text, chatId) {
  const target = chatId || DEFAULT_CHAT;
  if (!TOKEN || !target) return;

  await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: target,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: false
    })
  });
}