require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto'); 
const cookieParser = require('cookie-parser');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// ==========================
// 1. CONFIGURATION & DATABASE
// ==========================
const PORT = process.env.PORT || 3000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_IDS = (process.env.TELEGRAM_CHAT_ID || '').split(',').map(id => id.trim());

// Connect to Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

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
    const dataCheckString = Object.keys(userData).filter(key => key !== 'hash').sort().map(key => `${key}=${userData[key]}`).join('\n');
    const secretKey = crypto.createHash('sha256').update(TELEGRAM_TOKEN).digest();
    const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (hash !== checkHash) return false;
    const authDate = parseInt(userData.auth_date);
    const currentTime = Math.floor(Date.now() / 1000);
    if (currentTime - authDate > 300) return false;
    return true;
}

// ==========================
// 4. AUTHENTICATION & PROFILE API
// ==========================
app.post('/api/auth', async (req, res) => {
    try {
        const userData = req.body;
        if (!validateTelegramLogin(userData)) return res.status(403).json({ success: false, message: 'Ongeldig inlogpoging.' });

        const groupId = process.env.RGWO_GROUP_ID;
        const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getChatMember?chat_id=${groupId}&user_id=${userData.id}`;
        
        const response = await fetch(url);
        const data = await response.json();

        if (['member', 'administrator', 'creator'].includes(data.result?.status)) {
            // Give Cookie
            res.cookie('rgwo_user', userData.id, { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true, secure: process.env.NODE_ENV === 'production' });
            
            // Combine first and last name to match your 'naam' column
            const fullName = `${userData.first_name || ''} ${userData.last_name || ''}`.trim();

            // AUTO-SAVE: Save to DB using your exact column names
            const { error: dbError } = await supabase.from('RGWO leden').upsert({ 
                telegram_id: parseInt(userData.id), 
                telegram_username: userData.username || null, 
                naam: fullName
            }, { onConflict: 'telegram_id' });

            // LOGGING TO FIND THE EXACT ERROR
            if (dbError) {
                console.error("[SUPABASE ERROR DETAILS]:", dbError.message, dbError.details);
            } else {
                console.log("[SUCCESS] User saved to database!");
            }

            res.json({ success: true, user: userData });
        } else {
            res.status(403).json({ success: false, message: 'Je bent geen lid van de RGWO Telegram groep.' });
        }
    } catch (error) {
        console.error("[AUTH ERROR]:", error.message);
        res.status(500).json({ success: false });
    }
});

// Check session, active group membership, and profile status
app.get('/api/me', async (req, res) => {
    const userId = req.cookies.rgwo_user;
    if (!userId) return res.status(401).json({ loggedIn: false });

    try {
        const groupId = process.env.RGWO_GROUP_ID;
        const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getChatMember?chat_id=${groupId}&user_id=${userId}`;
        const response = await fetch(url);
        const data = await response.json();

        if (['member', 'administrator', 'creator'].includes(data.result?.status)) {
            // Check database for profile using 'naam' column
            const { data: member } = await supabase
                .from('RGWO leden')
                .select('naam, badge')
                .eq('telegram_id', parseInt(userId))
                .single();

            if (member && member.badge) {
                // Profile complete!
                return res.json({ loggedIn: true, needsSetup: false, name: member.naam, badge: member.badge });
            } else {
                // Missing Badge/Afdeling
                return res.json({ loggedIn: true, needsSetup: true, firstName: member?.naam || '' });
            }
        } else {
            res.clearCookie('rgwo_user');
            return res.status(401).json({ loggedIn: false });
        }
    } catch (error) {
        console.error("[ERROR]:", error.message);
        return res.json({ loggedIn: true }); 
    }
});

// Save Badge and Afdeling
app.post('/api/profile', async (req, res) => {
    const userId = req.cookies.rgwo_user;
    if (!userId) return res.status(401).json({ success: false });

    const { badge, afdeling } = req.body;
    if (!badge || !afdeling) return res.status(400).json({ success: false, message: 'Missing info' });

    const { error } = await supabase
        .from('RGWO leden')
        .update({ badge, afdeling })
        .eq('telegram_id', parseInt(userId));

    if (error) {
        console.error("[DB ERROR]:", error.message);
        return res.status(500).json({ success: false });
    }

    res.json({ success: true });
});

app.post('/api/logout', (req, res) => {
    res.clearCookie('rgwo_user');
    res.json({ success: true });
});

// ==========================
// 5. API: LOAN REQUEST TO TELEGRAM
// ==========================
app.post('/api/loan', async (req, res) => {
    try {
        const userId = req.cookies.rgwo_user;
        
        // Fetch identity from Database using 'naam' column
        const { data: member } = await supabase
            .from('RGWO leden')
            .select('naam, telegram_username, badge, afdeling')
            .eq('telegram_id', parseInt(userId))
            .single();

        const { reason, amount, term } = req.body;
        if (!reason || !amount) return res.status(400).json({ success: false, message: 'Missing fields' });

        // Formatting for Treasurer
        const fullName = member ? member.naam : 'Onbekend Lid';
        const tgTag = member?.telegram_username ? `@${member.telegram_username}` : 'Onbekend';
        const phoneNum = 'Niet in DB'; 
        const dept = member?.afdeling || 'Onbekend';
        const badgeNum = member?.badge || 'Onbekend';

        const message = `
<b>🛡️ NIEUWE LENINGAANVRAAG RGWO 🛡️</b>

<b>👤 Aangevraagd door:</b>
• <b>${fullName}</b> (Badge: ${badgeNum})
• Telegram: <i>${tgTag}</i>
• Telefoon: ${phoneNum}
• Afdeling: ${dept}

<b>💰 Lening Details:</b>
• Doel: ${reason}
• Bedrag: <b>SRD ${amount}</b>
• Termijn: ${term} maanden
        `.trim();

        const sendPromises = CHAT_IDS.map(chatId => {
            const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
            return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }) });
        });

        await Promise.all(sendPromises);
        console.log(`[SUCCESS] Loan from ${fullName} sent to Telegram.`);
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
