const express = require('express');
const puppeteer = require('puppeteer-core');
const path = require('path');

// Find Chrome executable
function getChromePath() {
    const paths = [
        // Windows
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        process.env.CHROME_PATH,
        // Linux (for Render.com with Dockerfile)
        '/usr/bin/chromium',
        '/usr/bin/google-chrome'
    ];
    
    for (const p of paths) {
        if (p && require('fs').existsSync(p)) {
            return p;
        }
    }
    return null;
}

const app = express();
const PORT = process.env.PORT || 3000;

// Your Beamup addon URL (update this after deploying to Beamup)
const ADDON_BASE_URL = process.env.ADDON_URL || 'http://localhost:7000';

const ZAMUNDA_DOMAIN = 'zamunda.ch';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve the login form
app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`
<!DOCTYPE html>
<html lang="bg">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Zamunda Stremio Addon - Вход</title>
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
            background: rgba(255,255,255,0.1);
            backdrop-filter: blur(10px);
            border-radius: 20px;
            padding: 40px;
            max-width: 400px;
            width: 100%;
            box-shadow: 0 8px 32px rgba(0,0,0,0.3);
        }
        h1 {
            color: #fff;
            text-align: center;
            margin-bottom: 10px;
            font-size: 24px;
        }
        .subtitle {
            color: #aaa;
            text-align: center;
            margin-bottom: 30px;
            font-size: 14px;
        }
        .form-group {
            margin-bottom: 20px;
        }
        label {
            display: block;
            color: #ddd;
            margin-bottom: 8px;
            font-size: 14px;
        }
        input[type="text"], input[type="password"] {
            width: 100%;
            padding: 15px;
            border: none;
            border-radius: 10px;
            background: rgba(255,255,255,0.1);
            color: #fff;
            font-size: 16px;
            outline: none;
            transition: background 0.3s;
        }
        input:focus {
            background: rgba(255,255,255,0.2);
        }
        input::placeholder {
            color: #888;
        }
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
        button:hover {
            transform: translateY(-2px);
            box-shadow: 0 5px 20px rgba(102, 126, 234, 0.4);
        }
        button:disabled {
            opacity: 0.7;
            cursor: not-allowed;
            transform: none;
        }
        .loading {
            display: none;
            text-align: center;
            color: #fff;
            margin-top: 20px;
        }
        .loading.show { display: block; }
        .spinner {
            border: 3px solid rgba(255,255,255,0.3);
            border-top: 3px solid #fff;
            border-radius: 50%;
            width: 30px;
            height: 30px;
            animation: spin 1s linear infinite;
            margin: 0 auto 10px;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        .error {
            background: rgba(255,0,0,0.2);
            color: #ff6b6b;
            padding: 15px;
            border-radius: 10px;
            margin-bottom: 20px;
            display: none;
        }
        .error.show { display: block; }
        .info {
            color: #888;
            font-size: 12px;
            text-align: center;
            margin-top: 20px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎬 Zamunda Addon</h1>
        <p class="subtitle">Въведи данните си за Zamunda.ch</p>
        
        <div class="error" id="error"></div>
        
        <form id="loginForm" action="/login" method="POST">
            <div class="form-group">
                <label for="username">Потребителско име</label>
                <input type="text" id="username" name="username" placeholder="Username" required>
            </div>
            <div class="form-group">
                <label for="password">Парола</label>
                <input type="password" id="password" name="password" placeholder="Password" required>
            </div>
            <button type="submit" id="submitBtn">Генерирай линк за Stremio</button>
        </form>
        
        <div class="loading" id="loading">
            <div class="spinner"></div>
            <p>Влизане в Zamunda... Моля изчакай.</p>
            <p style="font-size: 12px; color: #888; margin-top: 10px;">Това може да отнеме до 30 секунди</p>
        </div>
        
        <p class="info">Данните ти се използват само за вход в Zamunda и не се съхраняват.</p>
    </div>
    
    <script>
        document.getElementById('loginForm').addEventListener('submit', function(e) {
            document.getElementById('submitBtn').disabled = true;
            document.getElementById('loading').classList.add('show');
            document.getElementById('error').classList.remove('show');
        });
    </script>
</body>
</html>
    `);
});

// Handle login
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.redirect('/?error=missing');
    }
    
    console.log(`[Auth] Login attempt for: ${username}`);
    
    let browser = null;
    
    try {
        // Launch browser
        const chromePath = getChromePath();
        if (!chromePath) {
            throw new Error('Chrome not found. Please install Chrome or set CHROME_PATH.');
        }
        
        console.log('[Auth] Using Chrome:', chromePath);
        
        browser = await puppeteer.launch({
            executablePath: chromePath,
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ]
        });
        
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        
        // Step 1: Go to login URL with credentials
        const loginUrl = `https://${ZAMUNDA_DOMAIN}/takelogin.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
        console.log(`[Auth] Navigating to login URL...`);
        
        await page.goto(loginUrl, { 
            waitUntil: 'networkidle2', 
            timeout: 60000 
        }).catch(() => {});
        
        // Wait for Cloudflare and login to complete
        console.log('[Auth] Waiting for Cloudflare/login...');
        
        let authCookies = null;
        
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 2000));
            
            const cookies = await page.cookies();
            const uid = cookies.find(c => c.name === 'uid');
            const pass = cookies.find(c => c.name === 'pass');
            
            if (uid && pass) {
                console.log('[Auth] Got auth cookies!');
                authCookies = { uid: uid.value, pass: pass.value };
                break;
            }
        }
        
        await browser.close();
        browser = null;
        
        if (!authCookies) {
            console.log('[Auth] Failed - no auth cookies received');
            return res.send(errorPage('Неуспешен вход. Провери потребителското име и паролата.'));
        }
        
        // Encode cookies for addon config
        const config = Buffer.from(JSON.stringify(authCookies)).toString('base64url');
        const addonUrl = `${ADDON_BASE_URL}/${config}/manifest.json`;
        const stremioUrl = addonUrl.replace(/^https?:/, 'stremio:');
        
        console.log(`[Auth] Success! Generated addon URL for ${username}`);
        
        // Return success page with install link
        res.send(successPage(addonUrl, stremioUrl));
        
    } catch (error) {
        console.error('[Auth] Error:', error.message);
        if (browser) await browser.close();
        res.send(errorPage('Възникна грешка. Моля опитай отново.'));
    }
});

function errorPage(message) {
    return `
<!DOCTYPE html>
<html lang="bg">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Грешка - Zamunda Addon</title>
    <style>
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
            background: rgba(255,255,255,0.1);
            backdrop-filter: blur(10px);
            border-radius: 20px;
            padding: 40px;
            max-width: 400px;
            width: 100%;
            text-align: center;
        }
        h1 { color: #ff6b6b; margin-bottom: 20px; }
        p { color: #fff; margin-bottom: 20px; }
        a {
            display: inline-block;
            padding: 15px 30px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: #fff;
            text-decoration: none;
            border-radius: 10px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>❌ Грешка</h1>
        <p>${message}</p>
        <a href="/">Опитай отново</a>
    </div>
</body>
</html>
    `;
}

function successPage(addonUrl, stremioUrl) {
    return `
<!DOCTYPE html>
<html lang="bg">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Готово! - Zamunda Addon</title>
    <style>
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
            background: rgba(255,255,255,0.1);
            backdrop-filter: blur(10px);
            border-radius: 20px;
            padding: 40px;
            max-width: 550px;
            width: 100%;
            text-align: center;
        }
        h1 { color: #4ade80; margin-bottom: 20px; }
        p { color: #fff; margin-bottom: 15px; }
        .copy-btn {
            display: inline-block;
            padding: 20px 40px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: #fff;
            border: none;
            border-radius: 15px;
            font-size: 18px;
            font-weight: bold;
            margin: 20px 0;
            cursor: pointer;
            transition: transform 0.2s;
            width: 100%;
        }
        .copy-btn:hover { transform: scale(1.02); }
        .url-box {
            background: rgba(0,0,0,0.3);
            padding: 15px;
            border-radius: 10px;
            margin: 15px 0;
            word-break: break-all;
            font-size: 11px;
            color: #aaa;
            user-select: all;
        }
        .steps {
            text-align: left;
            background: rgba(0,0,0,0.2);
            padding: 20px;
            border-radius: 10px;
            margin: 20px 0;
        }
        .steps li {
            color: #ddd;
            margin-bottom: 10px;
            font-size: 14px;
        }
        .info { color: #888; font-size: 12px; margin-top: 20px; }
        .success-badge {
            display: inline-block;
            background: rgba(74, 222, 128, 0.2);
            color: #4ade80;
            padding: 5px 15px;
            border-radius: 20px;
            font-size: 12px;
            margin-bottom: 15px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Готово!</h1>
        <div class="success-badge">Вход в Zamunda успешен</div>
        
        <div class="steps">
            <ol>
                <li>Копирай линка с бутона отдолу</li>
                <li>Отвори <strong>Stremio</strong></li>
                <li>Отиди в <strong>Addons</strong> (горе вдясно)</li>
                <li>Натисни <strong>Community Addons</strong></li>
                <li>В полето за търсене <strong>постави линка</strong></li>
                <li>Натисни <strong>Install</strong></li>
            </ol>
        </div>
        
        <button class="copy-btn" onclick="copyUrl()">Копирай линк за Stremio</button>
        
        <div class="url-box" id="urlBox">${addonUrl}</div>
        
        <p class="info">Линкът съдържа твоите данни за вход. Не го споделяй с други!</p>
    </div>
    
    <script>
        function copyUrl() {
            const url = '${addonUrl}';
            navigator.clipboard.writeText(url).then(() => {
                document.querySelector('.copy-btn').textContent = 'Копирано!';
                document.querySelector('.copy-btn').style.background = 'linear-gradient(135deg, #4ade80 0%, #22c55e 100%)';
                setTimeout(() => {
                    document.querySelector('.copy-btn').textContent = 'Копирай линк за Stremio';
                    document.querySelector('.copy-btn').style.background = '';
                }, 3000);
            });
        }
    </script>
</body>
</html>
    `;
}

app.listen(PORT, () => {
    console.log(`
🔐 Zamunda Auth Server
   Running on http://localhost:${PORT}
   Addon URL: ${ADDON_BASE_URL}
    `);
});
