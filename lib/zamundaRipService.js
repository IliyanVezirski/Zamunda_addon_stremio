const axios = require('axios');
const { extractQuality, qualityRank, delay } = require('./utils');
const { streamCache, searchCache } = require('./cache');
const { getSeeders } = require('./trackerScrape');

const ZAMUNDA_RIP_API = 'https://zamunda.rip/api/torrents';

// Video-only categories from Zamunda.rip
const VIDEO_CATEGORIES = new Set([
    'Филми/HD', 'Филми/SD', 'Филми/DVD-R', 'Филми/BG',
    'Документални', 'Филми/Дублирани', 'Blu-ray', 'Филми/3D',
    'Сериали', 'Сериали/HD', 'Аниме/TV', 'Аниме/HD',
    'Movies/HD', 'Movies/SD', 'Movies/DVD-R', 'Movies/BG',
    'TV Shows', 'TV Shows/HD', 'Series', 'Series/HD',
]);

/**
 * Search Zamunda.rip archive for torrents (with cache)
 * No login required — public JSON API with magnet links
 */
async function search(query) {
    // Check search cache
    const cached = searchCache.get(query);
    if (cached) {
        return cached;
    }

    console.log(`[ZamundaRIP] Search: "${query}" — no cache, calling API...`);
    const url = `${ZAMUNDA_RIP_API}?q=${encodeURIComponent(query)}`;

    const response = await axios.get(url, {
        timeout: 15000,
        headers: {
            'Accept': 'application/json',
            'User-Agent': 'Stremio-Zamunda-Addon/2.0'
        }
    });

    const data = response.data;
    if (!Array.isArray(data)) {
        console.log('[ZamundaRIP] Unexpected response format:', typeof data);
        return [];
    }

    // Filter to video categories only (if category is present)
    const results = data
        .filter(item => {
            if (!item.link) return false; // must have magnet link
            if (!item.category) return true; // no category = keep
            return VIDEO_CATEGORIES.has(item.category);
        })
        .map(item => ({
            id: String(item.external_id),
            title: item.title || '',
            size: item.size || '',
            magnet: item.link,
            category: item.category || '',
            source: item.source || '',
            isBgAudio: item.is_bgaudio === 1,
            description: item.description || '',
            quality: extractQuality(item.title || '')
        }));

    // Sort by quality (best first)
    results.sort((a, b) => {
        return qualityRank(b.quality) - qualityRank(a.quality);
    });

    console.log(`[ZamundaRIP] Found ${results.length} video results for "${query}" (from ${data.length} total)`);

    // Cache results
    if (results.length > 0) {
        searchCache.set(query, results);
    }

    return results;
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
 */
const EDITION_WORDS = new Set([
    'extended', 'unrated', 'directors', 'director', 'cut', 'remastered',
    'special', 'edition', 'complete', 'theatrical', 'imax', 'dc',
    'recut', 'final', 'ultimate', 'criterion', 'restored', 'redux',
    'anniversary', 'collectors', 'limited', 'deluxe', 'premium',
    'dubbed', 'subbed', 'dual', 'multi', 'bg', 'bgaudio', 'bgsub',
    'audio', 'subs', 'subtitle', 'subtitles', 'aka', 'repack', 'proper',
    'hybrid', 'open', 'matte', 'bonus', 'extras', 'uncensored',
    'part', 'vol', 'volume', 'season'
]);

function isAllowedExtraWord(word, filter) {
    if (EDITION_WORDS.has(word)) return true;
    if (filter?.season && (word === 'season' || /^\d{1,2}$/.test(word))) return true;
    return false;
}

/**
 * Extract the "title portion" from a torrent name
 */
function extractTitlePart(torrentTitle) {
    const norm = normalize(torrentTitle);

    const markerRegex = /\b((?:19|20)\d{2}|2160p|1080[pi]|720p|480p|360p|4k|uhd|bluray|blu ray|bdrip|bdremux|webrip|web[\s-]?dl|webdl|hdtv|pdtv|dvdrip|hdrip|hdcam|telesync|remux|x264|x265|h\s?264|h\s?265|hevc|avc|aac|dts|ac3|s\d{2}e\d{2}|s\d{2}\s|season\s+\d|complete|multi)\b/;

    const match = norm.match(markerRegex);
    if (match) {
        return norm.substring(0, match.index).trim();
    }

    return norm;
}

/**
 * Check if a torrent title strictly matches the expected movie/series name
 */
function matchesFilter(torrentTitle, filter) {
    if (!filter || !filter.name) return true;

    const normName = normalize(filter.name);
    const titlePart = extractTitlePart(torrentTitle);

    let titleMatches = false;

    if (titlePart === normName) {
        titleMatches = true;
    }

    if (!titleMatches && titlePart.startsWith(normName)) {
        const extra = titlePart.substring(normName.length).trim();
        if (!extra) {
            titleMatches = true;
        } else {
            const extraWords = extra.split(/\s+/);
            titleMatches = extraWords.every(w => isAllowedExtraWord(w, filter));
        }
    }

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
                titleMatches = extraWords.every(w => isAllowedExtraWord(w, filter));
            }
        }
    }

    if (!titleMatches) {
        console.log(`[ZamundaRIP Filter] SKIP (title mismatch): "${titlePart}" ≠ "${normName}" (from "${torrentTitle}")`);
        return false;
    }

    // --- Year check ---
    if (filter.year) {
        const torrentYears = extractYears(torrentTitle);
        if (torrentYears.length > 0) {
            if (!torrentYears.includes(filter.year)) {
                console.log(`[ZamundaRIP Filter] SKIP (year mismatch): "${torrentTitle}" has years [${torrentYears}], expected ${filter.year}`);
                return false;
            }
        }
    }

    // --- Season check (for series) ---
    if (filter.season) {
        const normTitle = normalize(torrentTitle);
        const sMatches = normTitle.match(/\bs(\d{1,2})\b/g);
        if (sMatches) {
            const seasons = sMatches.map(s => parseInt(s.replace('s', '')));
            if (!seasons.includes(filter.season)) {
                console.log(`[ZamundaRIP Filter] SKIP (season mismatch): "${torrentTitle}" has S${seasons.join(',S')}, expected S${String(filter.season).padStart(2, '0')}`);
                return false;
            }
        }
        const seasonWordMatches = normTitle.match(/season\s+(\d+)/g);
        if (seasonWordMatches && !sMatches) {
            const seasons = seasonWordMatches.map(s => parseInt(s.match(/\d+/)[0]));
            if (!seasons.includes(filter.season)) {
                console.log(`[ZamundaRIP Filter] SKIP (season mismatch): "${torrentTitle}" has Season ${seasons.join(',')}, expected Season ${filter.season}`);
                return false;
            }
        }
    }

    return true;
}

/**
 * Check if a torrent is a season pack (has season but no specific episode)
 */
function isSeasonPack(title) {
    const norm = normalize(title);
    const hasSeasonOnly = /\bs\d{1,2}\b/.test(norm) && !/\bs\d{1,2}e\d{1,2}\b/.test(norm);
    const hasSeasonWord = /\b(season\s+\d|complete)\b/.test(norm);
    return hasSeasonOnly || hasSeasonWord;
}

/**
 * Search and return Stremio streams using Zamunda.rip API
 * No uid/pass needed — public API with direct magnet links
 */
async function getStreams(query, type, filter) {
    const cacheKey = `rip:${query}:${type}`;
    const cached = streamCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    const results = await search(query);

    // Apply title/year filter to match only the specific movie/series
    const filtered = filter
        ? results.filter(r => matchesFilter(r.title, filter))
        : results;

    console.log(`[ZamundaRIP] ${filtered.length}/${results.length} results match "${filter?.name}" (${filter?.year || '?'})`);

    const streams = [];

    for (const result of filtered.slice(0, 10)) {
        try {
            const magnet = result.magnet;
            if (!magnet) continue;

            const hashMatch = magnet.match(/btih:([a-fA-F0-9]{40})/i);
            if (!hashMatch) continue;

            const trackers = magnet.match(/tr=([^&]+)/g)?.map(t => decodeURIComponent(t.replace('tr=', ''))) || [];

            const sourceLabel = 'BGTorrents';
            const bgLabel = result.isBgAudio ? ' 🇧🇬' : '';

            const isPack = type === 'series' && isSeasonPack(result.title);
            const packLabel = isPack ? '📦 Цял сезон\n' : '';
            const infoHash = hashMatch[1].toLowerCase();

            streams.push({
                infoHash,
                sources: trackers,
                quality: result.quality,
                sourceLabel,
                bgLabel,
                packLabel,
                titleText: result.title.substring(0, 70),
                size: result.size,
            });
        } catch (e) {
            console.error(`[ZamundaRIP] Error for ${result.id}:`, e.message);
        }
    }

    // Scrape seeders from trackers in parallel for all streams
    console.log(`[ZamundaRIP] Scraping seeders for ${streams.length} streams...`);
    const scrapeResults = await Promise.all(
        streams.map(s => getSeeders(s.sources, s.infoHash))
    );

    // Build final Stremio stream objects with seeders info
    const finalStreams = streams.map((s, i) => {
        const info = scrapeResults[i] || { seeders: -1, leechers: -1 };
        const seedLabel = info.seeders >= 0 ? `👤 ${info.seeders}` : '👤 ?';

        return {
            name: `${s.sourceLabel}${s.bgLabel}\n${s.quality}`,
            title: `${s.packLabel}${s.titleText}\n${seedLabel}\n📁 ${s.size}\n🌐 ${s.sourceLabel}`,
            infoHash: s.infoHash,
            sources: s.sources,
            behaviorHints: { bingeGroup: `zamunda-rip-${s.quality}` }
        };
    });

    // Cache streams
    if (finalStreams.length > 0) {
        streamCache.set(cacheKey, finalStreams);
    }

    console.log(`[ZamundaRIP] Returning ${finalStreams.length} streams for "${query}"`);
    return finalStreams;
}

module.exports = { getStreams };
