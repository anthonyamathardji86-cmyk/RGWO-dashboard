require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const session = require('cookie-session');
const path = require('path');

const app = express();

// ==========================
// 1. CONFIGURATION
// ==========================
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.APP_URL || `http://localhost:${PORT}`;

console.log(`[INFO] Server running at: ${BASE_URL}`);
console.log(`[INFO] Using Discord Guild ID: ${process.env.RGWO_GUILD_ID}`);

// ==========================
// 2. MIDDLEWARE
// ==========================
app.set('trust proxy', 1);
app.use(express.static(path.join(__dirname, 'public')));
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json()); // Needed to parse JSON bodies for the loan form
app.use(session({
    name: 'session',
    keys: [process.env.SESSION_SECRET || 'fallbacksecretpleasechangeinproduction'],
    maxAge: 24 * 60 * 60 * 1000
}));

// ==========================
// 3. DISCORD LOGIN REDIRECT
// ==========================
app.get('/auth/discord/login', (req, res) => {
    const params = new URLSearchParams({
        client_id: process.env.CLIENT_ID,
        redirect_uri: `${BASE_URL}/auth/discord/callback`,
        response_type: 'code',
        scope: 'identify guilds'
    });
    res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
});

// ==========================
// 4. DISCORD CALLBACK
// ==========================
app.get('/auth/discord/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.redirect('/?error=no_code');

    try {
        // 1. Exchange code for access token
        const tokenResponse = await axios.post(
            'https://discord.com/api/oauth2/token',
            new URLSearchParams({
                client_id: process.env.CLIENT_ID,
                client_secret: process.env.CLIENT_SECRET,
                grant_type: 'authorization_code',
                code,
                redirect_uri: `${BASE_URL}/auth/discord/callback`
            }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        const { access_token } = tokenResponse.data;

        // 2. Get user info
        const userResponse = await axios.get(
            'https://discord.com/api/users/@me',
            { headers: { Authorization: `Bearer ${access_token}` } }
        );
        const user = userResponse.data;

        // 3. Verify Guild Membership
        const RGWO_ID = process.env.RGWO_GUILD_ID;
        const memberCheck = await axios.get(
            `https://discord.com/api/guilds/${RGWO_ID}/members/${user.id}`,
            { headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` } }
        );
        
        console.log(`[SUCCESS] User ${user.username} is verified in guild.`);

        // 4. Save session
        req.session.user = {
            id: user.id,
            username: user.username,
            avatar: user.avatar,
            discriminator: user.discriminator,
            isMember: true
        };

        res.redirect('/');

    } catch (err) {
        const status = err.response?.status;
        const data = err.response?.data;
        console.error(`[AUTH ERROR]: ${status}`, data);

        if (status === 404 || data?.code === 10004) {
            return res.redirect('/?error=server_config'); // Wrong Guild ID or Bot not in server
        }
        if (status === 401) {
            return res.redirect('/?error=server_config'); // Bot Token invalid
        }
        // If the member check fails (404 on /members), it means they aren't in the guild
        if (err.config.url.includes('/members/')) {
             return res.redirect('/?error=not_member');
        }

        res.redirect('/?error=auth_failed');
    }
});

// ==========================
// 5. API: GET CURRENT USER
// ==========================
app.get('/api/me', (req, res) => {
    if (req.session.user) return res.json(req.session.user);
    res.status(401).json({ error: 'Not logged in' });
});

// ==========================
// 6. API: LOAN REQUEST (WEBHOOK)
// ==========================
app.post('/api/loan', async (req, res) => {
    try {
        const { name, department, badge, reason, amount, term } = req.body;
        const webhookUrl = process.env.LOAN_WEBHOOK_URL;

        // Get Discord ID from active session
        const discordId = req.session.user ? req.session.user.id : 'Niet ingelogd';

        if (!webhookUrl) {
            console.error('[ERROR] LOAN_WEBHOOK_URL is not configured');
            return res.status(500).json({ success: false, message: 'Webhook URL not configured' });
        }

        // Construct Discord Embed
        const payload = {
            username: "RGWO Loan Bot",
            avatar_url: "https://cdn-icons-png.flaticon.com/512/2098/2098589.png", 
            embeds: [
                {
                    title: "Nieuwe Leningaanvraag 🛡️",
                    color: 3447003, // Reddish blue color
                    fields: [
                        // --- USER INFO SECTION ---
                        { name: "👤 Gebruiker", value: "\u200b" }, 
                        { name: "Volledige naam", value: name, inline: false },
                        { name: "Badge nummer", value: badge, inline: false },
                        { name: "Afdeling", value: department, inline: false },

                        // --- SPACER ---
                        { name: "\u200b", value: "\u200b" }, 

                        // --- LOAN INFO SECTION ---
                        { name: "💰 Lening Details", value: "\u200b" }, 
                        { name: "Doel lening", value: reason, inline: false },
                        { name: "Bedrag (SRD)", value: amount, inline: false },
                        { name: "Termijn (maanden)", value: term, inline: false }
                    ],
                    // UPDATED: Explicitly says "Discord User ID"
                    footer: { text: `Verstuurd via RGWO Portal door Discord User ID: ${discordId}` },
                    timestamp: new Date().toISOString()
                }
            ]
        };

        await axios.post(webhookUrl, payload);
        console.log('[SUCCESS] Loan request sent to Discord.');
        res.json({ success: true });

    } catch (error) {
        console.error("[WEBHOOK ERROR]:", error.message);
        res.status(500).json({ success: false });
    }
});

// ==========================
// 7. API: LOGOUT
// ==========================
app.post('/api/logout', (req, res) => {
    req.session = null;
    res.status(200).json({ success: true });
});

// ==========================
// 8. START SERVER
// ==========================
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
