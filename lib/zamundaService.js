const cheerio = require('cheerio');
const { createClient, ZAMUNDA_URL } = require('./sessionManager');
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

    if (html.includes('login.php') && !html.includes('logout')) {
        throw new Error('Session expired');
    }

    const $ = cheerio.load(html);
    const results = [];

    $('table.cells tr').each((i, elem) => {
        if (i === 0) return;
        const row = $(elem);
        const titleLink = row.find('td').eq(1).find('a[href*="/banan"]').first();
        if (!titleLink.length) return;

        const href = titleLink.attr('href') || '';
        const title = titleLink.attr('title') || titleLink.text().trim();
        const idMatch = href.match(/id=(\d+)/);
        if (!idMatch) return;

        const seeders = parseInt(row.find('td').eq(5).text()) || 0;
        const size = formatSize(row.find('td').eq(4).text());

        results.push({
            id: idMatch[1],
            title,
            size,
            seeders,
            quality: extractQuality(title)
        });
    });

    results.sort((a, b) => b.seeders - a.seeders);
    console.log(`[Zamunda] Found ${results.length} results`);
    return results;
}

/**
 * Get magnet link from torrent page
 */
async function getMagnet(uid, pass, torrentId) {
    const client = createClient(uid, pass);
    const response = await client.get(`/banan?id=${torrentId}`);
    const $ = cheerio.load(response.data);
    return $('a[href^="magnet:"]').first().attr('href') || null;
}

/**
 * Search and return Stremio streams
 */
async function getStreams(uid, pass, query, type) {
    const results = await search(uid, pass, query);
    const streams = [];

    for (const result of results.slice(0, 10)) {
        try {
            const magnet = await getMagnet(uid, pass, result.id);
            if (!magnet) continue;

            const hashMatch = magnet.match(/btih:([a-fA-F0-9]{40})/i);
            if (!hashMatch) continue;

            streams.push({
                name: 'Zamunda',
                title: `${result.quality} | ${result.size}\n${result.seeders} seeds | ${result.title.substring(0, 60)}`,
                infoHash: hashMatch[1].toLowerCase(),
                sources: magnet.match(/tr=([^&]+)/g)?.map(t => decodeURIComponent(t.replace('tr=', ''))) || [],
                behaviorHints: { bingeGroup: `zamunda-${result.quality}` }
            });

            await delay(100);
        } catch (e) {
            console.error(`[Zamunda] Error for ${result.id}:`, e.message);
        }
    }

    return streams;
}

module.exports = { getStreams };
