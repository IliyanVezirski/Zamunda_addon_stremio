const puppeteer = require('puppeteer-core');
const axios = require('axios');
const fs = require('fs');

const ZAMUNDA_URL = 'https://zamunda.ch';

// Cookie cache: username -> { uid, pass, time }
const cookieCache = new Map();
const CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours

// Find Chrome/Chromium path
function getChromePath() {
    const paths = [
        process.env.CHROME_PATH,
        process.env.PUPPETEER_EXECUTABLE_PATH,
        // Linux (Render.com / Docker)
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        // Windows
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        // Mac
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    ];

    for (const p of paths) {
        if (p && fs.existsSync(p)) return p;
    }
    return null;
}

/**
 * Login to Zamunda via Puppeteer and return uid+pass cookies
 */
async function login(username, password) {
    const chromePath = getChromePath();
    if (!chromePath) throw new Error('Chrome/Chromium not found');

    console.log(`[Login] ${username} via ${chromePath}`);

    const browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-extensions'
        ]
    });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });

        // Go to login URL with credentials
        const loginUrl = `${ZAMUNDA_URL}/takelogin.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
        await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});

        // Wait for Cloudflare + login to complete
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 2000));
            const cookies = await page.cookies();
            const uid = cookies.find(c => c.name === 'uid');
            const pass = cookies.find(c => c.name === 'pass');

            if (uid && pass) {
                console.log(`[Login] Success for ${username}`);
                await browser.close();
                return { uid: uid.value, pass: pass.value };
            }
        }

        await browser.close();
        throw new Error('Login timeout - no auth cookies');
    } catch (e) {
        await browser.close().catch(() => {});
        throw e;
    }
}

/**
 * Get cached cookies or login fresh
 */
async function getSession(username, password) {
    const cached = cookieCache.get(username);
    if (cached && (Date.now() - cached.time) < CACHE_TTL) {
        return cached;
    }

    const result = await login(username, password);
    const entry = { ...result, time: Date.now() };
    cookieCache.set(username, entry);
    return entry;
}

/**
 * Create axios client with auth cookies
 */
function createClient(uid, pass) {
    return axios.create({
        baseURL: ZAMUNDA_URL,
        headers: {
            'Cookie': `uid=${uid}; pass=${pass}`,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html',
            'Referer': ZAMUNDA_URL
        },
        timeout: 15000
    });
}

module.exports = { getSession, createClient, ZAMUNDA_URL };
