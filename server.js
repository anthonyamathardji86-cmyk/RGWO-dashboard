require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto'); // Built-in Node.js module
const cookieParser = require('cookie-parser');

const app = express();

// ==========================
// 1. CONFIGURATION
// ==========================
const PORT = process.env.PORT || 3000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_IDS = (process.env.TELEGRAM_CHAT_ID || '').split(',').map(id => id.trim());

// ==========================
// 2. MIDDLEWARE
// ==========================
app.set('trust proxy', 1);
app.use(express.static(path.join(__dirname, 'public')));
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(cookieParser(process.env.COOKIE_SECRET || 'fallback_secret'));

// ==========================
// 3. CUSTOM TELEGRAM VALIDATION (No external library needed)
// ==========================
function validateTelegramLogin(userData) {
    const checkHash = userData.hash;
    if (!checkHash) return false;

    // Create the data-check-string
    const dataCheckString = Object.keys(userData)
        .filter(key => key !== 'hash')
        .sort()
        .map(key => `${key}=${userData[key]}`)
        .join('\n');

    // Create the secret key using SHA256 of the Bot Token
    const secretKey = crypto.createHash('sha256').update(TELEGRAM_TOKEN).digest();
    
    // Calculate the HMAC-SHA256 signature of the data-check-string
    const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    // Compare the calculated hash with the received hash
    if (hash !== checkHash) return false;

    // Optional: Ensure the login wasn't done more than 5 minutes ago
    const authDate = parseInt(userData.auth_date);
    const currentTime = Math.floor(Date.now() / 1000);
    if (currentTime - authDate > 300) return false;

    return true;
}

// ==========================
// 4. AUTHENTICATION API
// ==========================
app.post('/api/auth', (req, res) => {
    try {
        const userData = req.body;

        // 1. Verify the cryptographic hash (Is this REALLY from Telegram?)
        if (!validateTelegramLogin(userData)) {
            return res.status(403).json({ success: false, message: 'Ongeldig inlogpoging.' });
        }

        // 2. Check if user is in the RGWO Telegram Group
        const groupId = process.env.RGWO_GROUP_ID;
        const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getChatMember?chat_id=${groupId}&user_id=${userData.id}`;
        
        // We use fetch here (Node 18+ built-in)
        fetch(url)
            .then(response => response.json())
            .then(data => {
                if (['member', 'administrator', 'creator'].includes(data.result?.status)) {
                    // SUCCESS: Give them a cookie valid for 30 days
                    res.cookie('rgwo_user', userData.id, { 
                        maxAge: 30 * 24 * 60 * 60 * 1000, 
                        httpOnly: true,
                        secure: process.env.NODE_ENV === 'production'
                    });
                    res.json({ success: true, user: userData });
                } else {
                    // FAIL: Valid Telegram user, but NOT in your group
                    res.status(403).json({ success: false, message: 'Je bent geen lid van de RGWO Telegram groep.' });
                }
            })
            .catch(() => {
                res.status(500).json({ success: false, message: 'Fout bij het controleren van de groep.' });
            });

    } catch (error) {
        console.error("[AUTH ERROR]:", error.message);
        res.status(500).json({ success: false });
    }
});

// Check if user is already logged in
app.get('/api/me', (req, res) => {
    if (req.cookies.rgwo_user) return res.json({ loggedIn: true });
    res.status(401).json({ loggedIn: false });
});

// Logout
app.post('/api/logout', (req, res) => {
    res.clearCookie('rgwo_user');
    res.json({ success: true });
});

// ==========================
// 5. API: LOAN REQUEST TO TELEGRAM
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
// 6. START SERVER
// ==========================
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
