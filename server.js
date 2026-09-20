require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_IDS = (process.env.TELEGRAM_CHAT_ID || '').split(',').map(id => id.trim());
const DOMAIN = process.env.DOMAIN || 'www.rgwo.org';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ==========================
// 2. MIDDLEWARE
// ==========================
app.set('trust proxy', 1); // Important for Render/HTTPS detection
app.use(express.static(path.join(__dirname, 'public')));
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(cookieParser(process.env.COOKIE_SECRET || 'fallback_secret_change_this'));

// Helper middleware to check Telegram group membership
async function requireTelegramAuth(req, res, next) {
  const userId = req.cookies.rgwo_user;
  if (!userId) {
    return res.status(401).json({ success: false, message: 'Niet ingelogd' });
  }

  const groupId = CHAT_IDS[0]; // Primary group ID
  const chatCheckUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getChatMember?chat_id=${groupId}&user_id=${userId}`;

  try {
    const response = await fetch(chatCheckUrl);
    const data = await response.json();

    if (['member', 'administrator', 'creator'].includes(data.result?.status)) {
      req.userId = userId;
      return next();
    } else {
      res.clearCookie('rgwo_user');
      return res.status(403).json({ success: false, message: 'Geen toegang. Je bent geen lid van de RGWO Telegram groep.' });
    }
  } catch (error) {
    console.error("[AUTH CHECK ERROR]:", error.message);
    return res.status(500).json({ success: false, message: 'Authenticatie controle mislukt' });
  }
}

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
// 4. TELEGRAM VALIDATION
// ==========================
function validateTelegramLogin(userData) {
  const checkHash = userData.hash;
  const dataCheckArr = [];
  for (const key in userData) {
    if (key !== 'hash') dataCheckArr.push(`${key}=${userData[key]}`);
  }
  dataCheckArr.sort();
  const dataCheckString = dataCheckArr.join('\n');

  const secretKey = crypto.createHash('sha256').update(TELEGRAM_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (hash !== checkHash) return false;
  const authDate = parseInt(userData.auth_date);
  const currentTime = Math.floor(Date.now() / 1000);
  if (currentTime - authDate > 86400) return false; // 24 hours validity
  return true;
}

// ==========================
// 5. AUTHENTICATION API
// ==========================
app.post('/api/auth', async (req, res) => {
  try {
    const userData = req.body;
    if (!validateTelegramLogin(userData)) {
      return res.status(400).json({ success: false, message: 'Ongeldige Telegram login' });
    }

    const groupId = CHAT_IDS[0];
    const chatCheckUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getChatMember?chat_id=${groupId}&user_id=${userData.id}`;
    const response = await fetch(chatCheckUrl);
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
        telegram_id: userData.id,
        telegram_naam: telegramName,
        gebruikersnaam: userData.username || ''
      }, { onConflict: 'telegram_id' });

      if (dbError) console.error("[SUPABASE ERROR DETAILS]:", dbError.message);

      res.json({ success: true, user: userData });
    } else {
      res.status(403).json({ success: false, message: 'Je bent geen lid van de RGWO Telegram groep.' });
    }
  } catch (error) {
    console.error('[AUTH ERROR]:', error);
    res.status(500).json({ success: false, message: 'Server error tijdens authenticatie' });
  }
});

app.get('/api/me', requireTelegramAuth, async (req, res) => {
  try {
    const { data: member } = await supabase.from('RGWO leden')
      .select('naam, telegram_naam, badge, role')
      .eq('telegram_id', parseInt(req.userId))
      .single();

    if (member && member.badge) {
      return res.json({
        loggedIn: true,
        needsSetup: false,
        name: member.naam,
        badge: member.badge,
        role: member.role || 'member'
      });
    } else {
      return res.json({
        loggedIn: true,
        needsSetup: true,
        firstName: member?.telegram_naam || ''
      });
    }
  } catch (error) {
    res.status(500).json({ loggedIn: false });
  }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('rgwo_user');
  res.json({ success: true });
});

// ==========================
// 6. DOCUMENTS & FORMULIEREN API
// ==========================

// Get list of documents/forms filtered by category ('Documenten', 'Bekendmakingen', 'Formulieren')
app.get('/api/documents', requireTelegramAuth, async (req, res) => {
  const { category } = req.query;

  try {
    let query = supabase.from('documents').select('id, title, category, file_path, created_at');
    if (category) {
      query = query.eq('category', category);
    }

    const { data: docs, error } = await query.order('created_at', { ascending: false });
    if (error) throw error;

    res.json({ success: true, documents: docs });
  } catch (error) {
    console.error("[DOCUMENTS FETCH ERROR]:", error.message);
    res.status(500).json({ success: false, message: 'Fout bij het ophalen van documenten' });
  }
});

// Generate a 60-second secure temporary download URL for private bucket files
app.get('/api/documents/download', requireTelegramAuth, async (req, res) => {
  const { filePath } = req.query;
  if (!filePath) {
    return res.status(400).json({ success: false, message: 'Missing file path parameter' });
  }

  try {
    const { data, error } = await supabase.storage
      .from('documents')
      .createSignedUrl(filePath, 60);

    if (error) throw error;

    res.json({ success: true, downloadUrl: data.signedUrl });
  } catch (error) {
    console.error("[DOWNLOAD SIGNED URL ERROR]:", error.message);
    res.status(500).json({ success: false, message: 'Fout bij aanmaken van downloadlink' });
  }
});

// ==========================
// 7. LOAN REQUEST (SINGLE PENDING LIMIT)
// ==========================
app.post('/api/loan', requireTelegramAuth, async (req, res) => {
  try {
    const { amount, duration, reason } = req.body;
    const userId = parseInt(req.userId);

    const { data: pendingLoan } = await supabase
      .from('Leningen')
      .select('loan_id')
      .eq('telegram_id', userId)
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
      telegram_id: userId,
      bedrag: amount,
      looptijd: duration,
      reden: reason,
      status: 'pending'
    });

    res.json({ success: true, loan_id: loanId });
  } catch (error) {
    console.error('[LOAN ERROR]:', error);
    res.status(500).json({ success: false, message: 'Fout bij het indienen van de leningaanvraag' });
  }
});

// ==========================
// 8. WEBHOOK FOR APPROVAL BUTTONS
// ==========================
app.post('/api/webhook', async (req, res) => {
  const callbackQuery = req.body.callback_query;
  if (!callbackQuery) return res.sendStatus(200);

  const action = callbackQuery.data; // e.g. 'approve_LOAN_00001'
  const messageId = callbackQuery.message.message_id;
  const chatId = callbackQuery.message.chat.id;

  try {
    if (action.startsWith('approve_')) {
      const loanId = action.replace('approve_', '');
      await supabase.from('Leningen').update({ status: 'approved' }).eq('loan_id', loanId);

      await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text: `✅ Leningaanvraag ${loanId} GOEDGEKEURD.`
        })
      });
    } else if (action.startsWith('reject_')) {
      const loanId = action.replace('reject_', '');
      await supabase.from('Leningen').update({ status: 'rejected' }).eq('loan_id', loanId);

      await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text: `❌ Leningaanvraag ${loanId} AFGEWEZEN.`
        })
      });
    }
  } catch (error) {
    console.error('[WEBHOOK ERROR]:', error);
  }

  res.sendStatus(200);
});

// ==========================
// 9. START SERVER & WEBHOOK
// ==========================
app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);
  await registerWebhook();
});
