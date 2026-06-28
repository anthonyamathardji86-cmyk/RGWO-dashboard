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
            res.cookie('rgwo_user', userData.id, { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true, secure: process.env.NODE_ENV === 'production' });
            const telegramName = `${userData.first_name || ''} ${userData.last_name || ''}`.trim();

            const { error: dbError } = await supabase.from('RGWO leden').upsert({ 
                telegram_id: parseInt(userData.id), 
                telegram_username: userData.username || null, 
                telegram_naam: telegramName 
            }, { onConflict: 'telegram_id' });

            if (dbError) console.error("[SUPABASE ERROR DETAILS]:", dbError.message);
            else console.log("[SUCCESS] User saved to database!");

            res.json({ success: true, user: userData });
        } else {
            res.status(403).json({ success: false, message: 'Je bent geen lid van de RGWO Telegram groep.' });
        }
    } catch (error) {
        console.error("[AUTH ERROR]:", error.message);
        res.status(500).json({ success: false });
    }
});

app.get('/api/me', async (req, res) => {
    const userId = req.cookies.rgwo_user;
    if (!userId) return res.status(401).json({ loggedIn: false });

    try {
        const groupId = process.env.RGWO_GROUP_ID;
        const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getChatMember?chat_id=${groupId}&user_id=${userId}`;
        const response = await fetch(url);
        const data = await response.json();

        if (['member', 'administrator', 'creator'].includes(data.result?.status)) {
            const { data: member } = await supabase.from('RGWO leden').select('naam, telegram_naam, badge').eq('telegram_id', parseInt(userId)).single();
            if (member && member.badge) return res.json({ loggedIn: true, needsSetup: false, name: member.naam, badge: member.badge });
            else return res.json({ loggedIn: true, needsSetup: true, firstName: member?.telegram_naam || '' });
        } else {
            res.clearCookie('rgwo_user');
            return res.status(401).json({ loggedIn: false });
        }
    } catch (error) {
        console.error("[ERROR]:", error.message);
        return res.json({ loggedIn: true }); 
    }
});

app.post('/api/profile', async (req, res) => {
    const userId = req.cookies.rgwo_user;
    if (!userId) return res.status(401).json({ success: false });

    const { naam, badge, afdeling } = req.body;
    if (!naam || !badge || !afdeling) return res.status(400).json({ success: false, message: 'Missing info' });

    const { error } = await supabase.from('RGWO leden').update({ naam, badge, afdeling }).eq('telegram_id', parseInt(userId));
    if (error) { console.error("[DB ERROR]:", error.message); return res.status(500).json({ success: false }); }
    res.json({ success: true });
});

app.post('/api/logout', (req, res) => {
    res.clearCookie('rgwo_user');
    res.json({ success: true });
});

// ==========================
// 5. LOAN REQUEST (SINGLE PENDING LIMIT)
// ==========================
app.post('/api/loan', async (req, res) => {
    try {
        const { name, badge, afdeling, telefoon, reason, amount, term } = req.body;
        if (!name || !reason || !amount) return res.status(400).json({ success: false, message: 'Missing fields' });

        const userId = req.cookies.rgwo_user;

        // --- CHECK FOR EXISTING PENDING LOAN ---
        const { data: pendingLoan } = await supabase
            .from('Leningen')
            .select('loan_id')
            .eq('telegram_id', parseInt(userId))
            .eq('status', 'pending')
            .single();

        if (pendingLoan) {
            // Block the request and send custom error message
            return res.status(400).json({ 
                success: false, 
                message: `U heeft al een openstaande aanvraag (${pendingLoan.loan_id}). Wacht tot deze is goedgekeurd of afgewezen.` 
            });
        }
        // ----------------------------------------

        // --- GENERATE SEQUENTIAL ID ---
        const { count } = await supabase
            .from('Leningen')
            .select('*', { count: 'exact', head: true });
            
        const nextNumber = (count || 0) + 1;
        const loanId = `LOAN_${String(nextNumber).padStart(5, '0')}`;
        // -------------------------------

        // 1. Save to Leningen table
        await supabase.from('Leningen').insert({ 
            loan_id: loanId, 
            telegram_id: parseInt(userId), 
            naam: name, 
            bedrag: parseInt(amount), 
            status: 'pending' 
        });

        // 2. Create Approve/Reject Buttons
        const keyboard = {
            inline_keyboard: [
                [
                    { text: "✅ Goedkeuren", callback_data: `approve_${loanId}` },
                    { text: "❌ Afwijzen", callback_data: `reject_${loanId}` }
                ]
            ]
        };

        const message = `
<b>🛡️ NIEUWE LENINGAANVRAAG RGWO 🛡️</b>
<b>ID:</b> <code>${loanId}</code>

<b>👤 Aangevraagd door:</b>
• <b>${name}</b> (Badge: ${badge || 'Onbekend'})
• Telefoon: ${telefoon || 'Onbekend'}
• Afdeling: ${afdeling || 'Onbekend'}

<b>💰 Lening Details:</b>
• Doel: ${reason}
• Bedrag: <b>SRD ${amount}</b>
• Termijn: ${term} maanden
        `.trim();

        // 3. Send to Admin with buttons
        const sendPromises = CHAT_IDS.map(chatId => {
            const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
            return fetch(url, { 
                method: 'POST', 
                headers: { 'Content-Type': 'application/json' }, 
                body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML', reply_markup: keyboard }) 
            });
        });

        await Promise.all(sendPromises);
        console.log(`[SUCCESS] Loan ${loanId} from ${name} sent to Telegram.`);
        res.json({ success: true });
    } catch (error) {
        console.error("[TELEGRAM ERROR]:", error.message);
        res.status(500).json({ success: false });
    }
});

// ==========================
// 6. WEBHOOK FOR APPROVAL BUTTONS
// ==========================
app.post('/api/webhook', async (req, res) => {
    const callbackQuery = req.body.callback_query;
    
    if (!callbackQuery) return res.sendStatus(200);

    const data = callbackQuery.data; 
    const action = data.split('_')[0]; 
    const loanId = data.substring(action.length + 1); 
    
    const adminChatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;

    try {
        const { data: loan } = await supabase.from('Leningen').select('*').eq('loan_id', loanId).single();
        
        if (!loan) {
            await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery?callback_query_id=${callbackQuery.id}&text=Lening niet gevonden!&show_alert=true`);
            return res.sendStatus(200);
        }

        const newStatus = action === 'approve' ? 'approved' : 'rejected';
        
        await supabase.from('Leningen').update({ status: newStatus }).eq('loan_id', loanId);

        const statusText = action === 'approve' ? '✅ GOEDGEKEURD' : '❌ AFGEWEEZEN';
        const newKeyboard = {
            inline_keyboard: [[ { text: statusText, callback_data: "noop" } ]]
        };
        
        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageReplyMarkup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: adminChatId, message_id: messageId, reply_markup: newKeyboard })
        });

        let userMessage = "";
        if (action === 'approve') {
            userMessage = `🎉 <b>Goed nieuws!</b>\n\nUw leningaanvraag (${loanId}) van <b>SRD ${loan.bedrag}</b> is goedgekeurd door de penningmeester. Neem contact op voor de volgende stappen.`;
        } else {
            userMessage = `❌ <b>Bericht van RGWO</b>\n\nHelaas is uw leningaanvraag (${loanId}) van <b>SRD ${loan.bedrag}</b> afgewezen. Neem contact op met het bestuur voor meer informatie.`;
        }

        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: loan.telegram_id, text: userMessage, parse_mode: 'HTML' })
        });

        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery?callback_query_id=${callbackQuery.id}&text=Verwerkt!`);

    } catch (error) {
        console.error("[WEBHOOK ERROR]:", error);
    }

    res.sendStatus(200);
});

// ==========================
// 7. START SERVER
// ==========================
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
