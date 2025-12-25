require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const axios = require('axios');

const app = express();

// --- 1. CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_CALLBACK_URL = process.env.DISCORD_CALLBACK_URL || 'http://localhost:3000/auth/discord/callback';
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK;

// --- 2. DISCORD AUTHENTICATION ---
passport.use(new DiscordStrategy({
    clientID: DISCORD_CLIENT_ID,
    clientSecret: DISCORD_CLIENT_SECRET,
    callbackURL: DISCORD_CALLBACK_URL,
    scope: ['identify']
}, (accessToken, refreshToken, profile, done) => {
    return done(null, profile);
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

app.use(express.json());
app.use(session({
    secret: 'union_secret_session_key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } 
}));
app.use(passport.initialize());
app.use(passport.session());

// --- 3. SERVE THE HTML ---
app.use(express.static('public'));

// --- 4. ROUTES ---

// Check User Status (Returns Mock Data)
app.get('/api/me', (req, res) => {
    if (req.isAuthenticated()) {
        res.json({ 
            loggedIn: true, 
            user: {
                username: req.user.username,
                discriminator: req.user.discriminator,
                avatar: req.user.avatar,
                id: req.user.id
            }
        });
    } else {
        res.json({ loggedIn: false });
    }
});

// Discord Login Routes
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', 
    passport.authenticate('discord', { failureRedirect: '/' }),
    (req, res) => {
        res.redirect('/');
    }
);

app.get('/logout', (req, res) => {
    req.logout(() => {
        res.redirect('/');
    });
});

// Submit Loan Request
app.post('/submit-loan', async (req, res) => {
    const { name, badge, amount, reason } = req.body;

    if (amount > 40000) {
        return res.json({ success: false, message: 'Amount exceeds SRD 40,000 limit' });
    }

    const discordMsg = {
        content: `🆕 **NEW LOAN REQUEST**
👤 **Name:** ${name}
🆔 **Badge:** ${badge}
💰 **Requesting:** SRD ${amount}
📝 **Reason:** ${reason}`
    };

    try {
        // NOTE: If DISCORD_WEBHOOK is 'placeholder', this will fail.
        // But we just want the app to RUN for now.
        await axios.post(DISCORD_WEBHOOK_URL, discordMsg);
        res.json({ success: true, message: 'Sent to Discord' });
    } catch (err) {
        console.error("Discord Error:", err);
        res.status(500).json({ success: false, message: 'Discord Error' });
    }
});

// --- 5. START SERVER ---
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});