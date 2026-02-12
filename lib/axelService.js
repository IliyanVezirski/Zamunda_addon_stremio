const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { extractQuality, qualityRank } = require('./utils');
const { streamCache, searchCache, magnetCache } = require('./cache');

const { WORKER_URL } = require('./sessionManager');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BG_PROXY_LIST_URL = 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/countries/BG/data.json';

// Cache for Bulgarian proxies
let bgProxies = [];
let bgProxiesLastFetch = 0;
const PROXY_CACHE_TTL = 5 * 60 * 1000; // 5 min (same as proxifly update interval)

async function getBgProxies() {
    if (bgProxies.length > 0 && Date.now() - bgProxiesLastFetch < PROXY_CACHE_TTL) {
        return bgProxies;
    }
    try {
        console.log('[Axel] Fetching fresh BG proxy list...');
        const res = await axios.get(BG_PROXY_LIST_URL, { timeout: 10000 });
        bgProxies = (res.data || []).filter(p => p.protocol === 'socks5' || p.protocol === 'socks4');
        bgProxiesLastFetch = Date.now();
        console.log(`[Axel] Got ${bgProxies.length} BG SOCKS proxies`);
        return bgProxies;
    } catch (e) {
        console.log(`[Axel] Failed to fetch BG proxies: ${e.message}`);
        return bgProxies; // return stale cache
    }
}

async function fetchViaBgProxy(url, cookies) {
    const proxies = await getBgProxies();
    if (proxies.length === 0) {
        console.log('[Axel] No BG proxies available');
        return null;
    }
    for (const proxy of proxies) {
        try {
            const agent = new SocksProxyAgent(`${proxy.protocol}://${proxy.ip}:${proxy.port}`);
            console.log(`[Axel] Trying BG proxy ${proxy.ip}:${proxy.port} (${proxy.protocol})...`);
            const res = await axios.get(url, {
                httpAgent: agent,
                httpsAgent: agent,
                timeout: 15000,
                validateStatus: () => true,
                headers: {
                    'User-Agent': UA,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'bg,en-US;q=0.7,en;q=0.3',
                    'Cookie': cookies,
                    'Referer': 'https://axelbg.net/',
                },
                responseType: 'arraybuffer',
            });
            const buf = Buffer.from(res.data);
            const html = buf.toString('latin1');
            console.log(`[Axel] BG proxy ${proxy.ip}: status=${res.status}, ${html.length} chars`);
            if (res.status === 200 && !html.includes('SQL Error')) {
                return { html, status: res.status, proxy: proxy.ip };
            }
            console.log(`[Axel] BG proxy ${proxy.ip} failed: ${html.includes('SQL Error') ? 'SQL Error' : 'status=' + res.status}`);
        } catch (e) {
            console.log(`[Axel] BG proxy ${proxy.ip}:${proxy.port} error: ${e.message}`);
        }
    }
    return null;
}

const VIDEO_EXTENSIONS = new Set(['mkv', 'mp4', 'avi', 'wmv', 'flv', 'mov', 'm4v', 'ts', 'webm']);

/**
 * Minimal bencode parser — extract info dict from .torrent buffer and compute SHA1 infoHash
 */
function extractInfoHash(buf) {
    const marker = Buffer.from('4:infod');
    const idx = buf.indexOf(marker);
    if (idx === -1) return null;

    const infoStart = idx + 6;
    let depth = 0;
    let pos = infoStart;
    while (pos < buf.length) {
        const ch = buf[pos];
        if (ch === 0x64 || ch === 0x6c) { // 'd' or 'l'
            depth++;
            pos++;
        } else if (ch === 0x65) { // 'e'
            depth--;
            if (depth === 0) {
                const infoBuf = buf.slice(infoStart, pos + 1);
                return crypto.createHash('sha1').update(infoBuf).digest('hex');
            }
            pos++;
        } else if (ch === 0x69) { // 'i' — integer
            pos++;
            while (pos < buf.length && buf[pos] !== 0x65) pos++;
            pos++;
        } else if (ch >= 0x30 && ch <= 0x39) { // string length
            let lenStr = '';
            while (pos < buf.length && buf[pos] !== 0x3a) {
                lenStr += String.fromCharCode(buf[pos]);
                pos++;
            }
            pos++;
            pos += parseInt(lenStr) || 0;
        } else {
            pos++;
        }
    }
    return null;
}

/**
 * Extract tracker announce URL from .torrent buffer
 */
function extractTracker(buf) {
    const str = buf.toString('binary');
    const match = str.match(/8:announce(\d+):/);
    if (!match) return null;
    const len = parseInt(match[1]);
    const start = str.indexOf(match[0]) + match[0].length;
    return str.substring(start, start + len);
}

/**
 * Extract video file list from .torrent buffer
 */
function extractVideoFiles(buf) {
    const str = buf.toString('binary');
    const videoRegex = /[\w.\-\s\u0400-\u04FF]{3,150}\.(mkv|mp4|avi|wmv|flv|mov|m4v|ts|webm)/gi;
    const files = [];
    const seen = new Set();
    let m;
    while ((m = videoRegex.exec(str)) !== null) {
        const name = m[0].trim();
        if (!seen.has(name.toLowerCase())) {
            seen.add(name.toLowerCase());
            files.push({ name, index: files.length });
        }
    }
    return files;
}

/**
 * Search axelbg.net by IMDB ID (or text query)
 */
async function search(uid, pass, query) {
    const cacheKey = `axel:${query}`;
    const cached = searchCache.get(cacheKey);
    if (cached) return cached;

    console.log(`[Axel] Search: "${query}" — no cache`);
    const cookies = `uid=${uid}; pass=${pass}`;
    const browseUrl = `https://axelbg.net/browse.php?search=${encodeURIComponent(query)}&cat=0&incldead=0&page=0&first=0&last=50`;

    // Primary: BG SOCKS proxy (direct to axelbg.net with Bulgarian IP)
    let html = '';
    const proxyResult = await fetchViaBgProxy(browseUrl, cookies);
    if (proxyResult) {
        html = proxyResult.html;
        console.log(`[Axel] Success via BG proxy ${proxyResult.proxy}, ${html.length} chars`);
    } else {
        // Fallback: CF Worker (works if routed to SOF)
        console.log('[Axel] BG proxy failed, trying CF Worker fallback...');
        const path = `/browse.php?search=${encodeURIComponent(query)}&cat=0&incldead=0&page=0&first=0&last=50`;
        const workerUrl = `${WORKER_URL}/?target=axelbg.net&path=${encodeURIComponent(path)}&cookies=${encodeURIComponent(cookies)}`;
        try {
            const res = await axios.get(workerUrl, { timeout: 20000, validateStatus: () => true });
            const colo = res.headers?.['x-worker-colo'] || 'unknown';
            html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
            console.log(`[Axel] Worker: status=${res.status}, colo=${colo}, ${html.length} chars`);
        } catch (e) {
            console.log(`[Axel] Worker failed: ${e.message}`);
            return [];
        }
    }

    if (html.includes('SQL Error')) {
        console.log('[Axel] SQL Error in response');
        return [];
    }
    
    if (html.includes('login.php') && !html.includes('logout')) {
        console.log('[Axel] Not logged in — session expired');
        return [];
    }

    const $ = cheerio.load(html);
    const results = [];
    const seenIds = new Set();

    // Video category IDs on axelbg.net
    const videoCats = new Set([5, 7, 9, 42, 44, 45, 46, 47, 48]);

    $('td').each((i, td) => {
        const el = $(td);
        const detailLink = el.find('a[href*="details.php?id="]').first();
        if (!detailLink.length) return;

        const href = detailLink.attr('href') || '';
        const idMatch = href.match(/id=(\d+)/);
        if (!idMatch || seenIds.has(idMatch[1])) return;

        const dlLink = el.find('a[href*="download.php"]').first();
        if (!dlLink.length) return;

        seenIds.add(idMatch[1]);

        const title = detailLink.text().trim();
        const downloadHref = dlLink.attr('href') || '';

        // Get category from row
        const row = el.closest('tr');
        const catLink = row.find('a[href*="cat="]').first();
        if (catLink.length) {
            const catMatch = (catLink.attr('href') || '').match(/cat=(\d+)/);
            if (catMatch && videoCats.size > 0 && !videoCats.has(parseInt(catMatch[1]))) {
                // Skip non-video categories if we have a filter
                // For now, keep all since axelbg has fewer categories
            }
        }

        const tds = row.find('td');
        let size = '', seeders = 0;
        tds.each((j, sibling) => {
            const txt = $(sibling).text().trim();
            if (/^\d+[\.,]\d+\s*[GMKT]B$/i.test(txt)) size = txt;
            const seedLink = $(sibling).find('a[href*="toseeders"]');
            if (seedLink.length) seeders = parseInt(seedLink.text().trim()) || 0;
        });

        results.push({
            id: idMatch[1],
            title,
            downloadHref,
            size,
            seeders,
            quality: extractQuality(title)
        });
    });

    results.sort((a, b) => {
        const qualDiff = qualityRank(b.quality) - qualityRank(a.quality);
        if (qualDiff !== 0) return qualDiff;
        return b.seeders - a.seeders;
    });

    console.log(`[Axel] Found ${results.length} results for "${query}"`);
    if (results.length > 0) {
        searchCache.set(cacheKey, results);
    }
    return results;
}

/**
 * Download .torrent file and extract infoHash + tracker + file list
 */
async function getTorrentInfo(uid, pass, downloadHref) {
    const cacheKey = `axel-torrent:${downloadHref}`;
    const cached = magnetCache.get(cacheKey);
    if (cached) return cached;

    // downloadHref may be full URL like "https://axelbg.net/download.php/..." — strip domain
    let path = downloadHref;
    if (path.startsWith('http')) {
        try { path = new URL(path).pathname; } catch (e) { /* keep as-is */ }
    }
    if (!path.startsWith('/')) path = `/${path}`;
    const cookies = `uid=${uid}; pass=${pass}`;

    console.log(`[Axel] Downloading .torrent: ${path.substring(0, 80)}...`);
    const torrentUrl = `https://axelbg.net${path}`;
    let buf;

    // Try BG proxy first, then Worker fallback
    const proxies = await getBgProxies();
    let downloaded = false;
    for (const proxy of proxies) {
        try {
            const agent = new SocksProxyAgent(`${proxy.protocol}://${proxy.ip}:${proxy.port}`);
            const res = await axios.get(torrentUrl, {
                httpAgent: agent, httpsAgent: agent,
                timeout: 15000, responseType: 'arraybuffer',
                headers: { 'User-Agent': UA, 'Cookie': cookies, 'Referer': 'https://axelbg.net/' },
            });
            buf = Buffer.from(res.data);
            if (buf.length > 100) { downloaded = true; break; }
        } catch (e) { /* try next proxy */ }
    }
    if (!downloaded) {
        console.log('[Axel] BG proxy failed for .torrent, trying Worker...');
        const workerUrl = `${WORKER_URL}/?target=axelbg.net&path=${encodeURIComponent(path)}&cookies=${encodeURIComponent(cookies)}&binary=1`;
        const res = await axios.get(workerUrl, { timeout: 20000, responseType: 'arraybuffer' });
        buf = Buffer.from(res.data);
    }
    const infoHash = extractInfoHash(buf);
    if (!infoHash) {
        console.log('[Axel] Failed to extract infoHash');
        return null;
    }

    const tracker = extractTracker(buf);
    const files = extractVideoFiles(buf);

    const info = { infoHash, tracker, files };
    magnetCache.set(cacheKey, info);
    console.log(`[Axel] infoHash: ${infoHash}, tracker: ${tracker ? 'yes' : 'no'}, files: ${files.length}`);
    return info;
}

/**
 * Find episode file index in a file list
 */
function findEpisodeFileIdx(files, season, episode) {
    if (!files || files.length === 0) return null;

    const sPad = String(season).padStart(2, '0');
    const ePad = String(episode).padStart(2, '0');

    for (const file of files) {
        const norm = file.name.toLowerCase();
        if (norm.includes(`s${sPad}e${ePad}`)) return file.index;
    }

    for (const file of files) {
        const norm = file.name.toLowerCase();
        if (new RegExp(`\\be${ePad}\\b`).test(norm)) return file.index;
        if (new RegExp(`\\bepisode\\s*${episode}\\b`).test(norm)) return file.index;
    }

    // By position
    const videoFiles = files.sort((a, b) => a.name.localeCompare(b.name));
    if (videoFiles.length >= episode) return videoFiles[episode - 1].index;

    return null;
}

/**
 * Normalize a string for comparison
 */
function normalize(str) {
    return str.toLowerCase()
        .replace(/[^\w\s\u0400-\u04FF]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Check if torrent is a season pack
 */
function isSeasonPack(title) {
    const norm = normalize(title);
    const hasSeasonOnly = /\bs\d{1,2}\b/.test(norm) && !/\bs\d{1,2}e\d{1,2}\b/.test(norm);
    const hasSeasonWord = /\b(season\s+\d|complete)\b/.test(norm);
    return hasSeasonOnly || hasSeasonWord;
}

/**
 * Get Stremio streams from axelbg.net
 * @param {string} uid - axelbg uid cookie
 * @param {string} pass - axelbg pass cookie
 * @param {string} imdbId - IMDB ID (e.g. tt1375666)
 * @param {string} type - 'movie' or 'series'
 * @param {object} filter - { name, year, season?, episode? }
 */
async function getStreams(uid, pass, imdbId, type, filter) {
    const cacheKey = `axel:${imdbId}:${type}:${filter?.season || ''}:${filter?.episode || ''}`;
    const cached = streamCache.get(cacheKey);
    if (cached) return cached;

    // Search by IMDB ID — most precise
    const results = await search(uid, pass, imdbId);

    console.log(`[Axel] ${results.length} results for ${imdbId}`);

    const streams = [];

    for (const result of results.slice(0, 8)) {
        try {
            const torrentInfo = await getTorrentInfo(uid, pass, result.downloadHref);
            if (!torrentInfo || !torrentInfo.infoHash) continue;

            const sources = [];
            if (torrentInfo.tracker) sources.push('tracker:' + torrentInfo.tracker);
            // Add public trackers as fallback
            sources.push('tracker:udp://tracker.opentrackr.org:1337/announce');
            sources.push('tracker:udp://open.stealth.si:80/announce');
            sources.push('tracker:udp://exodus.desync.com:6969/announce');

            const stream = {
                name: `AXEL\n${result.quality}`,
                title: `${result.title.substring(0, 70)}\n👤 ${result.seeders}\n📁 ${result.size}\n🌐 AXELbg`,
                infoHash: torrentInfo.infoHash,
                sources: sources,
                behaviorHints: { bingeGroup: `axel-${result.quality}` }
            };

            // Handle season packs for series
            if (type === 'series' && filter?.season && filter?.episode && isSeasonPack(result.title)) {
                const fileIdx = findEpisodeFileIdx(torrentInfo.files, filter.season, filter.episode);
                if (fileIdx !== null) {
                    stream.fileIdx = fileIdx;
                    stream.title = `Ep. ${filter.episode} (from pack)\n👤 ${result.seeders}\n📁 ${result.size}\n🌐 AXELbg`;
                } else {
                    // Show as season pack
                    stream.title = `📦 Цял сезон\n${result.title.substring(0, 70)}\n👤 ${result.seeders}\n📁 ${result.size}\n🌐 AXELbg`;
                }
            }

            streams.push(stream);
        } catch (e) {
            console.error(`[Axel] Error for ${result.id}:`, e.message);
        }
    }

    if (streams.length > 0) {
        streamCache.set(cacheKey, streams);
    }

    console.log(`[Axel] Returning ${streams.length} streams for ${imdbId}`);
    return streams;
}

module.exports = { getStreams };
