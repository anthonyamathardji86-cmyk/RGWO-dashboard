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

// BASE_URL must be your public Render URL in production
const BASE_URL = process.env.APP_URL || `http://localhost:${PORT}`;

console.log(`Server running at: ${BASE_URL}`);

// ==========================
// 2. MIDDLEWARE
// ==========================

// Trust Render’s proxy
app.set('trust proxy', 1);

// Serve frontend (index.html) from public folder
app.use(express.static(path.join(__dirname, 'public')));

// CORS for API calls
app.use(cors({
    origin: '*',
    credentials: true
}));

// Cookie session
app.use(session({
    name: 'session',
    keys: [process.env.SESSION_SECRET || 'fallbacksecret'],
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
        scope: 'identify'
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
        // 1️⃣ Exchange code for token
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

        // 3️⃣ BOT verifies guild membership
        const RGWO_ID = process.env.RGWO_GUILD_ID;

        await axios.get(
            `https://discord.com/api/guilds/${RGWO_ID}/members/${user.id}`,
            {
                headers: {
                    Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`
                }
            }
        );

        // 4️⃣ Save session
        req.session.user = {
            id: user.id,
            username: user.username,
            avatar: user.avatar
        };

        // 5️⃣ Redirect to dashboard
        res.redirect('/');

    } catch (err) {
        console.error(
            'Discord auth error:',
            err.response?.status,
            err.response?.data || err.message
        );

        res.redirect('/?error=not_member');
    }
});

        // Save user session
        req.session.user = {
            id: user.id,
            username: user.username,
            avatar: user.avatar,
            discriminator: user.discriminator,
            isMember: true
        };

        // Redirect to dashboard (index.html)
        res.redirect('/');

    } catch (err) {
        console.error('Discord Auth Error:', err.response ? err.response.data : err.message);
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


