const cheerio = require('cheerio');
const { createClient } = require('./sessionManager');
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

        // Extract full torrent name from download link
        let title = visibleTitle;
        const downloadLink = tds.eq(1).find('a[href*="download.php"]').first();
        if (downloadLink.length) {
            const dlHref = downloadLink.attr('href') || '';
            const nameMatch = dlHref.match(/\/download\.php\/\d+\/(.+?)\.torrent/i);
            if (nameMatch) {
                title = decodeURIComponent(nameMatch[1]).replace(/\./g, ' ');
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

    results.sort((a, b) => b.seeders - a.seeders);
    console.log(`[Zamunda] Found ${results.length} results for "${query}"`);
    if (results.length > 0) {
        console.log(`[Zamunda] Top: "${results[0].title}" (${results[0].size}, ${results[0].seeders} seeds)`);
    }
    return results;
}

/**
 * Get magnet link
 */
async function getMagnet(uid, pass, torrentId) {
    const client = createClient(uid, pass);
    const response = await client.get(`/magnetlink/download_go.php?id=${torrentId}&m=x`);
    const html = response.data;

    const magnetMatch = html.match(/magnet:\?[^"'<>\s]+/);
    if (magnetMatch) return magnetMatch[0];

    const $ = cheerio.load(html);
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
