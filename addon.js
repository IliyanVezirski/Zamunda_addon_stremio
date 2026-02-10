const express = require('express');
const cors = require('cors');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');

// const { getStreams: getZamundaStreams } = require('./lib/zamundaService'); // zamunda.ch — не работи в момента
const { getStreams: getRipStreams } = require('./lib/zamundaRipService');
const { getStreams: getAxelStreams } = require('./lib/axelService');
const { getMetaFromImdb, parseSeriesId, formatEpisode, sanitizeSearchQuery } = require('./lib/utils');

const manifest = {
    id: 'org.zamunda.stremio.addon',
    version: '2.2.2',
    name: 'BGTorrents',
    description: 'Торенти от Zamunda.rip + AXELbg за Stremio. Използването е на ваша отговорност.',
    // КЛЮЧЪТ: Това добавя кликаем бутон "Help" или "Donate" в Stremio
    helpUrl: 'https://www.buymeacoffee.com/Bgsubs', 
    logo: `${process.env.RENDER_EXTERNAL_URL || 'https://zamunda-addon-stremio.onrender.com'}/static/logo.png`,
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    config: [
        {
            key: 'providers',
            type: 'text',
            title: 'Източници (rip,axel)'
        },
        {
            key: 'axel_uid',
            type: 'text',
            title: 'AXELbg UID'
        },
        {
            key: 'axel_pass',
            type: 'text',
            title: 'AXELbg Pass'
        }
    ],
    behaviorHints: {
        configurable: true,
        configurationRequired: false
    }
};

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id, config }) => {
    console.log(`[Stream] type=${type} id=${id}`);

    // Providers: from config URL or env vars
    const enabledProviders = (config?.providers || process.env.PROVIDERS || 'rip').split(',').map(s => s.trim());
    const useRip = enabledProviders.includes('rip');
    const axelUid = config?.axel_uid || process.env.AXEL_UID || '';
    const axelPass = config?.axel_pass || process.env.AXEL_PASS || '';
    const useAxel = enabledProviders.includes('axel') && axelUid && axelPass;

    try {
        let searchQuery = '';
        let meta = null;
        let imdbId = id;

        if (type === 'movie') {
            meta = await getMetaFromImdb('movie', id);
            if (!meta) return { streams: [] };
            searchQuery = meta.name;
            if (meta.year) searchQuery += ` ${meta.year}`;
            imdbId = id;
        } else if (type === 'series') {
            const seriesInfo = parseSeriesId(id);
            if (!seriesInfo) return { streams: [] };
            meta = await getMetaFromImdb('series', seriesInfo.imdbId);
            if (!meta) return { streams: [] };
            searchQuery = `${meta.name} ${formatEpisode(seriesInfo.season, seriesInfo.episode)}`;
            imdbId = seriesInfo.imdbId;
        } else {
            return { streams: [] };
        }

        console.log(`[Stream] Search: "${searchQuery}"`);
        searchQuery = sanitizeSearchQuery(searchQuery);

        const filter = { name: meta.name, year: meta.year || null };
        if (type === 'series') {
            const si = parseSeriesId(id);
            if (si) {
                filter.season = si.season;
                filter.episode = si.episode;
            }
        }

        // Run enabled providers in parallel
        const promises = [];

        // 1. Zamunda.rip (no login needed)
        if (useRip) {
            promises.push(
                (async () => {
                    let streams = await getRipStreams(searchQuery, type, filter);
                    if (streams.length === 0 && type === 'movie' && meta?.year) {
                        streams = await getRipStreams(sanitizeSearchQuery(meta.name), type, filter);
                    }
                    if (streams.length === 0 && type === 'series') {
                        const si = parseSeriesId(id);
                        if (si) streams = await getRipStreams(sanitizeSearchQuery(`${meta.name} Season ${si.season}`), type, filter);
                    }
                    return streams;
                })().catch(e => { console.error('[Stream] Rip error:', e.message); return []; })
            );
        }

        // 2. AXELbg (needs credentials)
        if (useAxel) {
            promises.push(
                getAxelStreams(axelUid, axelPass, imdbId, type, filter)
                    .catch(e => { console.error('[Stream] Axel error:', e.message); return []; })
            );
        }

        const results = await Promise.all(promises);
        const streams = results.flat();

        // Deduplicate by infoHash
        const seen = new Set();
        const unique = streams.filter(s => {
            if (seen.has(s.infoHash)) return false;
            seen.add(s.infoHash);
            return true;
        });

        console.log(`[Stream] Found ${unique.length} streams (${results[0]?.length || 0} rip + ${results[1]?.length || 0} axel)`);
        return { streams: unique };
    } catch (error) {
        console.error(`[Stream] Error:`, error.message);
        return { streams: [] };
    }
});

// Build Express app with custom configure page
const app = express();
app.use(cors());
app.use(express.json());

// AXELbg login endpoint — direct POST from Render server
app.post('/api/axel-login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.json({ error: 'Missing username or password' });
    }
    try {
        const axios = require('axios');
        const loginRes = await axios.post('https://axelbg.net/takelogin.php',
            `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
            },
            maxRedirects: 0,
            validateStatus: s => s >= 200 && s < 400,
            timeout: 15000
        });
        const cookies = loginRes.headers['set-cookie'] || [];
        let uid = '', pass = '';
        for (const c of cookies) {
            const u = c.match(/uid=(\d+)/);
            const p = c.match(/pass=([a-f0-9]{32})/);
            if (u) uid = u[1];
            if (p) pass = p[1];
        }
        if (uid && pass) {
            console.log(`[Axel Login] Success: uid=${uid}`);
            res.json({ uid, pass });
        } else {
            console.log('[Axel Login] Failed — no cookies');
            res.json({ error: 'Грешно потребителско име или парола' });
        }
    } catch (e) {
        console.error('[Axel Login] Error:', e.message);
        res.json({ error: e.message });
    }
});

// Custom configure page
app.get('/configure', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(getConfigurePage());
});

app.get('/', (req, res) => {
    res.redirect('/configure');
});

app.get('/manifest.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(manifest));
});

// Serve static files (logo)
app.use('/static', express.static('static'));

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
    <title>BGTorrents Stremio Addon</title>
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
        <div class="logo"><img src="/static/logo.png" alt="BGTorrents"></div>
        <h1>BGTorrents Addon</h1>
        <p class="subtitle">BG \u0442\u043e\u0440\u0435\u043d\u0442\u0438 \u0437\u0430 Stremio</p>
        
        <div id="configForm">
            <p style="color: #ccc; margin-bottom: 16px; font-size: 13px;">\u0418\u0437\u0431\u0435\u0440\u0438 \u0438\u0437\u0442\u043e\u0447\u043d\u0438\u0446\u0438:</p>
            
            <label style="display:flex; align-items:center; gap:10px; padding:12px; background:rgba(255,255,255,0.05); border-radius:10px; margin-bottom:10px; cursor:pointer;">
                <input type="checkbox" id="cbRip" checked style="width:18px; height:18px; accent-color:#667eea;">
                <div>
                    <span style="color:#fff; font-weight:bold;">Zamunda.rip</span>
                    <span style="color:#4ade80; font-size:12px; margin-left:6px;">\u0431\u0435\u0437 \u043b\u043e\u0433\u0438\u043d</span>
                    <br><span style="color:#888; font-size:11px;">\u0410\u0440\u0445\u0438\u0432 \u043d\u0430 Zamunda + ArenaBG (400k+ \u0442\u043e\u0440\u0435\u043d\u0442\u0430)</span>
                </div>
            </label>
            
            <label style="display:flex; align-items:center; gap:10px; padding:12px; background:rgba(255,255,255,0.05); border-radius:10px; margin-bottom:10px; cursor:pointer;">
                <input type="checkbox" id="cbAxel" onchange="toggleAxelFields()" style="width:18px; height:18px; accent-color:#667eea;">
                <div>
                    <span style="color:#fff; font-weight:bold;">AXELbg.net</span>
                    <span style="color:#f5a623; font-size:12px; margin-left:6px;">\u0438\u0437\u0438\u0441\u043a\u0432\u0430 \u0430\u043a\u0430\u0443\u043d\u0442</span>
                    <br><span style="color:#888; font-size:11px;">\u0411\u044a\u043b\u0433\u0430\u0440\u0441\u043a\u0438 \u0442\u0440\u0430\u043a\u0435\u0440 \u0441 \u0430\u043a\u0442\u0438\u0432\u043d\u0438 seeders</span>
                </div>
            </label>
            
            <div id="axelFields" style="display:none; margin-bottom:14px; padding-left:28px;">
                <div class="form-group">
                <label for="axelUsername" style="display:block; margin-bottom:5px; font-weight:500;">Потребителско име:</label>
            <input type="text" id="axelUsername" placeholder="username" style="width:100%; padding:10px; border:1px solid #444; border-radius:6px; background:#2a2a3e; color:#fff; font-size:14px; margin-bottom:12px;">
            
            <label for="axelPassword" style="display:block; margin-bottom:5px; font-weight:500;">Парола:</label>
            <input type="password" id="axelPassword" placeholder="••••••••" style="width:100%; padding:10px; border:1px solid #444; border-radius:6px; background:#2a2a3e; color:#fff; font-size:14px;">
                </div>
            </div>
            
            <label style="display:flex; align-items:center; gap:10px; padding:12px; background:rgba(255,255,255,0.03); border-radius:10px; margin-bottom:14px; cursor:not-allowed; opacity:0.4;">
                <input type="checkbox" disabled style="width:18px; height:18px;">
                <div>
                    <span style="color:#888; font-weight:bold;">Zamunda.ch</span>
                    <span style="color:#ff6b6b; font-size:12px; margin-left:6px;">\u26a0\ufe0f \u041d\u0415 \u0420\u0410\u0411\u041e\u0422\u0418</span>
                    <br><span style="color:#666; font-size:11px;">\u0429\u0435 \u0431\u044a\u0434\u0435 \u0432\u044a\u0437\u0441\u0442\u0430\u043d\u043e\u0432\u0435\u043d \u043a\u043e\u0433\u0430\u0442\u043e \u0441\u044a\u0440\u0432\u044a\u0440\u044a\u0442 \u0437\u0430\u0440\u0430\u0431\u043e\u0442\u0438</span>
                </div>
            </label>
            
            <button id="installBtn" onclick="doInstall()">\u0412\u0445\u043e\u0434 \u0438 \u0438\u043d\u0441\u0442\u0430\u043b\u0430\u0446\u0438\u044f</button>
        </div>

        <div class="status" id="status"></div>
        
        <div class="install-section" id="installSection">
            <a class="install-btn" id="installLink" href="#">\u0418\u043d\u0441\u0442\u0430\u043b\u0438\u0440\u0430\u0439 \u0432 Stremio</a>
            <p style="color: #aaa; margin-top: 12px; font-size: 12px;">
                \u0418\u043b\u0438 \u043a\u043e\u043f\u0438\u0440\u0430\u0439 \u043b\u0438\u043d\u043a\u0430:<br>
                <input type="text" id="manifestUrl" readonly onclick="this.select()" 
                    style="margin-top: 8px; background: rgba(0,0,0,0.3); border: none; color: #aaa; font-size: 11px; padding: 10px; width: 100%; cursor: pointer;">
            </p>
        </div>
        
        <p class="info">\u0414\u0430\u043d\u043d\u0438\u0442\u0435 \u0441\u0435 \u0438\u0437\u043f\u043e\u043b\u0437\u0432\u0430\u0442 \u0441\u0430\u043c\u043e \u0437\u0430 \u0432\u0445\u043e\u0434 \u0438 \u043d\u0435 \u0441\u0435 \u0441\u044a\u0445\u0440\u0430\u043d\u044f\u0432\u0430\u0442 \u043d\u0430 \u0441\u044a\u0440\u0432\u044a\u0440\u0430.</p>
        <a href="https://buymeacoffee.com/Bgsubs" target="_blank" style="display:block; text-align:center; margin-top:18px; padding:12px 20px; background:linear-gradient(135deg,#ffdd00 0%,#f5a623 100%); color:#1a1a2e; text-decoration:none; border-radius:10px; font-weight:bold; font-size:14px; transition:transform 0.2s;" onmouseover="this.style.transform='translateY(-2px)'" onmouseout="this.style.transform=''">\u2615 \u041f\u043e\u0434\u043a\u0440\u0435\u043f\u0435\u0442\u0435 \u043f\u0440\u043e\u0435\u043a\u0442\u0430</a>
    </div>

    <script>
        const BASE_URL = '${baseUrl}';
        
        function toggleAxelFields() {
            document.getElementById('axelFields').style.display = 
                document.getElementById('cbAxel').checked ? 'block' : 'none';
        }
        
        function showStatus(msg, type) {
            const el = document.getElementById('status');
            el.textContent = msg;
            el.className = 'status ' + type;
        }
        
        async function doInstall() {
            const providers = [];
            if (document.getElementById('cbRip').checked) providers.push('rip');
            if (document.getElementById('cbAxel').checked) providers.push('axel');
            
            if (providers.length === 0) {
                showStatus('\u0418\u0437\u0431\u0435\u0440\u0438 \u043f\u043e\u043d\u0435 \u0435\u0434\u0438\u043d \u0438\u0437\u0442\u043e\u0447\u043d\u0438\u043a!', 'error');
                return;
            }
            
            const cfg = { providers: providers.join(',') };
            const btn = document.getElementById('installBtn');
            
            // If AXELbg is checked, login to get cookies
            if (providers.includes('axel')) {
                const username = document.getElementById('axelUsername').value.trim();
                const password = document.getElementById('axelPassword').value.trim();
                if (!username || !password) {
                    showStatus('Въведи потребителско име и парола за AXELbg!', 'error');
                    return;
                }
                
                btn.disabled = true;
                btn.textContent = 'Вход...';
                showStatus('Влизане в AXELbg... Моля изчакай.', 'loading');
                
                try {
                    const res = await fetch(BASE_URL + '/api/axel-login', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username, password })
                    });
                    const data = await res.json();
                    
                    if (data.uid && data.pass) {
                        showStatus('Успешен вход в AXELbg!', 'success');
                        cfg.axel_uid = data.uid;
                        cfg.axel_pass = data.pass;
                    } else {
                        showStatus(data.error || 'Грешно име или парола', 'error');
                        btn.disabled = false;
                        btn.textContent = 'Вход и инсталация';
                        return;
                    }
                } catch (e) {
                    showStatus('Грешка: ' + e.message, 'error');
                    btn.disabled = false;
                    btn.textContent = 'Вход и инсталация';
                    return;
                }
            }
            
            const config = encodeURIComponent(JSON.stringify(cfg));
            const manifestUrl = BASE_URL + '/' + config + '/manifest.json';
            const stremioUrl = 'stremio://' + manifestUrl.replace(/^https?:\\/\\//, '');
            
            document.getElementById('installLink').href = stremioUrl;
            document.getElementById('manifestUrl').value = manifestUrl;
            document.getElementById('installSection').style.display = 'block';
            document.getElementById('configForm').style.display = 'none';
        }
        
        // Enter key submits
        document.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') doInstall();
        });
    </script>
</body>
</html>`;
}
