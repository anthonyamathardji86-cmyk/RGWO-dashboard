require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const session = require('cookie-session');

const app = express();

// 1. CONFIGURATION
// ---------------------------------------------------------
// Use APP_URL if set (Render), otherwise fallback to localhost
const BASE_URL = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
const PORT = process.env.PORT || 3000;

console.log(`Running on: ${BASE_URL}`);

// 2. MIDDLEWARE
// ---------------------------------------------------------
// Serve static files from 'public' folder (index.html)
app.use(express.static('public'));

app.use(cors({
    origin: '*',
    credentials: true
}));

// Cookie Session setup
app.use(session({
    name: 'session',
    keys: [process.env.SESSION_SECRET],
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
}));

// 3. DISCORD LOGIN REDIRECT
// ---------------------------------------------------------
app.get('/auth/discord/login', (req, res) => {
    const params = new URLSearchParams({
        client_id: process.env.CLIENT_ID,
        redirect_uri: `${BASE_URL}/auth/discord/callback`, // Uses dynamic URL
        response_type: 'code',
        scope: 'identify guilds'
    });
    res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
});

// 4. DISCORD CALLBACK (VERIFY USER & CHECK GUILD)
// ---------------------------------------------------------
app.get('/auth/discord/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.redirect('/?error=no_code');

    try {
        // A. Exchange code for access token
        const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
            client_id: process.env.CLIENT_ID,
            client_secret: process.env.CLIENT_SECRET,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: `${BASE_URL}/auth/discord/callback` // Uses dynamic URL
        }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const { access_token } = tokenResponse.data;

        // B. Get User Info
        const userResponse = await axios.get('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${access_token}` }
        });

        const user = userResponse.data;

        // C. Get User's Guilds (Check if they are in RGWO Server)
        const guildsResponse = await axios.get('https://discord.com/api/users/@me/guilds', {
            headers: { Authorization: `Bearer ${access_token}` }
        });

        const guilds = guildsResponse.data;
        const RGWO_ID = process.env.RGWO_GUILD_ID; 
        
        // Check if user is a member of specific RGWO guild
        const isMember = guilds.some(g => g.id === RGWO_ID);

        if (!isMember) {
            return res.redirect('/?error=not_member');
        }

        // D. Save User to Session
        req.session.user = {
            id: user.id,
            username: user.username,
            avatar: user.avatar,
            discriminator: user.discriminator,
            isMember: true
        };

        // E. Redirect to Dashboard (Index)
        // This works because 'index.html' is in the 'public' folder
        res.redirect('/');

    } catch (error) {
        console.error('Auth Error:', error.response ? error.response.data : error.message);
        res.redirect('/?error=auth_failed');
    }
});

// 5. API: GET CURRENT USER
// ---------------------------------------------------------
app.get('/api/me', (req, res) => {
    if (req.session.user) {
        res.json(req.session.user);
    } else {
        res.status(401).json({ error: 'Not logged in' });
    }
});

// 6. API: LOGOUT
// ---------------------------------------------------------
app.post('/api/logout', (req, res) => {
    req.session = null;
    res.status(200).json({ success: true });
});

// 7. START SERVER
// ---------------------------------------------------------
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
