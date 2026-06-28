require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const TelegramLogin = require('express-telegram-login');
const cookieParser = require('cookie-parser');

const app = express();

// ==========================
// 1. CONFIGURATION
// ==========================
const PORT = process.env.PORT || 3000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_IDS = (process.env.TELEGRAM_CHAT_ID || '').split(',').map(id => id.trim());

// Setup Telegram Login Validator
const telegramLogin = new TelegramLogin({
    botToken: TELEGRAM_TOKEN
});

// ==========================
// 2. MIDDLEWARE
// ==========================
app.set('trust proxy', 1);
app.use(express.static(path.join(__dirname, 'public')));
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(cookieParser(process.env.COOKIE_SECRET || 'fallback_secret'));

// ==========================
// 3. AUTHENTICATION API
// ==========================
app.post('/api/auth', telegramLogin.validate, async (req, res) => {
    try {
        const userId = req.user.id;
        const groupId = process.env.RGWO_GROUP_ID;

        // Ask Telegram: Is this user in our specific group?
        const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getChatMember?chat_id=${groupId}&user_id=${userId}`;
        const response = await fetch(url);
        const data = await response.json();

        // Check if status is member, admin, or owner
        if (['member', 'administrator', 'creator'].includes(data.result.status)) {
            // SUCCESS! Give them a logged-in cookie for 30 days
            res.cookie('rgwo_user', userId, { 
                maxAge: 30 * 24 * 60 * 60 * 1000, 
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production' // Secure only on Render (HTTPS)
            });
            res.json({ success: true, user: req.user });
        } else {
            // FAIL: They logged in via Telegram, but aren't in the group
            res.status(403).json({ success: false, message: 'Je bent geen lid van de RGWO groep.' });
        }
    } catch (error) {
        console.error("[AUTH ERROR]:", error.message);
        res.status(500).json({ success: false });
    }
});

// Route to check if they are already logged in when they open the site
app.get('/api/me', (req, res) => {
    if (req.cookies.rgwo_user) {
        res.json({ loggedIn: true });
    } else {
        res.status(401).json({ loggedIn: false });
    }
});

// Logout route
app.post('/api/logout', (req, res) => {
    res.clearCookie('rgwo_user');
    res.json({ success: true });
});

// ==========================
// 4. API: LOAN REQUEST TO TELEGRAM
// ==========================
app.post('/api/loan', async (req, res) => {
    try {
        const { name, department, badge, reason, amount, term } = req.body;

        if (!name || !badge || !amount) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

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

        const sendPromises = CHAT_IDS.map(chatId => {
            const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
            return fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' })
            });
        });

        await Promise.all(sendPromises);
        console.log(`[SUCCESS] Loan request from ${name} sent to Telegram.`);
        res.json({ success: true });

    } catch (error) {
        console.error("[TELEGRAM ERROR]:", error.message);
        res.status(500).json({ success: false });
    }
});

// ==========================
// 5. START SERVER
// ==========================
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
