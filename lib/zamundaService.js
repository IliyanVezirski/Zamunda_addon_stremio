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
        return cached;
    }

    console.log(`[Search] Query: "${query}" — no cache, calling Worker...`);
    const client = createClient(uid, pass);
    const url = `/bananas?search=${encodeURIComponent(query)}&incldead=0&field=name&cat=0`;

    const response = await client.get(url);
    const html = response.data;

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
    console.log(`[Search] Found ${results.length} video results for "${query}"`);

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

    console.log(`[Magnet] ID ${torrentId} — no cache, calling Worker...`);
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
    'part', 'vol', 'volume', 'season'
]);

/** Allowed extra word after series/movie name: edition words, or "season" + number for series */
function isAllowedExtraWord(word, filter) {
    if (EDITION_WORDS.has(word)) return true;
    if (filter?.season && (word === 'season' || /^\d{1,2}$/.test(word))) return true;
    return false;
}

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
            titleMatches = extraWords.every(w => isAllowedExtraWord(w, filter));
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
                titleMatches = extraWords.every(w => isAllowedExtraWord(w, filter));
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

    // --- Season check (for series) ---
    if (filter.season) {
        const normTitle = normalize(torrentTitle);
        // Match S01, S02, etc.
        const sMatches = normTitle.match(/\bs(\d{1,2})\b/g);
        if (sMatches) {
            const seasons = sMatches.map(s => parseInt(s.replace('s', '')));
            if (!seasons.includes(filter.season)) {
                console.log(`[Filter] SKIP (season mismatch): "${torrentTitle}" has S${seasons.join(',S')}, expected S${String(filter.season).padStart(2, '0')}`);
                return false;
            }
        }
        // Match "Season 1", "Season 2", etc.
        const seasonWordMatches = normTitle.match(/season\s+(\d+)/g);
        if (seasonWordMatches && !sMatches) {
            const seasons = seasonWordMatches.map(s => parseInt(s.match(/\d+/)[0]));
            if (!seasons.includes(filter.season)) {
                console.log(`[Filter] SKIP (season mismatch): "${torrentTitle}" has Season ${seasons.join(',')}, expected Season ${filter.season}`);
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
    // Has S01, S02 etc. but NOT S01E01
    const hasSeasonOnly = /\bs\d{1,2}\b/.test(norm) && !/\bs\d{1,2}e\d{1,2}\b/.test(norm);
    // Or has "Season X" / "Complete"
    const hasSeasonWord = /\b(season\s+\d|complete)\b/.test(norm);
    return hasSeasonOnly || hasSeasonWord;
}

/**
 * Video file extensions
 */
const VIDEO_EXTENSIONS = new Set(['mkv', 'mp4', 'avi', 'wmv', 'flv', 'mov', 'm4v', 'ts', 'webm']);

/**
 * Get file list from a torrent's detail page on Zamunda
 * @returns {Array<{name: string, size: string, index: number}>}
 */
async function getFileList(uid, pass, torrentId) {
    const client = createClient(uid, pass);
    console.log(`[Files] Fetching file list for torrent ${torrentId}...`);

    const response = await client.get(`/banan?id=${torrentId}`);
    const html = response.data;
    const $ = cheerio.load(html);

    const files = [];
    const seen = new Set();
    const videoExt = /\.(mkv|mp4|avi|wmv|flv|mov|m4v|ts|webm)$/i;

    function addFile(name) {
        const base = (name || '').replace(/^.*[\/\\]/, '').trim();
        if (!base || !videoExt.test(base)) return;
        const key = base.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        files.push({ name: base, index: files.length });
    }

    // 1. Table rows: often first column is filename
    $('table tr').each((i, tr) => {
        $(tr).find('td').each((j, td) => {
            const text = $(td).text().trim();
            const match = text.match(/[\s\S]*?[\w\u0400-\u04FF.\-\s]{2,200}\.(mkv|mp4|avi|wmv|flv|mov|m4v|ts|webm)\b/i);
            if (match) addFile(match[0]);
        });
    });

    // 2. Any link href containing video extension
    $('a[href*=".mkv"], a[href*=".mp4"], a[href*=".avi"], a[href*=".m4v"]').each((i, el) => {
        const href = $(el).attr('href') || '';
        const decoded = decodeURIComponent(href);
        const m = decoded.match(/[^\s"'<>]+\.(mkv|mp4|avi|wmv|flv|mov|m4v|ts|webm)(?:\?|$)/i);
        if (m) addFile(m[0]);
    });

    // 3. Raw HTML: filenames with spaces (e.g. "Show S02E08 1080p.mkv")
    if (files.length === 0) {
        const raw = html.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
        const fileRegex = /[\w\u0400-\u04FF.\-\s]{3,180}\.(mkv|mp4|avi|wmv|flv|mov|m4v|ts|webm)(?=[\s"'<>)\]}\\]|$)/gi;
        let m;
        while ((m = fileRegex.exec(raw)) !== null) {
            addFile(m[0].trim());
        }
    }

    // 4. Body text (no tags) – filenames may be in plain text
    if (files.length === 0) {
        const bodyText = $('body').text();
        const fileRegex = /[\w\u0400-\u04FF.\-\s]{3,180}\.(mkv|mp4|avi|wmv|flv|mov|m4v|ts|webm)\b/g;
        let m;
        while ((m = fileRegex.exec(bodyText)) !== null) {
            addFile(m[0].trim());
        }
    }

    // 5. Quoted in HTML/JS
    if (files.length === 0) {
        const quoted = html.match(/["']([^"']{4,200}\.(?:mkv|mp4|avi|wmv|flv|mov|m4v|ts|webm))["']/gi);
        if (quoted) quoted.forEach(s => addFile(s.replace(/^["']|["']$/g, '')));
    }

    if (files.length === 0) {
        const idx = html.toLowerCase().indexOf('mkv');
        const snippet = idx >= 0 ? html.substring(Math.max(0, idx - 200), idx + 300) : html.substring(0, 500);
        console.log(`[Files] No files parsed; HTML snippet (around .mkv or start): ${snippet.replace(/\s+/g, ' ').substring(0, 400)}...`);
    }

    console.log(`[Files] Found ${files.length} video files in torrent ${torrentId}`);
    if (files.length > 0) {
        files.forEach(f => console.log(`[Files]   [${f.index}] ${f.name}`));
    }

    return files;
}

/**
 * Find the file index for a specific episode in a file list
 * @param {Array} files - Array of {name, index}
 * @param {number} season - Season number
 * @param {number} episode - Episode number
 * @returns {number|null} - File index or null if not found
 */
function findEpisodeFileIdx(files, season, episode) {
    if (!files || files.length === 0) return null;

    const sPad = String(season).padStart(2, '0');
    const ePad = String(episode).padStart(2, '0');

    // Priority 1: Exact S02E03 match
    for (const file of files) {
        const norm = file.name.toLowerCase();
        if (norm.includes(`s${sPad}e${ePad}`)) {
            console.log(`[Files] Episode match (S${sPad}E${ePad}): [${file.index}] ${file.name}`);
            return file.index;
        }
    }

    // Priority 2: Try variations like "E03", "Ep03", "Episode 3"
    for (const file of files) {
        const norm = file.name.toLowerCase();
        const epPatterns = [
            new RegExp(`\\be${ePad}\\b`),
            new RegExp(`\\bep\\.?\\s?${ePad}\\b`),
            new RegExp(`\\bepisode\\s*${episode}\\b`),
            new RegExp(`\\b${ePad}\\b`)  // Just the number as last resort
        ];
        for (const pattern of epPatterns) {
            if (pattern.test(norm)) {
                console.log(`[Files] Episode match (pattern ${pattern}): [${file.index}] ${file.name}`);
                return file.index;
            }
        }
    }

    // Priority 3: Sort files alphabetically and pick by episode number position
    // (some packs just have files in order)
    const videoFiles = files.filter(f => {
        const ext = f.name.split('.').pop().toLowerCase();
        return VIDEO_EXTENSIONS.has(ext);
    }).sort((a, b) => a.name.localeCompare(b.name));

    if (videoFiles.length >= episode) {
        const file = videoFiles[episode - 1];
        console.log(`[Files] Episode match (by position ${episode}/${videoFiles.length}): [${file.index}] ${file.name}`);
        return file.index;
    }

    console.log(`[Files] No episode match found for S${sPad}E${ePad} in ${files.length} files`);
    return null;
}

/**
 * Search and return Stremio streams (with full stream cache)
 */
async function getStreams(uid, pass, query, type, filter) {
    // Check stream cache (by query, not IMDB ID - covers fallback searches too)
    const cacheKey = `${query}:${type}`;
    const cached = streamCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    const results = await search(uid, pass, query);

    // Apply title/year filter to match only the specific movie/series
    const filtered = filter
        ? results.filter(r => matchesFilter(r.title, filter))
        : results;

    console.log(`[Filter] ${filtered.length}/${results.length} results match "${filter?.name}" (${filter?.year || '?'})`);

    const streams = [];

    for (const result of filtered.slice(0, 10)) {
        try {
            const magnet = await getMagnet(uid, pass, result.id);
            if (!magnet) continue;

            const hashMatch = magnet.match(/btih:([a-fA-F0-9]{40})/i);
            if (!hashMatch) continue;

            const trackers = magnet.match(/tr=([^&]+)/g)?.map(t => decodeURIComponent(t.replace('tr=', ''))) || [];

            const stream = {
                name: `Zamunda\n${result.quality}`,
                title: `${result.title.substring(0, 70)}\n👤 ${result.seeders}\n📁 ${result.size}\n🌐 Zamunda`,
                infoHash: hashMatch[1].toLowerCase(),
                sources: trackers,
                behaviorHints: { bingeGroup: `zamunda-${result.quality}` }
            };

            // Season packs: never show the pack — only add stream when we can extract the episode (fileIdx)
            if (type === 'series' && filter?.season && filter?.episode && isSeasonPack(result.title)) {
                console.log(`[Streams] Season pack detected: "${result.title}" — extracting S${String(filter.season).padStart(2,'0')}E${String(filter.episode).padStart(2,'0')}...`);
                try {
                    const files = await getFileList(uid, pass, result.id);
                    const fileIdx = findEpisodeFileIdx(files, filter.season, filter.episode);
                    if (fileIdx !== null) {
                        stream.fileIdx = fileIdx;
                        stream.title = `Ep. ${filter.episode} (from pack)\n👤 ${result.seeders}\n📁 ${result.size}\n🌐 Zamunda`;
                        console.log(`[Streams] Extracted episode fileIdx=${fileIdx}, not showing pack`);
                    } else {
                        console.log(`[Streams] Could not find episode in pack, skipping`);
                        continue;
                    }
                } catch (e) {
                    console.error(`[Streams] Error getting file list for ${result.id}:`, e.message);
                    continue;
                }
            }

            streams.push(stream);
            await delay(200);
        } catch (e) {
            console.error(`[Zamunda] Error for ${result.id}:`, e.message);
        }
    }

    // Cache streams
    if (streams.length > 0) {
        streamCache.set(cacheKey, streams);
    }

    console.log(`[Streams] Returning ${streams.length} streams for "${query}"`);
    return streams;
}

module.exports = { getStreams };
