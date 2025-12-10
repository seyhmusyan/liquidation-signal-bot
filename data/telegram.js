export async function sendTelegramMessage(text, overrideChatId) {
  const token = process.env.TELEGRAM_TOKEN;
  const chatId = overrideChatId || process.env.TELEGRAM_CHAT;

  if (!token || !chatId) {
    console.log("Telegram env missing");
    return;
  }

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
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
