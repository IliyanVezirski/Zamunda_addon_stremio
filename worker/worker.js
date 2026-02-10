/**
 * Cloudflare Worker — Universal proxy for Zamunda.ch and AXELbg.net
 * 
 * Usage:
 *   GET /?path=/browse.php&cookies=uid=123;pass=abc                     → proxies to zamunda.ch (default)
 *   GET /?target=axelbg.net&path=/browse.php?search=tt123&cookies=...   → proxies to axelbg.net
 *   GET /?target=axelbg.net&path=/download.php/123/file.torrent&cookies=...&binary=1  → binary response
 *   GET /login?username=foo&password=bar                                → login to zamunda.ch
 *   GET /login?target=axelbg.net&username=foo&password=bar              → login to axelbg.net
 */

const ALLOWED_TARGETS = {
    'zamunda.ch': 'https://zamunda.ch',
    'axelbg.net': 'https://axelbg.net',
};
const DEFAULT_TARGET = 'zamunda.ch';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export default {
    async fetch(request) {
        const url = new URL(request.url);
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        };

        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        const targetKey = url.searchParams.get('target') || DEFAULT_TARGET;
        const baseUrl = ALLOWED_TARGETS[targetKey];
        if (!baseUrl) {
            return new Response(JSON.stringify({ error: 'Invalid target' }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        // --- LOGIN endpoint ---
        if (url.pathname === '/login') {
            return handleLogin(url, baseUrl, targetKey, corsHeaders);
        }

        // --- PROXY endpoint ---
        // Extract params from raw URL to handle path values containing ? and &
        const fullUrl = request.url;
        let path = null, cookies = '', binary = false;
        
        // Extract path: everything between "path=" and "&cookies=" (or end of URL)
        const pathMatch = fullUrl.match(/[?&]path=(.*?)(?:&cookies=|$)/);
        if (pathMatch) {
            path = decodeURIComponent(pathMatch[1]);
        }
        
        // Extract cookies
        const cookiesMatch = fullUrl.match(/[?&]cookies=(.*?)(?:&binary=|$)/);
        if (cookiesMatch) {
            cookies = decodeURIComponent(cookiesMatch[1]);
        }
        
        // Extract binary flag
        binary = fullUrl.includes('binary=1');

        if (!path) {
            return new Response(JSON.stringify({ error: 'Missing path parameter' }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        try {
            const targetUrl = baseUrl + path;
            const headers = {
                'User-Agent': UA,
                'Accept': binary ? '*/*' : 'text/html,application/xhtml+xml',
                'Accept-Language': 'bg,en;q=0.9',
            };
            if (cookies) {
                headers['Cookie'] = cookies;
            }

            const response = await fetch(targetUrl, {
                headers,
                redirect: 'follow',
            });

            if (binary) {
                const data = await response.arrayBuffer();
                return new Response(data, {
                    status: response.status,
                    headers: {
                        ...corsHeaders,
                        'Content-Type': response.headers.get('Content-Type') || 'application/octet-stream',
                    }
                });
            }

            const text = await response.text();
            return new Response(text, {
                status: response.status,
                headers: {
                    ...corsHeaders,
                    'Content-Type': 'text/html; charset=utf-8',
                }
            });
        } catch (e) {
            return new Response(JSON.stringify({ error: e.message }), {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }
    }
};

async function handleLogin(url, baseUrl, targetKey, corsHeaders) {
    const username = url.searchParams.get('username');
    const password = url.searchParams.get('password');

    if (!username || !password) {
        return new Response(JSON.stringify({ error: 'Missing username or password' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    try {
        const loginPath = targetKey === 'axelbg.net' ? '/takelogin.php' : '/takelogin.php';
        const loginUrl = baseUrl + loginPath;
        const body = `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;

        const response = await fetch(loginUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': UA,
            },
            redirect: 'manual',
        });

        // Cloudflare Workers: headers.get('set-cookie') returns ALL cookies joined with ', '
        // We need to parse the combined string
        const rawCookies = response.headers.get('set-cookie') || '';
        
        let uid = '', pass = '';
        const uidMatch = rawCookies.match(/uid=(\d+)/);
        const passMatch = rawCookies.match(/pass=([a-f0-9]{32})/);
        
        if (uidMatch) uid = uidMatch[1];
        if (passMatch) pass = passMatch[1];

        if (uid && pass) {
            return new Response(JSON.stringify({ uid, pass }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        } else {
            // Debug info when login fails
            return new Response(JSON.stringify({ 
                error: 'Login failed — wrong credentials or no cookies returned',
                debug: {
                    status: response.status,
                    rawCookies: rawCookies.substring(0, 500),
                    uidMatch: uidMatch ? uidMatch[0] : null,
                    passMatch: passMatch ? passMatch[0] : null
                }
            }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
}
