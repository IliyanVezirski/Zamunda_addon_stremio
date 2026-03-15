const axios = require('axios');
const { extractQuality, qualityRank, delay } = require('./utils');
const { streamCache, searchCache } = require('./cache');
const { getSeeders } = require('./trackerScrape');

const BULTOR_BASE = 'https://www.bultor.net';

const VIDEO_CATEGORIES = new Set([
    'Movies', 'TV-Series', 'Anime', 'Documentary', 'Other'
]);

async function search(query, type, filter) {
    // Always use filter.name for searching - this is the clean name from the addon
    // The addon already provides just the movie/series name
    let searchName = filter?.name || query;
    
    // Clean up any remaining year or episode info just in case
    searchName = searchName.replace(/\b(19|20)\d{2}\b/g, '').replace(/\bS\d{1,2}E\d{1,2}\b/gi, '').replace(/\bSeason\s*\d+\b/gi, '').replace(/\s+/g, ' ').trim();
    
    const cached = searchCache.get(`bultor:${searchName}`);
    if (cached) {
        return cached;
    }

    console.log(`[Bultor] Search: "${searchName}" (type: ${type})`);

    try {
        const url = `${BULTOR_BASE}/search/?cat=&q=${encodeURIComponent(searchName)}`;
        const response = await axios.get(url, {
            timeout: 15000,
            headers: {
                'Accept': 'text/html',
                'User-Agent': 'Stremio-Zamunda-Addon/2.0'
            }
        });

        const html = response.data;
        const results = parseSearchResults(html);

        console.log(`[Bultor] Found ${results.length} results for "${query}"`);

        if (results.length > 0) {
            searchCache.set(`bultor:${query}`, results);
        }

        return results;
    } catch (e) {
        console.error('[Bultor] Search error:', e.message);
        return [];
    }
}

function parseSearchResults(html) {
    const results = [];
    const seen = new Set();

    // Find all info IDs first
    const infoIdRegex = /\/info\/([a-zA-Z0-9]+)/g;
    let idMatch;
    const ids = [];
    while ((idMatch = infoIdRegex.exec(html)) !== null) {
        const infoId = idMatch[1];
        if (!seen.has(infoId)) {
            seen.add(infoId);
            ids.push(infoId);
        }
    }

    // For each ID, try to extract more details from surrounding context
    for (const infoId of ids) {
        // Find the row containing this info link
        const idIndex = html.indexOf(`/info/${infoId}`);
        if (idIndex === -1) continue;

        // Get surrounding context (500 chars before and after)
        const start = Math.max(0, idIndex - 500);
        const end = Math.min(html.length, idIndex + 500);
        const context = html.substring(start, end);

        // Extract title - find the text between > and < after the info link
        let englishTitle = '';
        const titleMatch = context.match(/info\/[a-zA-Z0-9]+[^>]*>([^<\n]+)/);
        if (titleMatch) {
            englishTitle = titleMatch[1].trim();
        }

        // Extract quality
        let quality = 'Unknown';
        if (context.includes('bi-badge-4k') || context.includes('title="Movie 4K"')) {
            quality = '4K';
        } else if (context.includes('bi-badge-hd-fill') || context.includes('title="Movie HD"')) {
            quality = '1080p';
        } else if (context.includes('bi-badge-sd-fill') || context.includes('title="Movie SD"')) {
            quality = '480p';
        } else if (englishTitle.includes('2160p') || englishTitle.includes('4k') || englishTitle.includes('uhd')) {
            quality = '4K';
        } else if (englishTitle.includes('1080p') || englishTitle.includes('1080i')) {
            quality = '1080p';
        } else if (englishTitle.includes('720p')) {
            quality = '720p';
        }

        // Check for BG audio
        const isBgAudio = context.includes('bgaudio.gif');

        results.push({
            id: infoId,
            infoUrl: `${BULTOR_BASE}/info/${infoId}`,
            englishTitle,
            quality,
            isBgAudio
        });
    }

    return results;
}

async function fetchMagnet(infoUrl) {
    try {
        const response = await axios.get(infoUrl, {
            timeout: 15000,
            headers: {
                'Accept': 'text/html',
                'User-Agent': 'Stremio-Zamunda-Addon/2.0'
            }
        });

        const html = response.data;
        
        const magnetMatch = html.match(/magnet:\?xt=urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/);
        
        if (!magnetMatch) return null;

        const infoHash = magnetMatch[1].toLowerCase();
        
        // Extract title from og:meta or title tag
        let title = '';
        const metaTitleMatch = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i);
        if (metaTitleMatch) {
            title = metaTitleMatch[1];
        }
        
        if (!title) {
            const titleTagMatch = html.match(/<title>([^<]+)<\/title>/i);
            if (titleTagMatch) {
                title = titleTagMatch[1].split('|')[0].trim();
            }
        }
        
        // Also extract original torrent filename for quality detection
        let originalTitle = title;
        const fileNameMatch = html.match(/href="\/torrent\/[^"]+">([^<]+)<\/a>/i);
        if (fileNameMatch) {
            originalTitle = fileNameMatch[1];
        }
        
        // Look for any quality indicators in the HTML
        const qualityIndicators = html.match(/\b(2160p|4k|uhd|1080p|1080i|720p|480p|bluray|blu-ray|webrip|web-dl|hdtv|dvdrip)\b/gi);
        if (qualityIndicators && qualityIndicators.length > 0) {
            originalTitle += ' ' + qualityIndicators.join(' ');
        }
        
        const sizeMatch = html.match(/Размер:\s*([\d.,]+\s*[KMGT]b)/i);
        const size = sizeMatch ? sizeMatch[1] : '';
        
        const isBgAudio = html.includes('bgaudio.gif') || html.includes('Българско озвучение');
        
        return {
            infoHash,
            title,
            originalTitle,
            size,
            isBgAudio
        };
    } catch (e) {
        console.error('[Bultor] Fetch magnet error:', e.message);
        return null;
    }
}

function normalize(str) {
    return str.toLowerCase()
        .replace(/[^\w\s\u0400-\u04FF]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractYears(str) {
    const matches = str.match(/\b(19\d{2}|20\d{2})\b/g);
    return matches ? matches.map(Number) : [];
}

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
    if (/^(19|20)\d{2}$/.test(word)) return true;
    if (filter?.season && (word === 'season' || /^\d{1,2}$/.test(word))) return true;
    return false;
}

function extractTitlePart(torrentTitle) {
    const norm = normalize(torrentTitle);
    const markerRegex = /\b((?:19|20)\d{2}|2160p|1080[pi]|720p|480p|360p|4k|uhd|bluray|blu ray|bdrip|bdremux|webrip|web[\s-]?dl|webdl|hdtv|pdtv|dvdrip|hdrip|hdcam|telesync|remux|x264|x265|h\s?264|h\s?265|hevc|avc|aac|dts|ac3|s\d{2}e\d{2}|s\d{2}\s|season\s+\d|complete|multi)\b/;
    const match = norm.match(markerRegex);
    if (match) {
        return norm.substring(0, match.index).trim();
    }
    return norm;
}

function matchesFilter(torrentTitle, filter) {
    if (!filter || !filter.name) return true;

    const normName = normalize(filter.name);
    const titlePart = extractTitlePart(torrentTitle);

    let titleMatches = false;

    if (titlePart === normName) {
        titleMatches = true;
    }

    if (!titleMatches && titlePart.startsWith(normName)) {
        const extra = titlePart.substring(normName).trim();
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
        return false;
    }

    if (filter.year) {
        const torrentYears = extractYears(torrentTitle);
        if (torrentYears.length > 0) {
            if (!torrentYears.includes(filter.year)) {
                return false;
            }
        }
    }

    if (filter.season) {
        const normTitle = normalize(torrentTitle);
        const sMatches = normTitle.match(/\bs(\d{1,2})\b/g);
        if (sMatches) {
            const seasons = sMatches.map(s => parseInt(s.replace('s', '')));
            if (!seasons.includes(filter.season)) {
                return false;
            }
        }
        const seasonWordMatches = normTitle.match(/season\s+(\d+)/g);
        if (seasonWordMatches && !sMatches) {
            const seasons = seasonWordMatches.map(s => parseInt(s.match(/\d+/)[0]));
            if (!seasons.includes(filter.season)) {
                return false;
            }
        }
    }

    return true;
}

function isSeasonPack(title) {
    const norm = normalize(title);
    const hasSeasonOnly = /\bs\d{1,2}\b/.test(norm) && !/\bs\d{1,2}e\d{1,2}\b/.test(norm);
    const hasSeasonWord = /\b(season\s+\d|complete)\b/.test(norm);
    return hasSeasonOnly || hasSeasonWord;
}

async function getStreams(query, type, filter) {
    const cacheKey = `bultor:${query}:${type}`;
    const cached = streamCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    const results = await search(query, type, filter);
    console.log(`[Bultor] ${results.length} results for "${filter?.name}" (${filter?.year || '?'})`);

    const streams = [];

    for (const result of results.slice(0, 10)) {
        try {
            const magnetData = await fetchMagnet(result.infoUrl);
            if (!magnetData || !magnetData.infoHash) continue;

            // Use English title from search results if available, otherwise use Bulgarian
            const displayTitle = result.englishTitle || magnetData.title;
            
            // Use quality from search results if available, otherwise extract from title
            const quality = result.quality !== 'Unknown' ? result.quality : (extractQuality(result.englishTitle || magnetData.title) || 'Unknown');

            // STRICT filtering for series
            let passesFilter = true;
            
            if (type === 'series') {
                const title = normalize(result.englishTitle || magnetData.title);
                const season = parseInt(filter.season, 10);
                const episode = filter.episode ? parseInt(filter.episode, 10) : null;
                const hasSeasonFilter = Number.isInteger(season);

                const sPad = String(season).padStart(2, '0');
                const hasCorrectSeason = !hasSeasonFilter ||
                    new RegExp(`\\bs${season}\\b`).test(title) ||
                    new RegExp(`\\bs${sPad}\\b`).test(title) ||
                    new RegExp(`\\bseason\\s*${season}\\b`).test(title);

                // Episode markers like E05 / EP05 / Episode 5
                const hasEpisodeInfo = /\be\d{1,2}\b|\bep\d{1,2}\b|\bepisode\s*\d{1,2}\b/i.test(title);
                const hasPackKeywords = /\bcomplete\b|\bfull\s*season\b|\bseason\s*pack\b/i.test(title);
                const hasSeasonMarker = /\bs\d{1,2}\b|\bseason\s*\d{1,2}\b/i.test(title);
                const seasonPackDetected = hasSeasonMarker && (!hasEpisodeInfo || hasPackKeywords);
                
                if (episode) {
                    // If searching for specific episode - must have episode info
                    if (hasEpisodeInfo) {
                        // Has episode info - check both season and episode
                        const ePad = String(episode).padStart(2, '0');
                        const hasCorrectEpisode =
                            new RegExp(`\\be${episode}\\b`).test(title) ||
                            new RegExp(`\\be${ePad}\\b`).test(title) ||
                            new RegExp(`\\bep${episode}\\b`).test(title) ||
                            new RegExp(`\\bep${ePad}\\b`).test(title) ||
                            new RegExp(`\\bepisode\\s*${episode}\\b`).test(title);
                        if (!hasCorrectSeason || !hasCorrectEpisode) {
                            passesFilter = false;
                        }
                    } else {
                        // No episode info but has correct season - allow season pack
                        if (!hasCorrectSeason || !seasonPackDetected) {
                            passesFilter = false;
                        }
                    }
                } else {
                    // No episode specified - only require season match (allow season packs)
                    if (!hasCorrectSeason) {
                        passesFilter = false;
                    }
                }
            }
            
            // For movies, filter by year
            if (type === 'movie' && filter.year) {
                const torrentYears = extractYears(result.englishTitle || magnetData.title);
                if (torrentYears.length > 0 && !torrentYears.includes(filter.year)) {
                    passesFilter = false;
                }
            }
            
            if (!passesFilter) {
                continue;
            }

            const trackers = [
                'udp://tracker.opentrackr.org:1337/announce',
                'udp://open.stealth.si:80/announce',
                'udp://exodus.desync.com:6969/announce',
                'udp://tracker.torrent.eu.org:451/announce',
                'udp://tracker.openbittorrent.com:6969/announce',
                'udp://explodie.org:6969/announce',
                'udp://tracker.moeking.me:6969/announce',
                'udp://p4p.arenabg.com:1337/announce',
                'http://tracker.opentrackr.org:1337/announce'
            ];

            const sourceLabel = 'Bultor.net';
            const bgLabel = (result.isBgAudio || magnetData.isBgAudio) ? ' 🇧🇬' : '';

            const isPack = type === 'series' && isSeasonPack(result.englishTitle || magnetData.title);
            const packLabel = type === 'series' ? (isPack ? 'Season Pack | ' : 'Release | ') : '';

            // Use English title in magnet link for better compatibility
            const magnetTitle = result.englishTitle || magnetData.title;
            const magnet = `magnet:?xt=urn:btih:${magnetData.infoHash}&dn=${encodeURIComponent(magnetTitle)}&tr=${trackers.map(t => encodeURIComponent(t)).join('&tr=')}`;

            streams.push({
                infoHash: magnetData.infoHash,
                magnet,
                sources: trackers,
                quality: quality,
                sourceLabel,
                bgLabel,
                packLabel,
                titleText: displayTitle.substring(0, 70),
                size: magnetData.size || 'N/A',
            });
        } catch (e) {
            console.error(`[Bultor] Error for ${result.id}:`, e.message);
        }
    }

    console.log(`[Bultor] Scraping seeders for ${streams.length} streams...`);
    const scrapeResults = await Promise.all(
        streams.map(s => getSeeders(s.sources, s.infoHash))
    );

    const finalStreams = streams.map((s, i) => {
        const info = scrapeResults[i] || { seeders: -1, leechers: -1 };
        const seedLabel = info.seeders >= 0 ? `👤 ${info.seeders}` : '👤 ?';

        return {
            name: `${s.sourceLabel}${s.bgLabel}\n${s.quality}`,
            title: `${s.packLabel}${s.titleText}\n${seedLabel}\n📁 ${s.size}\n🌐 ${s.sourceLabel}`,
            infoHash: s.infoHash,
            sources: [
                `dht:${s.infoHash}`,
                ...s.sources.map(t => t.startsWith('tracker:') ? t : 'tracker:' + t)
            ],
            behaviorHints: { bingeGroup: `bultor-${s.quality}` },
            _qualityRank: qualityRank(s.quality) || 0,
            _seeders: info.seeders >= 0 ? info.seeders : 0
        };
    });

    // Sort by quality (desc), then by seeders (desc)
    finalStreams.sort((a, b) => {
        if (b._qualityRank !== a._qualityRank) {
            return b._qualityRank - a._qualityRank;
        }
        return b._seeders - a._seeders;
    });

    // Remove internal sorting fields
    finalStreams.forEach(s => {
        delete s._qualityRank;
        delete s._seeders;
    });

    if (finalStreams.length > 0) {
        streamCache.set(cacheKey, finalStreams);
    }

    console.log(`[Bultor] Returning ${finalStreams.length} streams for "${query}"`);
    return finalStreams;
}

module.exports = { getStreams };
