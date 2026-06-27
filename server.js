require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();

// ==========================
// 1. CONFIGURATION
// ==========================
const PORT = process.env.PORT || 3000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_IDS = process.env.TELEGRAM_CHAT_ID.split(',').map(id => id.trim());

console.log(`[INFO] Server running at: http://localhost:${PORT}`);

// ==========================
// 2. MIDDLEWARE
// ==========================
app.set('trust proxy', 1);

// Serve your HTML file from the 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

app.use(cors({ origin: '*' }));
app.use(express.json()); // Parses the loan form data

// ==========================
// 3. API: LOAN REQUEST TO TELEGRAM
// ==========================
app.post('/api/loan', async (req, res) => {
    try {
        const { name, department, badge, reason, amount, term } = req.body;

        // Basic validation to ensure fields aren't empty
        if (!name || !badge || !amount) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        // Format the message for Telegram using HTML tags for bold/text
        const message = `
<b>🛡️ NIEUWE LENINGAANVRAAG RGWO 🛡️</b>

<b>👤 Gebruiker Info:</b>
• Naam: <code>${name}</code>
• Badge: <code>${badge}</code>
• Afdeling: ${department}

<b>💰 Lening Details:</b>
• Doel: ${reason}
• Bedrag: <b>SRD ${amount}</b>
• Termijn: ${term} maanden
        `.trim();

        // Send the message to all Chat IDs listed in .env
        const sendPromises = CHAT_IDS.map(chatId => {
            const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
            
            return fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: message,
                    parse_mode: 'HTML'
                })
            });
        });

        // Wait for all Telegram messages to finish sending
        await Promise.all(sendPromises);

        console.log(`[SUCCESS] Loan request from ${name} sent to Telegram.`);
        
        // Tell the frontend it was successful
        res.json({ success: true });

    } catch (error) {
        console.error("[TELEGRAM ERROR]:", error.message);
        res.status(500).json({ success: false });
    }
});

// ==========================
// 4. START SERVER
// ==========================
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
