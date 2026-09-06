const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ===============================
// CONFIG
// ===============================

const WATCHED_WALLET =
  "GZetT3iRmhuzuT1gkSk69MXMe8hRJZJGz1PPdKW1J2vq";

const MIN_BUY_USD = 1000;

// Solana native mint
const SOL_MINT =
  "So11111111111111111111111111111111111111112";

// Common stablecoins
const STABLECOINS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4v8Xj9FJ8mHhM8FQh7w7", // USDT
]);

// Keep track of transactions we've already processed
const processedSignatures = new Set();

// ===============================
// HEALTH CHECK
// ===============================

app.get("/", (req, res) => {
  res.send("Smart Money Radar is running.");
});

// ===============================
// HELIUS WEBHOOK
// ===============================

app.post("/helius", async (req, res) => {
  try {
    const events = Array.isArray(req.body)
      ? req.body
      : [req.body];

    console.log(`Received ${events.length} Helius event(s)`);

    for (const event of events) {
      await processTransaction(event);
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("Webhook error:", error);
    res.status(500).send("ERROR");
  }
});

// ===============================
// PROCESS TRANSACTION
// ===============================

async function processTransaction(tx) {
  try {
    if (!tx) return;

    const signature = tx.signature;

    if (!signature) {
      console.log("Transaction has no signature.");
      return;
    }

    // Prevent duplicate alerts if Helius retries delivery
    if (processedSignatures.has(signature)) {
      console.log(`Already processed ${signature}`);
      return;
    }

    processedSignatures.add(signature);

    // Keep memory from growing forever
    if (processedSignatures.size > 5000) {
      const first = processedSignatures.values().next().value;
      processedSignatures.delete(first);
    }

    console.log("------------------------------------");
    console.log("Transaction:", signature);
    console.log("Type:", tx.type);
    console.log("Description:", tx.description || "N/A");

    // We only care about swaps
    if (tx.type !== "SWAP") {
      console.log("Not a SWAP. Ignoring.");
      return;
    }

    const tokenTransfers = Array.isArray(tx.tokenTransfers)
      ? tx.tokenTransfers
      : [];

    const nativeTransfers = Array.isArray(tx.nativeTransfers)
      ? tx.nativeTransfers
      : [];

    // ===============================
    // FIND TOKENS RECEIVED BY WALLET
    // ===============================

    const receivedTokens = tokenTransfers.filter((transfer) => {
      return (
        transfer.toUserAccount === WATCHED_WALLET &&
        transfer.mint &&
        Number(transfer.tokenAmount || 0) > 0
      );
    });

    if (receivedTokens.length === 0) {
      console.log("No token received by watched wallet.");
      return;
    }

    // ===============================
    // FIND TOKENS SENT BY WALLET
    // ===============================

    const sentTokens = tokenTransfers.filter((transfer) => {
      return (
        transfer.fromUserAccount === WATCHED_WALLET &&
        transfer.mint &&
        Number(transfer.tokenAmount || 0) > 0
      );
    });

    // ===============================
    // FIND SOL SPENT
    // ===============================

    let solSpent = 0;

    for (const transfer of nativeTransfers) {
      if (transfer.fromUserAccount === WATCHED_WALLET) {
        const solAmount =
          Number(transfer.amount || 0) / 1_000_000_000;

        solSpent += solAmount;
      }
    }

    // Remove tiny SOL amounts that are likely transaction fees
    if (solSpent < 0.0001) {
      solSpent = 0;
    }

    // ===============================
    // DETERMINE WHAT WAS SPENT
    // ===============================

    let spentUsd = 0;
    let spentDescription = "";

    // SOL spent
    if (solSpent > 0) {
      const solPrice = await getTokenPriceUsd(SOL_MINT);

      if (solPrice) {
        spentUsd += solSpent * solPrice;
        spentDescription = `${solSpent.toFixed(4)} SOL`;
      }
    }

    // Stablecoins spent
    for (const transfer of sentTokens) {
      if (STABLECOINS.has(transfer.mint)) {
        const amount = Number(transfer.tokenAmount || 0);

        if (amount > 0) {
          spentUsd += amount;

          if (spentDescription) {
            spentDescription += ` + $${amount.toFixed(2)}`;
          } else {
            spentDescription = `$${amount.toFixed(2)}`;
          }
        }
      }
    }

    // Other tokens spent
    for (const transfer of sentTokens) {
      if (
        !STABLECOINS.has(transfer.mint) &&
        transfer.mint !== SOL_MINT
      ) {
        const amount = Number(transfer.tokenAmount || 0);

        if (amount <= 0) continue;

        const price = await getTokenPriceUsd(transfer.mint);

        if (price) {
          spentUsd += amount * price;
        }
      }
    }

    console.log("Estimated spend:", spentUsd);

    // ===============================
    // $1,000 THRESHOLD
    // ===============================

    if (spentUsd < MIN_BUY_USD) {
      console.log(
        `Below $${MIN_BUY_USD} threshold. Ignoring.`
      );
      return;
    }

    // ===============================
    // IDENTIFY PURCHASED TOKEN
    // ===============================

    // Filter out common stablecoins/SOL.
    const purchasedTokens = receivedTokens.filter((token) => {
      return (
        token.mint !== SOL_MINT &&
        !STABLECOINS.has(token.mint)
      );
    });

    if (purchasedTokens.length === 0) {
      console.log("No obvious purchased token found.");
      return;
    }

    // Usually the first received non-stable token is the purchased token.
    const purchasedToken = purchasedTokens[0];

    const mint = purchasedToken.mint;
    const tokenAmount = Number(
      purchasedToken.tokenAmount || 0
    );

    // ===============================
    // TOKEN INFORMATION
    // ===============================

    const tokenInfo = await getTokenInfo(mint);

    const tokenSymbol =
      tokenInfo?.symbol || shortenAddress(mint);

    const tokenName =
      tokenInfo?.name || "Unknown Token";

    // ===============================
    // TELEGRAM ALERT
    // ===============================

    const message = `
🚨 <b>SMART MONEY BUY</b>

<b>Wallet:</b> ${shortenAddress(WATCHED_WALLET)}

<b>Token:</b> ${escapeHtml(tokenName)}
<b>Symbol:</b> $${escapeHtml(tokenSymbol)}

<b>Estimated Spend:</b> $${spentUsd.toLocaleString(
      undefined,
      {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      }
    )}

<b>Received:</b> ${formatNumber(tokenAmount)} ${escapeHtml(
      tokenSymbol
    )}

<b>Mint:</b>
<code>${mint}</code>

<b>Transaction:</b>
https://solscan.io/tx/${signature}
`;

    await sendTelegram(message);

    console.log("🚨 BUY ALERT SENT");
  } catch (error) {
    console.error("Transaction processing error:", error);
  }
}

// ===============================
// GET TOKEN USD PRICE
// ===============================

async function getTokenPriceUsd(mint) {
  try {
    const response = await fetch(
      `https://api.dexscreener.com/tokens/v1/solana/${mint}`
    );

    if (!response.ok) {
      return null;
    }

    const data = await response.json();

    if (!Array.isArray(data) || data.length === 0) {
      return null;
    }

    // Use the highest-liquidity pair
    const sorted = data
      .filter((pair) => pair.priceUsd)
      .sort((a, b) => {
        const liquidityA =
          Number(a.liquidity?.usd || 0);

        const liquidityB =
          Number(b.liquidity?.usd || 0);

        return liquidityB - liquidityA;
      });

    if (sorted.length === 0) {
      return null;
    }

    return Number(sorted[0].priceUsd);
  } catch (error) {
    console.error(
      "Price lookup error:",
      error.message
    );

    return null;
  }
}

// ===============================
// GET TOKEN INFO
// ===============================

async function getTokenInfo(mint) {
  try {
    const response = await fetch(
      `https://api.dexscreener.com/tokens/v1/solana/${mint}`
    );

    if (!response.ok) {
      return null;
    }

    const data = await response.json();

    if (!Array.isArray(data) || data.length === 0) {
      return null;
    }

    const pair = data
      .filter((item) => item.baseToken)
      .sort((a, b) => {
        const liquidityA =
          Number(a.liquidity?.usd || 0);

        const liquidityB =
          Number(b.liquidity?.usd || 0);

        return liquidityB - liquidityA;
      })[0];

    if (!pair || !pair.baseToken) {
      return null;
    }

    return {
      symbol: pair.baseToken.symbol,
      name: pair.baseToken.name,
    };
  } catch (error) {
    console.error(
      "Token info error:",
      error.message
    );

    return null;
  }
}

// ===============================
// TELEGRAM
// ===============================

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log(
      "Telegram credentials are not configured."
    );
    return;
  }

  const url =
    `https://api.telegram.org/bot${token}/sendMessage`;

  const response = await fetch(url, {
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

  const result = await response.json();

  if (!response.ok) {
    console.error(
      "Telegram error:",
      JSON.stringify(result)
    );
  } else {
    console.log("Telegram message sent.");
  }
}

// ===============================
// HELPERS
// ===============================

function shortenAddress(address) {
  if (!address) return "";

  return `${address.slice(0, 6)}...${address.slice(-6)}`;
}

function formatNumber(number) {
  if (!Number.isFinite(number)) {
    return "0";
  }

  return number.toLocaleString(undefined, {
    maximumFractionDigits: 6,
  });
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ===============================
// START SERVER
// ===============================

app.listen(PORT, () => {
  console.log(
    `Smart Money Radar running on port ${PORT}`
  );
});
