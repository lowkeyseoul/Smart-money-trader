const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Wallet we're monitoring
const WATCHED_WALLET =
  "GZetT3iRmhuzuT1gkSk69MXMe8hRJZJGz1PPdKW1J2vq";

// Minimum USD value for an alert
const MIN_BUY_USD = 1000;

// Simple health check
app.get("/", (req, res) => {
  res.send("Smart Money Radar is running.");
});

// Helius webhook endpoint
app.post("/helius", async (req, res) => {
  try {
    const events = Array.isArray(req.body) ? req.body : [req.body];

    for (const event of events) {
      await processTransaction(event);
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("Webhook error:", error);
    res.status(500).send("ERROR");
  }
});

async function processTransaction(tx) {
  console.log("Transaction received:");
  console.log(JSON.stringify(tx, null, 2));

  // We will add the actual BUY detection here
  // after Helius is connected and we can see
  // exactly what data it sends for this wallet.
}

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log("Telegram credentials not configured yet.");
    return;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
}

app.listen(PORT, () => {
  console.log(`Smart Money Radar running on port ${PORT}`);
});
