export async function sendTelegramMessage(text, chatIdOverride) {
  const token = process.env.TELEGRAM_TOKEN;
  const defaultChat = process.env.TELEGRAM_CHAT;

  if (!token) {
    console.log("TELEGRAM_TOKEN missing");
    return;
  }
  const chatId = chatIdOverride || defaultChat;
  if (!chatId) {
    console.log("TELEGRAM_CHAT missing");
    return;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: false
      })
    });
  } catch (e) {
    console.error("Telegram send error", e);
  }
}
