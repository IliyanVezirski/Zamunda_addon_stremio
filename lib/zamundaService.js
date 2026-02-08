const cheerio = require('cheerio');
const { login, clearSession, createClient } = require('./sessionManager');
const { extractQuality, formatSize, delay } = require('./utils');

/**
 * Search Zamunda for torrents
 */
async function search(uid, pass, query) {
    const client = createClient(uid, pass);
    const url = `/bananas?search=${encodeURIComponent(query)}&incldead=0&field=name&cat=0`;

    console.log(`[Zamunda] Search: ${url}`);
    const response = await client.get(url);
    const html = response.data;

    console.log(`[Zamunda] Response length: ${html.length}`);
    console.log(`[Zamunda] Has nsls: ${html.includes('nsls.jpg')}`);
    console.log(`[Zamunda] Has logout: ${html.includes('logout')}`);

    // If we got the seizure/blocked page, cookies are invalid
    if (html.includes('nsls.jpg') && html.length < 500) {
        console.log('[Zamunda] Got seizure page (nsls.jpg) - session invalid');
        return { results: [], sessionExpired: true };
    }

    if (html.includes('login.php') && !html.includes('logout')) {
        console.log('[Zamunda] Got login page - session expired');
        return { results: [], sessionExpired: true };
    }

    const $ = cheerio.load(html);
    const results = [];

    // Zamunda uses <tr onmouseover="..."> for torrent rows
    $('tr[onmouseover]').each((i, elem) => {
        const row = $(elem);
        const tds = row.find('td');

        // Need at least 8 columns (cat, name, comments, rating, date, size, downloaded, seeders, leechers)
        if (tds.length < 8) return;

        // Column 1: Title and torrent link
        const titleLink = tds.eq(1).find('a[href*="banan?id="]').first();
        if (!titleLink.length) return;

        const href = titleLink.attr('href') || '';
        const visibleTitle = titleLink.find('b').text().trim() || titleLink.text().trim();
        const idMatch = href.match(/id=(\d+)/);
        if (!idMatch) return;

        // Extract full torrent name from download link (has quality info like 1080p, BluRay etc)
        let title = visibleTitle;
        const downloadLink = tds.eq(1).find('a[href*="download.php"]').first();
        if (downloadLink.length) {
            const dlHref = downloadLink.attr('href') || '';
            const nameMatch = dlHref.match(/\/download\.php\/\d+\/(.+?)\.torrent/i);
            if (nameMatch) {
                title = decodeURIComponent(nameMatch[1]).replace(/\./g, ' ');
            }
        }

        // Column 5: Size (format: "16.64<br>GB")
        const sizeText = tds.eq(5).text().trim().replace(/\s+/g, ' ');

        // Column 7: Seeders (td.tdseeders)
        const seedersCell = row.find('td.tdseeders');
        const seedersText = seedersCell.text().trim();
        const seeders = parseInt(seedersText) || 0;

        results.push({
            id: idMatch[1],
            title,
            size: sizeText,
            seeders,
            quality: extractQuality(title)
        });
    });

    results.sort((a, b) => b.seeders - a.seeders);
    console.log(`[Zamunda] Found ${results.length} results for "${query}"`);
    if (results.length > 0) {
        console.log(`[Zamunda] Top result: "${results[0].title}" (${results[0].size}, ${results[0].seeders} seeds)`);
    }
    return { results, sessionExpired: false };
}

/**
 * Get magnet link from the magnetlink page
 */
async function getMagnet(uid, pass, torrentId) {
    const client = createClient(uid, pass);

    // Zamunda's magnet link is at /magnetlink/download_go.php?id=XXX&m=x
    const response = await client.get(`/magnetlink/download_go.php?id=${torrentId}&m=x`);
    const html = response.data;

    // Extract magnet: link from the page
    const magnetMatch = html.match(/magnet:\?[^"'<>\s]+/);
    if (magnetMatch) {
        return magnetMatch[0];
    }

    // Fallback: check for magnet link in anchor tags
    const $ = cheerio.load(html);
    const magnetHref = $('a[href^="magnet:"]').first().attr('href');
    if (magnetHref) return magnetHref;

    console.log(`[Zamunda] No magnet link found for torrent ${torrentId}`);
    return null;
}

/**
 * Search and return Stremio streams with automatic re-login on session expiry
 */
async function getStreams(username, password, query, type) {
    // Login (uses cache if available)
    let session = await login(username, password);
    let searchResult = await search(session.uid, session.pass, query);

    // If session expired, clear cache, re-login, and retry once
    if (searchResult.sessionExpired) {
        console.log('[Zamunda] Session expired, re-logging in...');
        clearSession(username);
        session = await login(username, password, true); // force refresh
        searchResult = await search(session.uid, session.pass, query);

        if (searchResult.sessionExpired) {
            console.error('[Zamunda] Still getting blocked after re-login');
            return [];
        }
    }

    const results = searchResult.results;
    const streams = [];

    for (const result of results.slice(0, 10)) {
        try {
            const magnet = await getMagnet(session.uid, session.pass, result.id);
            if (!magnet) continue;

            const hashMatch = magnet.match(/btih:([a-fA-F0-9]{40})/i);
            if (!hashMatch) continue;

            // Extract trackers from magnet link
            const trackers = magnet.match(/tr=([^&]+)/g)?.map(t => decodeURIComponent(t.replace('tr=', ''))) || [];

            streams.push({
                name: 'Zamunda',
                title: `${result.quality} | ${result.size}\n${result.seeders} seeds | ${result.title.substring(0, 60)}`,
                infoHash: hashMatch[1].toLowerCase(),
                sources: trackers,
                behaviorHints: { bingeGroup: `zamunda-${result.quality}` }
            });

            await delay(200);
        } catch (e) {
            console.error(`[Zamunda] Error for ${result.id}:`, e.message);
        }
    }

    console.log(`[Zamunda] Returning ${streams.length} streams`);
    return streams;
}

module.exports = { getStreams };
