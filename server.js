require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto'); 
const cookieParser = require('cookie-parser');

const app = express();

// ==========================
// 1. CONFIGURATION & DATABASE
// ==========================
const PORT = process.env.PORT || 3000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_IDS = (process.env.TELEGRAM_CHAT_ID || '').split(',').map(id => id.trim());

// PostgreSQL database connectie voor Supabase
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Verplicht voor beveiligde verbinding met Supabase
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
// 3. CUSTOM TELEGRAM VALIDATION
// ==========================
function validateTelegramLogin(userData) {
    const checkHash = userData.hash;
    if (!checkHash) return false;

    const dataCheckString = Object.keys(userData)
        .filter(key => key !== 'hash')
        .sort()
        .map(key => `${key}=${userData[key]}`)
        .join('\n');

    const secretKey = crypto.createHash('sha256').update(TELEGRAM_TOKEN).digest();
    const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (hash !== checkHash) return false;

    const authDate = parseInt(userData.auth_date);
    const currentTime = Math.floor(Date.now() / 1000);
    if (currentTime - authDate > 300) return false; // Verloopt na 5 minuten

    return true;
}

// ==========================
// 4. AUTHENTICATION API (Met check op tabel: "RGWO leden")
// ==========================
app.post('/api/auth', (req, res) => {
    try {
        const userData = req.body;

        if (!validateTelegramLogin(userData)) {
            return res.status(403).json({ success: false, message: 'Ongeldige inlogpoging.' });
        }

        const groupId = process.env.RGWO_GROUP_ID;
        const url = `https://telegram.org{TELEGRAM_TOKEN}/getChatMember?chat_id=${groupId}&user_id=${userData.id}`;
        
        fetch(url)
            .then(response => response.json())
            .then(async (data) => {
                if (['member', 'administrator', 'creator'].includes(data.result?.status)) {
                    
                    // Kijken of dit Telegram ID al bestaat in de tabel "RGWO leden"
                    const userCheck = await pool.query('SELECT naam FROM "RGWO leden" WHERE telegram_id = $1', [userData.id.toString()]);
                    
                    let needsOnboarding = true;
                    if (userCheck.rows.length > 0) {
                        // Gebruiker bestaat; controleren of ze hun echte naam al hebben ingevuld
                        if (userCheck.rows[0].naam) {
                            needsOnboarding = false;
                        }
                    } else {
                        // Gloednieuwe gebruiker: Voeg het basis Telegram ID en de username alvast toe
                        await pool.query(
                            'INSERT INTO "RGWO leden" (telegram_id, telegram_username) VALUES ($1, $2) ON CONFLICT (telegram_id) DO NOTHING',
                            [userData.id.toString(), userData.username || null]
                        );
                    }

                    // Sessie cookie aanmaken
                    res.cookie('rgwo_user', userData.id, { 
                        maxAge: 30 * 24 * 60 * 60 * 1000, 
                        httpOnly: true,
                        secure: process.env.NODE_ENV === 'production'
                    });

                    res.json({ 
                        success: true, 
                        user: userData,
                        needsOnboarding: needsOnboarding 
                    });
                } else {
                    res.status(403).json({ success: false, message: 'Je bent geen lid van de RGWO Telegram groep.' });
                }
            })
            .catch((err) => {
                console.error(err);
                res.status(500).json({ success: false, message: 'Fout bij het controleren van de groep.' });
            });

    } catch (error) {
        console.error("[AUTH ERROR]:", error.message);
        res.status(500).json({ success: false });
    }
});

// Endpoint om de echte naam, badge en afdeling op te slaan bij eerste keer inloggen
app.post('/api/profile/setup', async (req, res) => {
    const userId = req.cookies.rgwo_user;
    if (!userId) return res.status(401).json({ success: false, message: 'Niet ingelogd' });

    const { naam, badge, afdeling } = req.body;
    if (!naam || !badge || !afdeling) {
        return res.status(400).json({ success: false, message: 'Alle velden zijn verplicht' });
    }

    try {
        await pool.query(
            'UPDATE "RGWO leden" SET naam = $1, badge = $2, afdeling = $3 WHERE telegram_id = $4',
            [naam.trim(), badge.trim(), afdeling.trim(), userId.toString()]
        );
        return res.json({ success: true });
    } catch (error) {
        console.error("[DB UPDATE ERROR]:", error.message);
        return res.status(500).json({ success: false, message: 'Fout bij opslaan in database.' });
    }
});

// ACTIVE CHECK: Schopt gebruikers eruit als ze uit de Telegram groep worden gehaald
app.get('/api/me', async (req, res) => {
    const userId = req.cookies.rgwo_user;
    if (!userId) return res.status(401).json({ loggedIn: false });

    try {
        const groupId = process.env.RGWO_GROUP_ID;
        const url = `https://telegram.org{TELEGRAM_TOKEN}/getChatMember?chat_id=${groupId}&user_id=${userId}`;
        
        const response = await fetch(url);
        const data = await response.json();

        if (['member', 'administrator', 'creator'].includes(data.result?.status)) {
            // Controleren of de gebruiker de onboarding al heeft voltooid
            const userCheck = await pool.query('SELECT naam FROM "RGWO leden" WHERE telegram_id = $1', [userId.toString()]);
            const needsOnboarding = userCheck.rows.length > 0 ? !userCheck.rows[0].naam : true;
            
            return res.json({ loggedIn: true, needsOnboarding: needsOnboarding });
        } else {
            res.clearCookie('rgwo_user');
            return res.status(401).json({ loggedIn: false });
        }
    } catch (error) {
        console.error("[GROUP CHECK ERROR]:", error.message);
        return res.json({ loggedIn: true, needsOnboarding: false }); 
    }
});

// Beveiligd overzicht voor het administratie-paneel (haalt alle "RGWO leden" op)
app.get('/api/admin/members', async (req, res) => {
    const userId = req.cookies.rgwo_user;
    if (!userId) return res.status(401).json({ success: false, message: 'Niet ingelogd' });

    try {
        const groupId = process.env.RGWO_GROUP_ID;
        const url = `https://telegram.org{TELEGRAM_TOKEN}/getChatMember?chat_id=${groupId}&user_id=${userId}`;
        const tgResponse = await fetch(url);
        const tgData = await tgResponse.json();

        if (!['member', 'administrator', 'creator'].includes(tgData.result?.status)) {
            res.clearCookie('rgwo_user');
            return res.status(403).json({ success: false, message: 'Geen toegang.' });
        }

        const result = await pool.query(
            'SELECT telegram_id, telegram_username, naam, badge, afdeling FROM "RGWO leden"'
        );
        res.json({ success: true, members: result.rows });

    } catch (error) {
        console.error("[ADMIN FETCH ERROR]:", error.message);
        res.status(500).json({ success: false, message: 'Fout bij ophalen van ledenlijst.' });
    }
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
            const url = `https://telegram.org{TELEGRAM_TOKEN}/sendMessage`;
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
