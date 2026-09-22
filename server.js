require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');

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
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(cookieParser(process.env.COOKIE_SECRET || 'fallback_secret_change_this'));

// ==========================
// 2B. MAINTENANCE MODE
// ==========================
function isMaintenanceEnabled() {
    try {
        const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'maintenance.json'), 'utf8'));
        return config.enabled === true;
    } catch (err) { return false; }
}

async function getUserRole(userId) {
    if (!userId) return null;
    try {
        const { data: member } = await supabase.from('RGWO leden').select('role').eq('telegram_id', parseInt(userId)).single();
        return member?.role || null;
    } catch (err) { return null; }
}

const MAINTENANCE_AUTH_WHITELIST = ['/api/auth', '/api/me', '/api/logout', '/api/maintenance'];

app.use(async (req, res, next) => {
    try {
        if (!isMaintenanceEnabled()) return next();
        if (MAINTENANCE_AUTH_WHITELIST.some(route => req.path.startsWith(route))) return next();
        const userId = req.cookies.rgwo_user;
        const role = await getUserRole(userId);
        if (role === 'admin') return next();
        const acceptHeader = req.headers.accept || '';
        if (acceptHeader.includes('text/html')) {
            return res.sendFile(path.join(__dirname, 'public', 'maintenance.html'));
        }
        if (req.path.startsWith('/api/')) {
            return res.status(503).json({ success: false, maintenance: true, message: 'Website is momenteel in onderhoud.' });
        }
        next();
    } catch (err) {
        console.error('[MAINTENANCE MW ERROR]:', err.message);
        var acceptHeader = req.headers.accept || '';
        if (acceptHeader.includes('text/html')) {
            return res.sendFile(path.join(__dirname, 'public', 'maintenance.html'));
        }
        next();
    }
});

app.use(express.static(path.join(__dirname, 'public')));

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

    try {
        // Auto-merge: check for manual entry with same badge and null telegram_id
        const { data: manualEntry } = await supabase
            .from('RGWO leden')
            .select('*')
            .eq('badge', badge)
            .is('telegram_id', null)
            .limit(1)
            .single();

        let mergeRole = null;
        if (manualEntry) {
            mergeRole = manualEntry.role;
            await supabase.from('RGWO leden').delete().eq('id', manualEntry.id);
            console.log(`[MERGE] Badge ${badge} manual entry merged with Telegram user ${userId}`);
        }

        const updates = { naam, badge, afdeling };
        if (mergeRole) updates.role = mergeRole;

        const { error } = await supabase.from('RGWO leden').update(updates).eq('telegram_id', parseInt(userId));
        if (error) { console.error("[DB ERROR]:", error.message); return res.status(500).json({ success: false }); }
        res.json({ success: true });
    } catch (error) {
        // Fallback: update without merge
        console.error("[PROFILE MERGE ERROR]:", error.message);
        const { error: dbErr } = await supabase.from('RGWO leden').update({ naam, badge, afdeling }).eq('telegram_id', parseInt(userId));
        if (dbErr) return res.status(500).json({ success: false });
        res.json({ success: true });
    }
});

app.post('/api/logout', (req, res) => {
    res.clearCookie('rgwo_user');
    res.json({ success: true });
});

// ==========================
// 5B. MAINTENANCE TOGGLE (admin only)
// ==========================
app.get('/api/maintenance', async (req, res) => {
    try {
        const userId = req.cookies.rgwo_user;
        if (!userId) return res.status(401).json({ success: false });
        const role = await getUserRole(userId);
        if (role !== 'admin') return res.status(403).json({ success: false, message: 'Alleen admins.' });
        const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'maintenance.json'), 'utf8'));
        res.json({ success: true, enabled: config.enabled });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.post('/api/maintenance/toggle', async (req, res) => {
    try {
        const userId = req.cookies.rgwo_user;
        if (!userId) return res.status(401).json({ success: false });
        const role = await getUserRole(userId);
        if (role !== 'admin') return res.status(403).json({ success: false, message: 'Alleen admins.' });
        const configPath = path.join(__dirname, 'maintenance.json');
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        config.enabled = !config.enabled;
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.log(`[MAINTENANCE] Mode ${config.enabled ? 'ENABLED' : 'DISABLED'} by user ${userId}`);
        res.json({ success: true, enabled: config.enabled });
    } catch (error) {
        console.error('[MAINTENANCE ERROR]:', error.message);
        res.status(500).json({ success: false });
    }
});

// ==========================
// 5C. LEDEN MANAGEMENT (admin)
// ==========================
app.get('/api/leden', async (req, res) => {
    try {
        const userId = req.cookies.rgwo_user;
        if (!userId) return res.status(401).json({ success: false });
        const role = await getUserRole(userId);
        if (!['admin'].includes(role)) return res.status(403).json({ success: false });

        const { search, role: filterRole } = req.query;
        let query = supabase.from('RGWO leden').select('*').order('naam', { ascending: true });
        if (filterRole) query = query.eq('role', filterRole);
        if (search) query = query.or('naam.ilike.%' + search + '%,badge.ilike.%' + search + '%,telegram_naam.ilike.%' + search + '%');

        const { data, error } = await query;
        if (error) throw error;
        res.json({ success: true, leden: data });
    } catch (error) {
        console.error("[LEDEN ERROR]:", error.message);
        res.status(500).json({ success: false, leden: [] });
    }
});

app.post('/api/leden', async (req, res) => {
    try {
        const userId = req.cookies.rgwo_user;
        if (!userId) return res.status(401).json({ success: false });
        const role = await getUserRole(userId);
        if (role !== 'admin') return res.status(403).json({ success: false, message: 'Alleen admins.' });

        const { naam, badge, afdeling, member_role, telegram_id, telegram_username, telegram_naam } = req.body;
        if (!naam || !badge || !afdeling) return res.status(400).json({ success: false, message: 'Naam, badge en afdeling zijn verplicht.' });

        const insertData = {
            naam,
            badge,
            afdeling,
            role: member_role || 'member',
            telegram_id: telegram_id ? parseInt(telegram_id) : null,
            telegram_username: telegram_username || null,
            telegram_naam: telegram_naam || naam
        };

        const { data, error } = await supabase.from('RGWO leden').insert(insertData).select().single();
        if (error) { console.error("[LEDEN INSERT ERROR]:", error.message); return res.status(500).json({ success: false, message: 'Fout bij toevoegen.' }); }
        console.log(`[LEDEN] Member "${naam}" added manually by admin ${userId}`);
        res.json({ success: true, lid: data });
    } catch (error) {
        console.error("[LEDEN ADD ERROR]:", error.message);
        res.status(500).json({ success: false });
    }
});

app.patch('/api/leden/:id', async (req, res) => {
    try {
        const userId = req.cookies.rgwo_user;
        if (!userId) return res.status(401).json({ success: false });
        const role = await getUserRole(userId);
        if (role !== 'admin') return res.status(403).json({ success: false, message: 'Alleen admins.' });

        const { naam, badge, afdeling, member_role, telegram_username } = req.body;
        const updates = {};
        if (naam !== undefined) updates.naam = naam;
        if (badge !== undefined) updates.badge = badge;
        if (afdeling !== undefined) updates.afdeling = afdeling;
        if (member_role !== undefined) updates.role = member_role;
        if (telegram_username !== undefined) updates.telegram_username = telegram_username;

        const { data, error } = await supabase.from('RGWO leden').update(updates).eq('id', req.params.id).select().single();
        if (error) throw error;
        res.json({ success: true, lid: data });
    } catch (error) {
        console.error("[LEDEN UPDATE ERROR]:", error.message);
        res.status(500).json({ success: false });
    }
});

app.delete('/api/leden/:id', async (req, res) => {
    try {
        const userId = req.cookies.rgwo_user;
        if (!userId) return res.status(401).json({ success: false });
        const role = await getUserRole(userId);
        if (role !== 'admin') return res.status(403).json({ success: false, message: 'Alleen admins.' });

        const { error } = await supabase.from('RGWO leden').delete().eq('id', req.params.id);
        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        console.error("[LEDEN DELETE ERROR]:", error.message);
        res.status(500).json({ success: false });
    }
});

// ==========================
// 5D. KLACHTENFORMULIER
// ==========================
async function sendKlachtTelegram(klacht) {
    try {
        const doc = new PDFDocument({ margin: 50 });
        const buffers = [];
        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', async () => {
            const pdfData = Buffer.concat(buffers);
            
            // Prepare Telegram document upload
            const formData = new FormData();
            formData.append('chat_id', CHAT_IDS[0]); // Sends to the main admin chat
            formData.append('caption', `📄 *Nieuwe Klacht ${klacht.klacht_id} - ${klacht.naam}*\nBadge: ${klacht.badge || '-'}\nCategorieën: ${klacht.categories}`);            
            const pdfBlob = new Blob([pdfData], { type: 'application/pdf' });
            formData.append('document', pdfBlob, `KLACHT-${klacht.badge || 'unknown'}-${Date.now()}.pdf`);

            const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendDocument`;
            const response = await fetch(url, {
                method: 'POST',
                body: formData
            });

            const result = await response.json();
            if (!result.ok) {
                console.error('[TELEGRAM PDF ERROR]', result.description);
            } else {
                console.log(`[KLACHT TELEGRAM] PDF sent to admin chat`);
            }
        });

        // Generate the PDF content
        doc.fontSize(22).text('RGWO', { align: 'center' });
        doc.fontSize(16).text('KLACHTENFORMULIER', { align: 'center' });
        doc.moveDown(0.5);
        doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
        doc.moveDown();
        doc.fontSize(10).fillColor('gray').text(`Referentie: ${klacht.klacht_id}`, 50);
        doc.text(`Datum: ${new Date().toLocaleDateString('nl-NL', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`, 50);
        doc.moveDown();
        doc.fillColor('black').fontSize(12);
        doc.text(`Naam:          ${klacht.naam}`);
        doc.text(`Badge:         ${klacht.badge || '-'}`);
        doc.text(`Afdeling:      ${klacht.afdeling || '-'}`);
        doc.text(`Incident:      ${klacht.incident_date || '-'}`);
        doc.moveDown();
        doc.text('Categorieen:');
        klacht.categories.split(',').forEach(c => doc.text(`  - ${c.trim()}`));
        doc.moveDown();
        doc.text('Beschrijving:');
        doc.fontSize(10).text(klacht.description, { width: 445 });
        doc.fontSize(12).moveDown();
        doc.text('Gewenste oplossing:');
        doc.fontSize(10).text(klacht.resolution || '-', { width: 445 });
        doc.moveDown(2);
        doc.fontSize(10).fillColor('gray').text('Dit is een automatisch gegenereerd document van het RGWO Portal.', { align: 'center' });
        doc.end();
    } catch (err) {
        console.error('[KLACHT PDF/TELEGRAM ERROR]:', err.message);
    }
}

app.post('/api/klacht', async (req, res) => {
    try {
        const userId = req.cookies.rgwo_user;
        if (!userId) return res.status(401).json({ success: false, message: 'Niet ingelogd.' });

        const { naam, badge, afdeling, incident_date, categories, description, resolution } = req.body;
        if (!naam || !categories || !description) {
            return res.status(400).json({ success: false, message: 'Naam, categorie en beschrijving zijn verplicht.' });
        }

        // Generate the Klacht ID
        const { count } = await supabase.from('Klachten').select('*', { count: 'exact', head: true });
        const nextNumber = (count || 0) + 1;
        const klachtId = `Klacht_${String(nextNumber).padStart(4, '0')}`;

        const { error } = await supabase.from('Klachten').insert({
            klacht_id: klachtId,
            telegram_id: parseInt(userId),
            naam,
            badge: badge || null,
            afdeling: afdeling || null,
            incident_date: incident_date || null,
            categories,
            description,
            resolution: resolution || null,
            status: 'pending'
        });

        if (error) {
            console.error("[KLACHT ERROR]:", error.message);
            return res.status(500).json({ success: false, message: 'Fout bij indienen.' });
        }

        await sendKlachtTelegram({ klacht_id: klachtId, naam, badge, afdeling, incident_date, categories, description, resolution });
        console.log(`[KLACHT] New complaint ${klachtId} from ${naam}`);
        res.json({ success: true });
    } catch (error) {
        console.error("[KLACHT ERROR]:", error.message);
        res.status(500).json({ success: false });
    }
});

app.get('/api/klachten', async (req, res) => {
    try {
        const userId = req.cookies.rgwo_user;
        if (!userId) return res.status(401).json({ success: false });
        const { data: member } = await supabase.from('RGWO leden').select('role').eq('telegram_id', parseInt(userId)).single();
        if (!member || !['admin'].includes(member.role)) return res.status(403).json({ success: false });
        const { data, error } = await supabase.from('Klachten').select('*').order('klacht_id', { ascending: true });
        if (error) throw error;
        res.json({ success: true, klachten: data });
    } catch (error) {
        console.error("[KLACHTEN ERROR]:", error.message);
        res.status(500).json({ success: false, klachten: [] });
    }
});

app.patch('/api/klachten/:id', async (req, res) => {
    try {
        const userId = req.cookies.rgwo_user;
        if (!userId) return res.status(401).json({ success: false });
        const { data: member } = await supabase.from('RGWO leden').select('role').eq('telegram_id', parseInt(userId)).single();
        if (!member || !['admin'].includes(member.role)) return res.status(403).json({ success: false });
        const { status, admin_notes } = req.body;
        const updates = {};
        if (status !== undefined) updates.status = status;
        if (admin_notes !== undefined) updates.admin_notes = admin_notes;
        const { data, error } = await supabase.from('Klachten').update(updates).eq('id', req.params.id).select().single();
        if (error) throw error;
        res.json({ success: true, klacht: data });
    } catch (error) {
        console.error("[KLACHT UPDATE ERROR]:", error.message);
        res.status(500).json({ success: false });
    }
});

// ==========================
// 5E. SITE SETTINGS & STATS
// ==========================
app.get('/api/stats', async (req, res) => {
    try {
        let activeMembers = 0;
        try {
            const { data } = await supabase.from('SiteSettings').select('active_members').eq('id', 1).single();
            activeMembers = data?.active_members || 0;
        } catch (err) {}
        
        const { count } = await supabase.from('RGWO leden').select('*', { count: 'exact', head: true });
        res.json({ success: true, active_members: activeMembers, telegram_count: count || 0 });
    } catch (error) {
        res.status(500).json({ success: false, active_members: 0, telegram_count: 0 });
    }
});

app.patch('/api/settings', async (req, res) => {
    try {
        const userId = req.cookies.rgwo_user;
        if (!userId) return res.status(401).json({ success: false });
        const role = await getUserRole(userId);
        if (role !== 'admin') return res.status(403).json({ success: false });

        const { active_members } = req.body;
        const updates = {};
        if (active_members !== undefined) updates.active_members = parseInt(active_members) || 0;

        const { data, error } = await supabase.from('SiteSettings').update(updates).eq('id', 1).select().single();
        if (error) throw error;
        
        res.json({ success: true, settings: data });
    } catch (error) {
        console.error("[SETTINGS ERROR]:", error.message);
        res.status(500).json({ success: false });
    }
});

// ==========================
// 5F. FINANCIAL DATA
// ==========================
app.get('/api/finance', async (req, res) => {
    try {
        const { data } = await supabase.from('FinancialData').select('*').eq('id', 1).single();
        if (data) return res.json({ success: true, data });
        // Return defaults if no row exists
        res.json({ success: true, data: {
            total_balance: 0, net_surplus: 0,
            chart_labels: 'Dues,Events,Rent,Legal,Ops',
            monthly_income: '0,0,0,0,0', monthly_expenses: '0,0,0,0,0',
            quarterly_income: '0,0,0,0,0', quarterly_expenses: '0,0,0,0,0',
            yearly_income: '0,0,0,0,0', yearly_expenses: '0,0,0,0,0',
            transactions: []
        }});
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.patch('/api/finance', async (req, res) => {
    try {
        const userId = req.cookies.rgwo_user;
        if (!userId) return res.status(401).json({ success: false });
        const role = await getUserRole(userId);
        if (role !== 'admin') return res.status(403).json({ success: false });

        const fields = ['total_balance', 'net_surplus', 'chart_labels',
            'monthly_income', 'monthly_expenses',
            'quarterly_income', 'quarterly_expenses',
            'yearly_income', 'yearly_expenses', 'transactions'];
        const updates = {};
        fields.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
        updates.updated_at = new Date().toISOString();

        const { data, error } = await supabase.from('FinancialData').update(updates).eq('id', 1).select().single();
        if (error) throw error;
        res.json({ success: true, data });
    } catch (error) {
        console.error("[FINANCE UPDATE ERROR]:", error.message);
        res.status(500).json({ success: false });
    }
});

app.post('/api/finance/transaction', async (req, res) => {
    try {
        const userId = req.cookies.rgwo_user;
        if (!userId) return res.status(401).json({ success: false });
        const role = await getUserRole(userId);
        if (role !== 'admin') return res.status(403).json({ success: false });

        const { date, description, category, amount } = req.body;
        if (!date || !description || !amount) return res.status(400).json({ success: false });

        const { data: finance } = await supabase.from('FinancialData').select('transactions').eq('id', 1).single();
        const txns = finance?.transactions || [];
        txns.push({ date, description, category, amount, id: Date.now() });

        const { data, error } = await supabase.from('FinancialData').update({ transactions: txns }).eq('id', 1).select().single();
        if (error) throw error;
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.delete('/api/finance/transaction/:txnId', async (req, res) => {
    try {
        const userId = req.cookies.rgwo_user;
        if (!userId) return res.status(401).json({ success: false });
        const role = await getUserRole(userId);
        if (role !== 'admin') return res.status(403).json({ success: false });

        const { data: finance } = await supabase.from('FinancialData').select('transactions').eq('id', 1).single();
        const txns = (finance?.transactions || []).filter(t => String(t.id) !== req.params.txnId);

        const { data, error } = await supabase.from('FinancialData').update({ transactions: txns }).eq('id', 1).select().single();
        if (error) throw error;
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false });
    }
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
            badge: badge || null,
            afdeling: afdeling || null,
            telefoon: telefoon || null,
            reason: reason,
            bedrag: parseInt(amount),
            term: term ? parseInt(term) : null,
            status: 'pending'
        });

        // --- CREATE PDF ---
        const doc = new PDFDocument({ margin: 50 });
        const buffers = [];
        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', async () => {
            const pdfData = Buffer.concat(buffers);
            
            // Prepare Telegram document upload
            const formData = new FormData();
            formData.append('chat_id', CHAT_IDS[0]);
            formData.append('caption', `📄 *Nieuwe Leningaanvraag ${loanId} - ${name}*\nBadge: ${badge || '-'}\nBedrag: SRD ${amount}`);
            
            const pdfBlob = new Blob([pdfData], { type: 'application/pdf' });
            formData.append('document', pdfBlob, `LENING-${loanId}.pdf`);

            // Add the Approve/Reject buttons
            const keyboard = {
                inline_keyboard: [
                    [
                        { text: "✅ Goedkeuren", callback_data: `approve_${loanId}` },
                        { text: "❌ Afwijzen", callback_data: `reject_${loanId}` }
                    ]
                ]
            };
            formData.append('reply_markup', JSON.stringify(keyboard));

            const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendDocument`;
            const response = await fetch(url, {
                method: 'POST',
                body: formData
            });

            const result = await response.json();
            if (!result.ok) {
                console.error('[TELEGRAM PDF ERROR]', result.description);
            } else {
                console.log(`[LENING TELEGRAM] PDF sent to admin chat`);
            }
        });

        // Generate the PDF content
        doc.fontSize(22).text('RGWO', { align: 'center' });
        doc.fontSize(16).text('LENINGAANVRAAG', { align: 'center' });
        doc.moveDown(0.5);
        doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
        doc.moveDown();
        doc.fontSize(10).fillColor('@gray').text(`Referentie: ${loanId}`, 50);
        doc.text(`Datum: ${new Date().toLocaleDateString('nl-NL', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`, 50);
        doc.moveDown();
        doc.fillColor('black').fontSize(12);
        doc.text(`Naam:          ${name}`);
        doc.text(`Badge:         ${badge || '-'}`);
        doc.text(`Afdeling:      ${afdeling || '-'}`);
        doc.text(`Telefoon:      ${telefoon || '-'}`);
        doc.moveDown();
        doc.text('Lening Details:');
        doc.text(`  Doel:        ${reason}`);
        doc.text(`  Bedrag:      SRD ${amount}`);
        doc.text(`  Termijn:     ${term ? term + ' maanden' : '-'}`);
        doc.moveDown(2);
        doc.fontSize(10).fillColor('gray').text('Dit is een automatisch gegenereerd document van het RGWO Portal.', { align: 'center' });
        doc.end();

        console.log(`[SUCCESS] Loan ${loanId} from ${name} saved to database.`);
        res.json({ success: true });
    } catch (error) {
        console.error("[LOAN ERROR]:", error.message);
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
const VALID_CATEGORIES = ['formulieren', 'documenten', 'bekendmakingen', 'reglementen', 'overig'];

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

        if (!member || !['admin'].includes(member.role)) {
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

        if (!member || !['admin'].includes(member.role)) {
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

        if (!member || !['admin'].includes(member.role)) {
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
app.delete('/api/klachten/:id', async (req, res) => {
    try {
        const userId = req.cookies.rgwo_user;
        if (!userId) return res.status(401).json({ success: false });
        const { data: member } = await supabase.from('RGWO leden').select('role').eq('telegram_id', parseInt(userId)).single();
        if (!member || !['admin'].includes(member.role)) return res.status(403).json({ success: false });
        
        const { error } = await supabase.from('Klachten').delete().eq('id', req.params.id);
        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        console.error("[KLACHT DELETE ERROR]:", error.message);
        res.status(500).json({ success: false });
    }
});

app.get('/api/leningen', async (req, res) => {
    try {
        const userId = req.cookies.rgwo_user;
        if (!userId) return res.status(401).json({ success: false });
        const { data: member } = await supabase.from('RGWO leden').select('role').eq('telegram_id', parseInt(userId)).single();
        if (!member || member.role !== 'admin') return res.status(403).json({ success: false });
        const { data, error } = await supabase.from('Leningen').select('*').order('created_at', { ascending: false });
        if (error) throw error;
        res.json({ success: true, leningen: data });
    } catch (error) {
        console.error("[LENINGEN ERROR]:", error.message);
        res.status(500).json({ success: false, leningen: [] });
    }
});

app.patch('/api/leningen/:loan_id', async (req, res) => {
    try {
        const userId = req.cookies.rgwo_user;
        if (!userId) return res.status(401).json({ success: false });
        const { data: member } = await supabase.from('RGWO leden').select('role').eq('telegram_id', parseInt(userId)).single();
        if (!member || member.role !== 'admin') return res.status(403).json({ success: false });
        const { status } = req.body;
        const { data, error } = await supabase.from('Leningen').update({ status }).eq('loan_id', req.params.loan_id).select().single();
        if (error) throw error;
        res.json({ success: true, lening: data });
    } catch (error) {
        console.error("[LENING UPDATE ERROR]:", error.message);
        res.status(500).json({ success: false });
    }
});

app.listen(PORT, async () => {
    console.log(`Server listening on port ${PORT}`);
    await registerWebhook();
});

// ==========================
// 10. ANNOUNCEMENTS (Mededelingen)
// ==========================

// --- GET active announcements (public) ---
app.get('/api/announcements', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('Mededelingen')
            .select('*')
            .eq('is_active', true)
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json({ success: true, announcements: data });
    } catch (error) {
        console.error("[ANNOUNCEMENTS ERROR]:", error.message);
        res.status(500).json({ success: false, announcements: [] });
    }
});

// --- GET all announcements (admin, includes inactive) ---
app.get('/api/announcements/all', async (req, res) => {
    try {
        const userId = req.cookies.rgwo_user;
        if (!userId) return res.status(401).json({ success: false });

        const { data: member } = await supabase
            .from('RGWO leden')
            .select('role')
            .eq('telegram_id', parseInt(userId))
            .single();

        if (!member || !['admin'].includes(member.role)) {
            return res.status(403).json({ success: false });
        }

        const { data, error } = await supabase
            .from('Mededelingen')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json({ success: true, announcements: data });
    } catch (error) {
        console.error("[ANNOUNCEMENTS ALL ERROR]:", error.message);
        res.status(500).json({ success: false, announcements: [] });
    }
});

// --- CREATE announcement (admin only) ---
app.post('/api/announcements', async (req, res) => {
    try {
        const userId = req.cookies.rgwo_user;
        if (!userId) return res.status(401).json({ success: false, message: 'Niet ingelogd.' });

        const { data: member } = await supabase
            .from('RGWO leden')
            .select('role')
            .eq('telegram_id', parseInt(userId))
            .single();

        if (!member || !['admin'].includes(member.role)) {
            return res.status(403).json({ success: false, message: 'Geen beheerdersrechten.' });
        }

        const { message, type } = req.body;
        if (!message) return res.status(400).json({ success: false, message: 'Bericht is verplicht.' });

        const validTypes = ['info', 'warning', 'urgent'];
        const annType = validTypes.includes(type) ? type : 'info';

        const { data: newAnn, error } = await supabase
            .from('Mededelingen')
            .insert({ message, type: annType })
            .select()
            .single();

        if (error) throw error;
        res.json({ success: true, announcement: newAnn });
    } catch (error) {
        console.error("[ANNOUNCEMENT CREATE ERROR]:", error.message);
        res.status(500).json({ success: false });
    }
});

// --- UPDATE announcement (admin only) ---
app.patch('/api/announcements/:id', async (req, res) => {
    try {
        const userId = req.cookies.rgwo_user;
        if (!userId) return res.status(401).json({ success: false });

        const { data: member } = await supabase
            .from('RGWO leden')
            .select('role')
            .eq('telegram_id', parseInt(userId))
            .single();

        if (!member || !['admin'].includes(member.role)) {
            return res.status(403).json({ success: false });
        }

        const annId = req.params.id;
        const { message, type, is_active } = req.body;

        const updates = {};
        if (message !== undefined) updates.message = message;
        if (type !== undefined) updates.type = type;
        if (is_active !== undefined) updates.is_active = is_active;

        const { data, error } = await supabase
            .from('Mededelingen')
            .update(updates)
            .eq('id', annId)
            .select()
            .single();

        if (error) throw error;
        res.json({ success: true, announcement: data });
    } catch (error) {
        console.error("[ANNOUNCEMENT UPDATE ERROR]:", error.message);
        res.status(500).json({ success: false });
    }
});

// --- DELETE announcement (admin only) ---
app.delete('/api/announcements/:id', async (req, res) => {
    try {
        const userId = req.cookies.rgwo_user;
        if (!userId) return res.status(401).json({ success: false });

        const { data: member } = await supabase
            .from('RGWO leden')
            .select('role')
            .eq('telegram_id', parseInt(userId))
            .single();

        if (!member || !['admin'].includes(member.role)) {
            return res.status(403).json({ success: false });
        }

        const { error } = await supabase
            .from('Mededelingen')
            .delete()
            .eq('id', req.params.id);

        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        console.error("[ANNOUNCEMENT DELETE ERROR]:", error.message);
        res.status(500).json({ success: false });
    }
});
