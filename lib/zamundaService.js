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

    // Video-only category IDs from Zamunda
    const videoCats = new Set([
        5,  // Филми/HD
        19, // Филми/SD
        20, // Филми/DVD-R
        24, // Филми/BG
        25, // Документални
        31, // Филми/Дублирани
        42, // Blu-ray
        46, // Филми/3D
        7,  // Сериали
        33, // Сериали/HD
        41, // Аниме/TV
        43, // Аниме/HD
    ]);

    $('tr[onmouseover]').each((i, elem) => {
        const row = $(elem);
        const tds = row.find('td');
        if (tds.length < 8) return;

        // Filter: only video categories
        const catLink = tds.eq(0).find('a[href*="cat="]').first();
        if (catLink.length) {
            const catMatch = (catLink.attr('href') || '').match(/cat=(\d+)/);
            if (catMatch && !videoCats.has(parseInt(catMatch[1]))) return;
        }

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
 * Normalize a string for comparison: lowercase, remove special chars, collapse spaces
 */
function normalize(str) {
    return str.toLowerCase()
        .replace(/[^\w\s\u0400-\u04FF]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Extract all plausible years (1900-2099) from a string
 */
function extractYears(str) {
    const matches = str.match(/\b(19\d{2}|20\d{2})\b/g);
    return matches ? matches.map(Number) : [];
}

/**
 * Known edition/version words that can appear after a movie title
 * (these are NOT part of the actual movie name)
 */
const EDITION_WORDS = new Set([
    'extended', 'unrated', 'directors', 'director', 'cut', 'remastered',
    'special', 'edition', 'complete', 'theatrical', 'imax', 'dc',
    'recut', 'final', 'ultimate', 'criterion', 'restored', 'redux',
    'anniversary', 'collectors', 'limited', 'deluxe', 'premium',
    'dubbed', 'subbed', 'dual', 'multi', 'bg', 'bgaudio', 'bgsub',
    'audio', 'subs', 'subtitle', 'subtitles', 'aka', 'repack', 'proper',
    'hybrid', 'open', 'matte', 'bonus', 'extras', 'uncensored',
    'part', 'vol', 'volume'
]);

/**
 * Extract the "title portion" from a torrent name
 * (everything before year, resolution, quality, codec markers)
 * e.g. "Soul.2020.1080p.BluRay" -> "soul"
 *      "Soul.Surfer.2011.720p" -> "soul surfer"
 *      "Gladiator.II.2024.WEB" -> "gladiator ii"
 */
function extractTitlePart(torrentTitle) {
    const norm = normalize(torrentTitle);

    // Markers that indicate end of the movie title
    const markerRegex = /\b((?:19|20)\d{2}|2160p|1080[pi]|720p|480p|360p|4k|uhd|bluray|blu ray|bdrip|bdremux|webrip|web[\s-]?dl|webdl|hdtv|pdtv|dvdrip|hdrip|hdcam|telesync|remux|x264|x265|h\s?264|h\s?265|hevc|avc|aac|dts|ac3|s\d{2}e\d{2}|s\d{2}\s|season\s+\d|complete|multi)\b/;

    const match = norm.match(markerRegex);
    if (match) {
        return norm.substring(0, match.index).trim();
    }

    return norm;
}

/**
 * Check if a torrent title strictly matches the expected movie/series name
 * Handles: "Soul" vs "Soul Surfer", "Gladiator" vs "Gladiator II", etc.
 * @param {string} torrentTitle - The torrent's full title/filename
 * @param {object} filter - { name, year, season?, episode? }
 * @returns {boolean}
 */
function matchesFilter(torrentTitle, filter) {
    if (!filter || !filter.name) return true;

    const normName = normalize(filter.name);
    const titlePart = extractTitlePart(torrentTitle);

    // --- Strict title matching ---
    let titleMatches = false;

    // 1. Exact match: "soul" === "soul"
    if (titlePart === normName) {
        titleMatches = true;
    }

    // 2. Title starts with the name, remainder are edition/version words only
    //    e.g. "soul extended" starts with "soul", "extended" is an edition word -> OK
    //    e.g. "soul surfer" starts with "soul", "surfer" is NOT an edition word -> SKIP
    if (!titleMatches && titlePart.startsWith(normName)) {
        const extra = titlePart.substring(normName.length).trim();
        if (!extra) {
            titleMatches = true;
        } else {
            const extraWords = extra.split(/\s+/);
            titleMatches = extraWords.every(w => EDITION_WORDS.has(w));
        }
    }

    // 3. Handle "the" prefix differences
    //    Cinemeta might return "The Matrix" but torrent has "Matrix" or vice versa
    if (!titleMatches) {
        const nameNoThe = normName.replace(/^the\s+/, '');
        const titleNoThe = titlePart.replace(/^the\s+/, '');

        if (titleNoThe === nameNoThe) {
            titleMatches = true;
        } else if (titleNoThe.startsWith(nameNoThe)) {
            const extra = titleNoThe.substring(nameNoThe.length).trim();
            if (!extra) {
                titleMatches = true;
            } else {
                const extraWords = extra.split(/\s+/);
                titleMatches = extraWords.every(w => EDITION_WORDS.has(w));
            }
        }
    }

    if (!titleMatches) {
        console.log(`[Filter] SKIP (title mismatch): "${titlePart}" ≠ "${normName}" (from "${torrentTitle}")`);
        return false;
    }

    // --- Year check ---
    if (filter.year) {
        const torrentYears = extractYears(torrentTitle);
        if (torrentYears.length > 0) {
            // Torrent has year(s) in its title - at least one must match
            if (!torrentYears.includes(filter.year)) {
                console.log(`[Filter] SKIP (year mismatch): "${torrentTitle}" has years [${torrentYears}], expected ${filter.year}`);
                return false;
            }
        }
        // If torrent has no year in title, keep it (benefit of the doubt)
    }

    return true;
}

/**
 * Search and return Stremio streams (with full stream cache)
 */
async function getStreams(uid, pass, query, type, filter) {
    // Check stream cache (by query, not IMDB ID - covers fallback searches too)
    const cacheKey = `${query}:${type}`;
    const cached = streamCache.get(cacheKey);
    if (cached) {
        console.log(`[Zamunda] Stream cache hit for "${query}" (${cached.length} streams)`);
        return cached;
    }

    const results = await search(uid, pass, query);

    // Apply title/year filter to match only the specific movie/series
    const filtered = filter
        ? results.filter(r => matchesFilter(r.title, filter))
        : results;

    console.log(`[Zamunda] After filter: ${filtered.length}/${results.length} results match "${filter?.name} (${filter?.year || '?'})"`);

    const streams = [];

    for (const result of filtered.slice(0, 10)) {
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
