require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// ==========================
// 1. CONFIGURATION & DATABASE
// ==========================
const PORT = process.env.PORT || 3000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_IDS = (process.env.TELEGRAM_CHAT_ID || '').split(',').map(id => id.trim());
const DOMAIN = process.env.DOMAIN || 'www.rgwo.org';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ==========================
// 2. MIDDLEWARE
// ==========================
app.set('trust proxy', 1);
app.use(express.static(path.join(__dirname, 'public')));
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(cookieParser(process.env.COOKIE_SECRET || 'fallback_secret_change_this'));

// Multer setup for file uploads (stores file in memory temporarily)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB max
});

// ==========================
// 3. TELEGRAM WEBHOOK REGISTRATION
// ==========================
async function registerWebhook() {
    if (process.env.NODE_ENV === 'production' && TELEGRAM_TOKEN) {
        const webhookUrl = `https://${DOMAIN}/api/webhook`;
        console.log(`🔗 Registering Webhook: ${webhookUrl}`);

        try {
            const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook?url=${webhookUrl}`);
            const data = await response.json();
            if (data.ok) {
                console.log('✅ Webhook registered successfully!');
            } else {
                console.error('❌ Webhook registration failed:', data.description);
            }
        } catch (error) {
            console.error('❌ Error setting webhook:', error.message);
        }
    }
}

// ==========================
// 4. CUSTOM TELEGRAM VALIDATION
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
    if (currentTime - authDate > 86400) return false;
    return true;
}

// ==========================
// 5. AUTHENTICATION & PROFILE API
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
            const cookieOptions = {
                maxAge: 30 * 24 * 60 * 60 * 1000,
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'lax'
            };

            res.cookie('rgwo_user', userData.id, cookieOptions);
            const telegramName = `${userData.first_name || ''} ${userData.last_name || ''}`.trim();

            const { error: dbError } = await supabase.from('RGWO leden').upsert({
                telegram_id: parseInt(userData.id),
                telegram_username: userData.username || null,
                telegram_naam: telegramName
            }, { onConflict: 'telegram_id' });

            if (dbError) console.error("[SUPABASE ERROR DETAILS]:", dbError.message);

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
            const { data: member } = await supabase.from('RGWO leden').select('naam, telegram_naam, badge, role').eq('telegram_id', parseInt(userId)).single();

            if (member && member.badge) {
                return res.json({
                    loggedIn: true,
                    needsSetup: false,
                    name: member.naam,
                    badge: member.badge,
                    role: member.role
                });
            } else {
                return res.json({
                    loggedIn: true,
                    needsSetup: true,
                    firstName: member?.telegram_naam || ''
                });
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
// 6. LOAN REQUEST
// ==========================
app.post('/api/loan', async (req, res) => {
    try {
        const { name, badge, afdeling, telefoon, reason, amount, term } = req.body;
        if (!name || !reason || !amount) return res.status(400).json({ success: false, message: 'Missing fields' });

        const userId = req.cookies.rgwo_user;

        const { data: pendingLoan } = await supabase
            .from('Leningen')
            .select('loan_id')
            .eq('telegram_id', parseInt(userId))
            .eq('status', 'pending')
            .single();

        if (pendingLoan) {
            return res.status(400).json({
                success: false,
                message: `U heeft al een openstaande aanvraag (${pendingLoan.loan_id}).`
            });
        }

        const { count } = await supabase
            .from('Leningen')
            .select('*', { count: 'exact', head: true });

        const nextNumber = (count || 0) + 1;
        const loanId = `LOAN_${String(nextNumber).padStart(5, '0')}`;

        await supabase.from('Leningen').insert({
            loan_id: loanId,
            telegram_id: parseInt(userId),
            naam: name,
            bedrag: parseInt(amount),
            status: 'pending'
        });

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
// 7. WEBHOOK FOR APPROVAL BUTTONS
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
            inline_keyboard: [[{ text: statusText, callback_data: "noop" }]]
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
// 8. DOCUMENT MANAGEMENT (Supabase Storage)
// ==========================

// Categories that are allowed
const VALID_CATEGORIES = ['formulieren', 'documenten', 'bekendmakingen', 'projecten', 'reglementen', 'overig'];

// File types that are allowed
const ALLOWED_EXTENSIONS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.png', '.jpg', '.jpeg'];

// --- GET documents grouped by category (for the member dashboard) ---
app.get('/api/documents/grouped', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('Documenten')
            .select('id, category, title, file_url, file_type, description, sort_order')
            .eq('is_active', true)
            .order('sort_order', { ascending: true })
            .order('title', { ascending: true });

        if (error) throw error;

        // Group them: { formulieren: [...], documenten: [...], ... }
        const grouped = {};
        data.forEach(doc => {
            if (!grouped[doc.category]) {
                grouped[doc.category] = [];
            }
            grouped[doc.category].push({
                id: doc.id,
                title: doc.title,
                url: doc.file_url,
                type: doc.file_type,
                description: doc.description
            });
        });

        res.json({ success: true, grouped });
    } catch (error) {
        console.error("[DOCS GROUPED ERROR]:", error.message);
        res.status(500).json({ success: false, grouped: {} });
    }
});

// --- GET all documents (flat list, for admin page) ---
app.get('/api/documents', async (req, res) => {
    try {
        const { category } = req.query;

        let query = supabase
            .from('Documenten')
            .select('*')
            .order('category', { ascending: true })
            .order('sort_order', { ascending: true });

        // If a category filter is given, use it
        if (category) {
            query = query.eq('category', category);
        }

        const { data, error } = await query;

        if (error) throw error;
        res.json({ success: true, documents: data });
    } catch (error) {
        console.error("[DOCS ERROR]:", error.message);
        res.status(500).json({ success: false, documents: [] });
    }
});

// --- UPLOAD a new document (admin only) ---
app.post('/api/documents/upload', upload.single('file'), async (req, res) => {
    try {
        // Step A: Check if user is logged in
        const userId = req.cookies.rgwo_user;
        if (!userId) return res.status(401).json({ success: false, message: 'Niet ingelogd.' });

        // Step B: Check if user is admin or board
        const { data: member } = await supabase
            .from('RGWO leden')
            .select('role, naam, telegram_naam')
            .eq('telegram_id', parseInt(userId))
            .single();

        if (!member || !['admin', 'board'].includes(member.role)) {
            return res.status(403).json({ success: false, message: 'Geen beheerdersrechten.' });
        }

        // Step C: Get form fields
        const { category, title, description, sort_order } = req.body;
        const file = req.file;

        if (!file || !category || !title) {
            return res.status(400).json({ success: false, message: 'Bestand, categorie en titel zijn verplicht.' });
        }

        // Step D: Validate category
        if (!VALID_CATEGORIES.includes(category)) {
            return res.status(400).json({ success: false, message: 'Ongeldige categorie.' });
        }

        // Step E: Validate file extension
        const ext = path.extname(file.originalname).toLowerCase();
        if (!ALLOWED_EXTENSIONS.includes(ext)) {
            return res.status(400).json({ success: false, message: 'Bestandstype niet toegestaan.' });
        }

        // Step F: Create a safe storage path
        const timestamp = Date.now();
        const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        const storagePath = `${category}/${timestamp}_${safeName}`;

        // Step G: Upload file to Supabase Storage
        const { data: uploadData, error: uploadError } = await supabase.storage
            .from('documents')
            .upload(storagePath, file.buffer, {
                contentType: file.mimetype,
                upsert: false
            });

        if (uploadError) {
            console.error("[STORAGE UPLOAD ERROR]:", uploadError);
            return res.status(500).json({ success: false, message: 'Fout bij uploaden naar opslag.' });
        }

        // Step H: Get the public URL of the uploaded file
        const { data: urlData } = supabase.storage
            .from('documents')
            .getPublicUrl(storagePath);

        const fileUrl = urlData.publicUrl;

        // Step I: Save document info to the Documenten table
        const { data: docRecord, error: dbError } = await supabase
            .from('Documenten')
            .insert({
                category: category,
                title: title,
                filename: file.originalname,
                storage_path: storagePath,
                file_url: fileUrl,
                file_type: ext.replace('.', ''),
                description: description || null,
                uploaded_by: member.naam || member.telegram_naam,
                sort_order: parseInt(sort_order) || 0
            })
            .select()
            .single();

        if (dbError) {
            console.error("[DB INSERT ERROR]:", dbError);
            // If database insert fails, remove the uploaded file to keep things clean
            await supabase.storage.from('documents').remove([storagePath]);
            return res.status(500).json({ success: false, message: 'Fout bij opslaan metadata.' });
        }

        console.log(`[UPLOAD] "${title}" uploaded to ${category} by ${member.naam || member.telegram_naam}`);
        res.json({ success: true, document: docRecord });

    } catch (error) {
        console.error("[UPLOAD ERROR]:", error.message);
        res.status(500).json({ success: false, message: 'Upload mislukt.' });
    }
});

// --- DELETE a document (admin only) ---
app.delete('/api/documents/:id', async (req, res) => {
    try {
        const userId = req.cookies.rgwo_user;
        if (!userId) return res.status(401).json({ success: false, message: 'Niet ingelogd.' });

        const { data: member } = await supabase
            .from('RGWO leden')
            .select('role')
            .eq('telegram_id', parseInt(userId))
            .single();

        if (!member || !['admin', 'board'].includes(member.role)) {
            return res.status(403).json({ success: false, message: 'Geen beheerdersrechten.' });
        }

        const docId = req.params.id;

        // Find the document so we know its storage_path
        const { data: doc } = await supabase
            .from('Documenten')
            .select('storage_path, title')
            .eq('id', docId)
            .single();

        if (!doc) {
            return res.status(404).json({ success: false, message: 'Document niet gevonden.' });
        }

        // Delete the actual file from Supabase Storage
        const { error: storageError } = await supabase.storage
            .from('documents')
            .remove([doc.storage_path]);

        if (storageError) {
            console.error("[STORAGE DELETE WARNING]:", storageError);
        }

        // Delete the record from the Documenten table
        const { error: dbError } = await supabase
            .from('Documenten')
            .delete()
            .eq('id', docId);

        if (dbError) throw dbError;

        console.log(`[DELETE] Document "${doc.title}" (ID: ${docId}) deleted`);
        res.json({ success: true });

    } catch (error) {
        console.error("[DELETE ERROR]:", error.message);
        res.status(500).json({ success: false });
    }
});

// --- UPDATE document info (admin only, for editing title/description/hiding) ---
app.patch('/api/documents/:id', async (req, res) => {
    try {
        const userId = req.cookies.rgwo_user;
        if (!userId) return res.status(401).json({ success: false, message: 'Niet ingelogd.' });

        const { data: member } = await supabase
            .from('RGWO leden')
            .select('role')
            .eq('telegram_id', parseInt(userId))
            .single();

        if (!member || !['admin', 'board'].includes(member.role)) {
            return res.status(403).json({ success: false, message: 'Geen beheerdersrechten.' });
        }

        const docId = req.params.id;
        const { title, description, category, sort_order, is_active } = req.body;

        // Build update object with only the fields that were sent
        const updates = {};
        if (title !== undefined) updates.title = title;
        if (description !== undefined) updates.description = description;
        if (category !== undefined) updates.category = category;
        if (sort_order !== undefined) updates.sort_order = parseInt(sort_order);
        if (is_active !== undefined) updates.is_active = is_active;

        const { data, error } = await supabase
            .from('Documenten')
            .update(updates)
            .eq('id', docId)
            .select()
            .single();

        if (error) throw error;
        res.json({ success: true, document: data });

    } catch (error) {
        console.error("[DOC UPDATE ERROR]:", error.message);
        res.status(500).json({ success: false });
    }
});

// ==========================
// 9. START SERVER & WEBHOOK
// ==========================
app.listen(PORT, async () => {
    console.log(`Server listening on port ${PORT}`);
    await registerWebhook();
});
