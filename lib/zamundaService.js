const cheerio = require('cheerio');
const { createClient } = require('./sessionManager');
const { extractQuality, qualityRank, formatSize, delay } = require('./utils');
const { streamCache, magnetCache, searchCache } = require('./cache');

/**
 * Search Zamunda for torrents (with cache)
 */
async function search(uid, pass, query) {
    // Check search cache
    const cached = searchCache.get(query);
    if (cached) {
        console.log(`[Zamunda] Cache hit for "${query}" (${cached.length} results)`);
        return cached;
    }

    const client = createClient(uid, pass);
    const url = `/bananas?search=${encodeURIComponent(query)}&incldead=0&field=name&cat=0`;

    console.log(`[Zamunda] Search: ${url}`);
    const response = await client.get(url);
    const html = response.data;

    console.log(`[Zamunda] Response length: ${html.length}`);

    if (html.includes('nsls.jpg') && html.length < 500) {
        console.log('[Zamunda] Got seizure page - session invalid');
        return [];
    }

    if (html.includes('login.php') && !html.includes('logout')) {
        console.log('[Zamunda] Got login page - session expired');
        return [];
    }

    const $ = cheerio.load(html);
    const results = [];

    $('tr[onmouseover]').each((i, elem) => {
        const row = $(elem);
        const tds = row.find('td');
        if (tds.length < 8) return;

        const titleLink = tds.eq(1).find('a[href*="banan?id="]').first();
        if (!titleLink.length) return;

        const href = titleLink.attr('href') || '';
        const visibleTitle = titleLink.find('b').text().trim() || titleLink.text().trim();
        const idMatch = href.match(/id=(\d+)/);
        if (!idMatch) return;

        let title = visibleTitle;
        const downloadLink = tds.eq(1).find('a[href*="download.php"]').first();
        if (downloadLink.length) {
            const dlHref = downloadLink.attr('href') || '';
            const nameMatch = dlHref.match(/\/download\.php\/\d+\/(.+?)(?:\.torrent|\.mkv|$)/i);
            if (nameMatch) {
                title = decodeURIComponent(nameMatch[1]).replace(/[._]/g, ' ').trim();
            }
        }

        const sizeText = tds.eq(5).text().trim().replace(/\s+/g, ' ');
        const seedersCell = row.find('td.tdseeders');
        const seeders = parseInt(seedersCell.text().trim()) || 0;

        results.push({
            id: idMatch[1],
            title,
            size: sizeText,
            seeders,
            quality: extractQuality(title)
        });
    });

    // Sort by quality (best first), then by seeders
    results.sort((a, b) => {
        const qualDiff = qualityRank(b.quality) - qualityRank(a.quality);
        if (qualDiff !== 0) return qualDiff;
        return b.seeders - a.seeders;
    });
    console.log(`[Zamunda] Found ${results.length} results for "${query}"`);

    // Cache results
    if (results.length > 0) {
        searchCache.set(query, results);
    }

    return results;
}

/**
 * Get magnet link (with cache)
 */
async function getMagnet(uid, pass, torrentId) {
    // Check magnet cache
    const cached = magnetCache.get(torrentId);
    if (cached) {
        return cached;
    }

    const client = createClient(uid, pass);
    const response = await client.get(`/magnetlink/download_go.php?id=${torrentId}&m=x`);
    const html = response.data;

    let magnet = null;
    const magnetMatch = html.match(/magnet:\?[^"'<>\s]+/);
    if (magnetMatch) {
        magnet = magnetMatch[0];
    } else {
        const $ = cheerio.load(html);
        magnet = $('a[href^="magnet:"]').first().attr('href') || null;
    }

    // Cache magnet link
    if (magnet) {
        magnetCache.set(torrentId, magnet);
    }

    return magnet;
}

/**
 * Search and return Stremio streams (with full stream cache)
 */
async function getStreams(uid, pass, query, type) {
    // Check stream cache (by query, not IMDB ID - covers fallback searches too)
    const cacheKey = `${query}:${type}`;
    const cached = streamCache.get(cacheKey);
    if (cached) {
        console.log(`[Zamunda] Stream cache hit for "${query}" (${cached.length} streams)`);
        return cached;
    }

    const results = await search(uid, pass, query);
    const streams = [];

    for (const result of results.slice(0, 10)) {
        try {
            const magnet = await getMagnet(uid, pass, result.id);
            if (!magnet) continue;

            const hashMatch = magnet.match(/btih:([a-fA-F0-9]{40})/i);
            if (!hashMatch) continue;

            const trackers = magnet.match(/tr=([^&]+)/g)?.map(t => decodeURIComponent(t.replace('tr=', ''))) || [];

            streams.push({
                name: `Zamunda ${result.quality}`,
                title: `${result.size} | ${result.seeders} seeds\n${result.title.substring(0, 70)}`,
                infoHash: hashMatch[1].toLowerCase(),
                sources: trackers,
                behaviorHints: { bingeGroup: `zamunda-${result.quality}` }
            });

            await delay(200);
        } catch (e) {
            console.error(`[Zamunda] Error for ${result.id}:`, e.message);
        }
    }

    // Cache streams
    if (streams.length > 0) {
        streamCache.set(cacheKey, streams);
    }

    console.log(`[Zamunda] Returning ${streams.length} streams`);
    return streams;
}

module.exports = { getStreams };
