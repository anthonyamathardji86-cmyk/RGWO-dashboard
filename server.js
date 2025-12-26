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

// IMPORTANT: In Render, create an Environment Variable named APP_URL 
// and set it to https://your-app-name.onrender.com
const BASE_URL = process.env.APP_URL || `http://localhost:${PORT}`;

console.log(`[INFO] Server running at: ${BASE_URL}`);
console.log(`[INFO] Using Discord Guild ID: ${process.env.RGWO_GUILD_ID}`);

// ==========================
// 2. MIDDLEWARE
// ==========================

app.set('trust proxy', 1);

app.use(express.static(path.join(__dirname, 'public')));

app.use(cors({
    origin: '*',
    credentials: true
}));

app.use(session({
    name: 'session',
    keys: [process.env.SESSION_SECRET || 'fallbacksecretpleasechangeinproduction'],
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
}));

// ==========================
// 3. DISCORD LOGIN REDIRECT
// ==========================
app.get('/auth/discord/login', (req, res) => {
    const params = new URLSearchParams({
        client_id: process.env.CLIENT_ID,
        redirect_uri: `${BASE_URL}/auth/discord/callback`,
        response_type: 'code',
        scope: 'identify guilds' // Added guilds scope just in case
    });

    res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
});

// ==========================
// 4. DISCORD CALLBACK (FIXED)
// ==========================
app.get('/auth/discord/callback', async (req, res) => {
    const { code } = req.query;
    
    if (!code) {
        console.error("[ERROR] No code provided by Discord");
        return res.redirect('/?error=no_code');
    }

    try {
        // 1️⃣ Exchange code for access token
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

        // 2️⃣ Get user info
        const userResponse = await axios.get(
            'https://discord.com/api/users/@me',
            { headers: { Authorization: `Bearer ${access_token}` } }
        );

        const user = userResponse.data;

        // 3️⃣ Verify Guild Membership (The "Member Check")
        const RGWO_ID = process.env.RGWO_GUILD_ID;
        
        // This request will fail (throw error) if the user is NOT in the guild
        // or if the Bot Token is invalid.
        const memberCheck = await axios.get(
            `https://discord.com/api/guilds/${RGWO_ID}/members/${user.id}`,
            {
                headers: {
                    Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`
                }
            }
        );
        
        console.log(`[SUCCESS] User ${user.username} is a member.`);

        // 4️⃣ Save session (User passed the check)
        req.session.user = {
            id: user.id,
            username: user.username,
            avatar: user.avatar,
            discriminator: user.discriminator,
            isMember: true // Explicitly setting this
        };

        // 5️⃣ Redirect to dashboard
        res.redirect('/');

    } catch (err) {
        // LOG THE ERROR SO YOU CAN SEE WHY IT FAILED
        console.error('[AUTH ERROR]:', err.response?.status, err.response?.data || err.message);

        if (err.response?.status === 404) {
            console.error(`[FAIL] User is not in the Guild ID: ${process.env.RGWO_GUILD_ID}`);
            return res.redirect('/?error=not_member');
        }
        
        if (err.response?.status === 401) {
            console.error('[FAIL] Bot Token is invalid or missing permissions.');
            return res.redirect('/?error=server_config');
        }

        res.redirect('/?error=auth_failed');
    }
});

// ==========================
// 5. API: GET CURRENT USER
// ==========================
app.get('/api/me', (req, res) => {
    if (req.session.user) {
        return res.json(req.session.user);
    }
    res.status(401).json({ error: 'Not logged in' });
});

// ==========================
// 6. API: LOGOUT
// ==========================
app.post('/api/logout', (req, res) => {
    req.session = null;
    res.status(200).json({ success: true });
});

// ==========================
// 7. START SERVER
// ==========================
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
