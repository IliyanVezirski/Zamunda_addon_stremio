const axios = require('axios');

const WORKER_URL = process.env.WORKER_URL || 'https://zamunda-proxy.ilian-vezirski.workers.dev';

// Session cache: username -> { uid, pass, timestamp }
const sessionCache = new Map();
const SESSION_TTL = 12 * 60 * 60 * 1000; // 12 hours

/**
 * Login to Zamunda through the Cloudflare Worker
 * Returns { uid, pass } cookies
 */
async function login(username, password, forceRefresh = false) {
    // Check cache
    if (!forceRefresh) {
        const cached = sessionCache.get(username);
        if (cached && (Date.now() - cached.timestamp < SESSION_TTL)) {
            console.log(`[Session] Using cached session for ${username} (uid=${cached.uid})`);
            return { uid: cached.uid, pass: cached.pass };
        }
    }

    console.log(`[Session] Logging in as ${username}...`);

    const url = `${WORKER_URL}/login?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;

    let data;
    try {
        const response = await axios.get(url, {
            timeout: 30000,
            headers: { 'Accept': 'application/json' },
            validateStatus: () => true // Don't throw on non-2xx
        });

        console.log(`[Session] Worker response status: ${response.status}`);
        data = response.data;

        // If response is a string (HTML error page), parse it
        if (typeof data === 'string') {
            try { data = JSON.parse(data); } catch (e) {
                console.error(`[Session] Non-JSON response (${response.status}):`, data.substring(0, 300));
                throw new Error(`Worker returned non-JSON response (status ${response.status})`);
            }
        }
    } catch (e) {
        if (e.message.includes('Worker returned')) throw e;
        console.error(`[Session] Worker request failed:`, e.message);
        throw new Error(`Cannot reach login worker: ${e.message}`);
    }

    if (data.error) {
        console.error(`[Session] Login failed:`, data.error);
        if (data.debug) console.log(`[Session] Debug:`, JSON.stringify(data.debug));
        throw new Error(`Login failed: ${data.error}`);
    }

    if (!data.uid || !data.pass) {
        console.error(`[Session] No cookies in response:`, JSON.stringify(data));
        throw new Error('Login failed: no session cookies received');
    }

    // Cache the session
    sessionCache.set(username, {
        uid: data.uid,
        pass: data.pass,
        timestamp: Date.now()
    });

    console.log(`[Session] Login successful! uid=${data.uid}`);
    return { uid: data.uid, pass: data.pass };
}

/**
 * Clear cached session (call on auth errors to force re-login)
 */
function clearSession(username) {
    sessionCache.delete(username);
    console.log(`[Session] Cleared cache for ${username}`);
}

/**
 * Create HTTP client that routes through Cloudflare Worker
 */
function createClient(uid, pass) {
    const cookies = `uid=${uid}; pass=${pass}`;

    return {
        async get(path) {
            const url = `${WORKER_URL}/?path=${encodeURIComponent(path)}&cookies=${encodeURIComponent(cookies)}`;
            console.log(`[Client] GET ${path}`);

            const response = await axios.get(url, {
                timeout: 20000,
                headers: {
                    'Accept': 'text/html'
                }
            });

            return response;
        }
    };
}

module.exports = { login, clearSession, createClient, WORKER_URL };
