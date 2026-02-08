const express = require('express');
const cors = require('cors');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');

const { getStreams } = require('./lib/zamundaService');
const { getMetaFromImdb, parseSeriesId, formatEpisode, sanitizeSearchQuery } = require('./lib/utils');

const WORKER_URL = process.env.WORKER_URL || 'https://zamunda-proxy.ilian-vezirski.workers.dev';

const manifest = {
    id: 'org.zamunda.stremio.addon',
    version: '1.3.0',
    name: 'Zamunda',
    description: 'Торенти от Zamunda.ch за Stremio | Donate: buymeacoffee.com/Bgsubs',
    logo: `${process.env.RENDER_EXTERNAL_URL || 'https://zamunda-addon-stremio.onrender.com'}/logo.png`,
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    config: [
        {
            key: 'uid',
            type: 'text',
            title: 'UID'
        },
        {
            key: 'pass',
            type: 'text',
            title: 'Pass'
        }
    ],
    behaviorHints: {
        configurable: true,
        configurationRequired: true
    }
};

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id, config }) => {
    console.log(`[Stream] type=${type} id=${id}`);

    const uid = config?.uid;
    const pass = config?.pass;

    if (!uid || !pass) {
        console.log('[Stream] Missing cookies in config');
        return { streams: [] };
    }

    try {
        let searchQuery = '';
        let meta = null;

        if (type === 'movie') {
            meta = await getMetaFromImdb('movie', id);
            if (!meta) return { streams: [] };
            searchQuery = meta.name;
            if (meta.year) searchQuery += ` ${meta.year}`;
        } else if (type === 'series') {
            const seriesInfo = parseSeriesId(id);
            if (!seriesInfo) return { streams: [] };
            meta = await getMetaFromImdb('series', seriesInfo.imdbId);
            if (!meta) return { streams: [] };
            searchQuery = `${meta.name} ${formatEpisode(seriesInfo.season, seriesInfo.episode)}`;
        } else {
            return { streams: [] };
        }

        console.log(`[Stream] Search: "${searchQuery}"`);
        searchQuery = sanitizeSearchQuery(searchQuery);

        let streams = await getStreams(uid, pass, searchQuery, type);

        if (streams.length === 0 && type === 'movie' && meta?.year) {
            console.log('[Stream] Retrying without year...');
            streams = await getStreams(uid, pass, sanitizeSearchQuery(meta.name), type);
        }

        if (streams.length === 0 && type === 'series') {
            const si = parseSeriesId(id);
            if (si) {
                console.log('[Stream] Retrying with season search...');
                streams = await getStreams(uid, pass, sanitizeSearchQuery(`${meta.name} Season ${si.season}`), type);
            }
        }

        console.log(`[Stream] Found ${streams.length} streams`);
        return { streams };
    } catch (error) {
        console.error(`[Stream] Error:`, error.message);
        return { streams: [] };
    }
});

// Build Express app with custom configure page
const app = express();
app.use(cors());

// Custom configure page - login happens in the USER's browser
app.get('/configure', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(getConfigurePage());
});

app.get('/', (req, res) => {
    res.redirect('/configure');
});

// Serve manifest.json so Stremio can discover the addon
// Stremio will see configurationRequired and show a Configure button
// which opens /configure in the browser for login
app.get('/manifest.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(manifest));
});

// Serve Zamunda logo (proxied through Worker)
const axios = require('axios');
let logoCache = null;
app.get('/logo.png', async (req, res) => {
    try {
        if (!logoCache) {
            const response = await axios.get(`${WORKER_URL}/?path=${encodeURIComponent('/pic/logo.png')}&cookies=none`, {
                responseType: 'arraybuffer',
                timeout: 15000
            });
            logoCache = Buffer.from(response.data);
        }
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=604800');
        res.end(logoCache);
    } catch (e) {
        res.status(404).end();
    }
});

// Mount the SDK router (handles /:config/manifest.json and /:config/stream/...)
const addonInterface = builder.getInterface();
app.use(getRouter(addonInterface));

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => {
    console.log(`HTTP addon accessible at: http://127.0.0.1:${PORT}/manifest.json`);
    console.log(`Configure page: http://127.0.0.1:${PORT}/configure`);
});

function getConfigurePage() {
    const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    return `<!DOCTYPE html>
<html lang="bg">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Zamunda Stremio Addon</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            background: rgba(255,255,255,0.08);
            backdrop-filter: blur(10px);
            border-radius: 20px;
            padding: 40px;
            max-width: 420px;
            width: 100%;
            box-shadow: 0 8px 32px rgba(0,0,0,0.3);
        }
        .logo { text-align: center; margin-bottom: 10px; }
        .logo img { width: 80px; height: 80px; border-radius: 16px; }
        h1 { color: #fff; text-align: center; margin-bottom: 5px; font-size: 22px; }
        .subtitle { color: #aaa; text-align: center; margin-bottom: 25px; font-size: 13px; }
        .form-group { margin-bottom: 18px; }
        label { display: block; color: #ddd; margin-bottom: 6px; font-size: 14px; }
        input[type="text"], input[type="password"] {
            width: 100%;
            padding: 14px;
            border: 1px solid rgba(255,255,255,0.15);
            border-radius: 10px;
            background: rgba(255,255,255,0.08);
            color: #fff;
            font-size: 15px;
            outline: none;
            transition: border 0.3s;
        }
        input:focus { border-color: rgba(102, 126, 234, 0.6); }
        input::placeholder { color: #666; }
        button {
            width: 100%;
            padding: 15px;
            border: none;
            border-radius: 10px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: #fff;
            font-size: 16px;
            font-weight: bold;
            cursor: pointer;
            transition: transform 0.2s, box-shadow 0.2s;
        }
        button:hover { transform: translateY(-2px); box-shadow: 0 5px 20px rgba(102, 126, 234, 0.4); }
        button:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }
        .status { margin-top: 18px; padding: 14px; border-radius: 10px; display: none; font-size: 13px; text-align: center; }
        .status.loading { display: block; background: rgba(102, 126, 234, 0.2); color: #a5b4fc; }
        .status.error { display: block; background: rgba(255, 0, 0, 0.15); color: #ff6b6b; }
        .status.success { display: block; background: rgba(74, 222, 128, 0.15); color: #4ade80; }
        .install-section { display: none; margin-top: 20px; text-align: center; }
        .install-btn {
            display: inline-block;
            padding: 16px 30px;
            background: linear-gradient(135deg, #4ade80 0%, #22c55e 100%);
            color: #fff;
            text-decoration: none;
            border-radius: 12px;
            font-size: 16px;
            font-weight: bold;
            margin: 10px 0;
            transition: transform 0.2s;
        }
        .install-btn:hover { transform: translateY(-2px); }
        .info { color: #666; font-size: 11px; text-align: center; margin-top: 15px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="logo"><img src="/logo.png" alt="Zamunda"></div>
        <h1>Zamunda Addon</h1>
        <p class="subtitle">Торенти от Zamunda.ch за Stremio</p>
        
        <div id="loginForm">
            <div class="form-group">
                <label>Потребителско име</label>
                <input type="text" id="username" placeholder="Username" autocomplete="username">
            </div>
            <div class="form-group">
                <label>Парола</label>
                <input type="password" id="password" placeholder="Password" autocomplete="current-password">
            </div>
            <button id="loginBtn" onclick="doLogin()">Вход и инсталация</button>
        </div>
        
        <div class="status" id="status"></div>
        
        <div class="install-section" id="installSection">
            <a class="install-btn" id="installLink" href="#">Инсталирай в Stremio</a>
            <p style="color: #aaa; margin-top: 12px; font-size: 12px;">
                Или копирай линка:<br>
                <input type="text" id="manifestUrl" readonly onclick="this.select()" 
                    style="margin-top: 8px; background: rgba(0,0,0,0.3); border: none; color: #aaa; font-size: 11px; padding: 10px; width: 100%; cursor: pointer;">
            </p>
        </div>
        
        <p class="info">Данните се използват само за вход и не се съхраняват на сървъра.</p>
        <a href="https://buymeacoffee.com/Bgsubs" target="_blank" style="display:block; text-align:center; margin-top:18px; padding:12px 20px; background:linear-gradient(135deg,#ffdd00 0%,#f5a623 100%); color:#1a1a2e; text-decoration:none; border-radius:10px; font-weight:bold; font-size:14px; transition:transform 0.2s;" onmouseover="this.style.transform='translateY(-2px)'" onmouseout="this.style.transform=''">☕ Buy me a coffee</a>
    </div>

    <script>
        const WORKER_URL = '${WORKER_URL}';
        const BASE_URL = '${baseUrl}';
        
        async function doLogin() {
            const username = document.getElementById('username').value.trim();
            const password = document.getElementById('password').value.trim();
            
            if (!username || !password) {
                showStatus('Въведи потребителско име и парола', 'error');
                return;
            }
            
            const btn = document.getElementById('loginBtn');
            btn.disabled = true;
            btn.textContent = 'Вход...';
            showStatus('Влизане в Zamunda... Моля изчакай.', 'loading');
            
            try {
                const loginUrl = WORKER_URL + '/login?username=' + encodeURIComponent(username) + '&password=' + encodeURIComponent(password);
                const response = await fetch(loginUrl);
                const data = await response.json();
                
                if (data.uid && data.pass) {
                    showStatus('Успешен вход!', 'success');
                    
                    const config = encodeURIComponent(JSON.stringify({ uid: data.uid, pass: data.pass }));
                    const manifestUrl = BASE_URL + '/' + config + '/manifest.json';
                    const stremioUrl = 'stremio://' + manifestUrl.replace(/^https?:\\/\\//, '') ;
                    
                    document.getElementById('installLink').href = stremioUrl;
                    document.getElementById('manifestUrl').value = manifestUrl;
                    document.getElementById('installSection').style.display = 'block';
                    document.getElementById('loginForm').style.display = 'none';
                } else {
                    showStatus('Грешно потребителско име или парола. ' + (data.error || ''), 'error');
                    btn.disabled = false;
                    btn.textContent = 'Вход и инсталация';
                }
            } catch (e) {
                showStatus('Грешка: ' + e.message, 'error');
                btn.disabled = false;
                btn.textContent = 'Вход и инсталация';
            }
        }
        
        function showStatus(msg, type) {
            const el = document.getElementById('status');
            el.textContent = msg;
            el.className = 'status ' + type;
        }
        
        // Allow Enter key to submit
        document.getElementById('password').addEventListener('keypress', function(e) {
            if (e.key === 'Enter') doLogin();
        });
    </script>
</body>
</html>`;
}
