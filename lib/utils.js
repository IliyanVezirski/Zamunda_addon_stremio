const axios = require('axios');

/**
 * Get movie/series name from IMDB ID using Cinemeta
 * @param {string} type - 'movie' or 'series'
 * @param {string} imdbId - IMDB ID (e.g., 'tt1234567')
 * @returns {Promise<{name: string, year: number|null}>}
 */
async function getMetaFromImdb(type, imdbId) {
    try {
        const url = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;
        console.log(`[Utils] Fetching meta from: ${url}`);
        
        const response = await axios.get(url, { timeout: 10000 });
        const meta = response.data.meta;
        
        if (!meta || !meta.name) {
            throw new Error('No meta found');
        }

        const year = meta.releaseInfo ? parseInt(meta.releaseInfo.split('-')[0]) : null;
        
        console.log(`[Utils] Found meta: ${meta.name} (${year})`);
        return {
            name: meta.name,
            year: year,
            originalName: meta.name
        };
    } catch (error) {
        console.error(`[Utils] Failed to get meta for ${imdbId}:`, error.message);
        return null;
    }
}

/**
 * Parse series ID to extract season and episode
 * Format: tt1234567:1:5 (imdbId:season:episode)
 * @param {string} id 
 * @returns {{imdbId: string, season: number, episode: number}|null}
 */
function parseSeriesId(id) {
    const parts = id.split(':');
    if (parts.length !== 3) {
        return null;
    }
    
    return {
        imdbId: parts[0],
        season: parseInt(parts[1]),
        episode: parseInt(parts[2])
    };
}

/**
 * Format season/episode for search query
 * @param {number} season 
 * @param {number} episode 
 * @returns {string} e.g., "S01E05"
 */
function formatEpisode(season, episode) {
    const s = season.toString().padStart(2, '0');
    const e = episode.toString().padStart(2, '0');
    return `S${s}E${e}`;
}

/**
 * Extract quality info from torrent title
 * @param {string} title 
 * @returns {string}
 */
function extractQuality(title) {
    const lowerTitle = title.toLowerCase();
    
    if (lowerTitle.includes('2160p') || lowerTitle.includes('4k') || lowerTitle.includes('uhd')) {
        return '4K';
    }
    if (lowerTitle.includes('1080p')) {
        return '1080p';
    }
    if (lowerTitle.includes('720p')) {
        return '720p';
    }
    if (lowerTitle.includes('480p')) {
        return '480p';
    }
    if (lowerTitle.includes('dvdrip')) {
        return 'DVDRip';
    }
    if (lowerTitle.includes('hdtv')) {
        return 'HDTV';
    }
    if (lowerTitle.includes('webrip') || lowerTitle.includes('web-dl')) {
        return 'WEB';
    }
    if (lowerTitle.includes('bdrip') || lowerTitle.includes('bluray') || lowerTitle.includes('blu-ray')) {
        return 'BluRay';
    }
    
    return 'Unknown';
}

/**
 * Get quality rank for sorting (higher = better)
 */
function qualityRank(quality) {
    const ranks = {
        '4K': 6,
        '1080p': 5,
        'BluRay': 4,
        '720p': 3,
        'WEB': 3,
        'HDTV': 2,
        'DVDRip': 1,
        '480p': 1,
        'Unknown': 0
    };
    return ranks[quality] || 0;
}

/**
 * Extract size from string (e.g., "1.5 GB" -> "1.5 GB")
 * @param {string} sizeStr 
 * @returns {string}
 */
function formatSize(sizeStr) {
    if (!sizeStr) return '';
    
    // Clean up the size string
    const cleaned = sizeStr.trim().replace(/\s+/g, ' ');
    return cleaned;
}

/**
 * Create a search-friendly query from movie name
 * @param {string} name 
 * @returns {string}
 */
function sanitizeSearchQuery(name) {
    // Remove special characters, keep alphanumeric and spaces
    return name
        .replace(/[^\w\s\u0400-\u04FF]/g, ' ')  // Keep cyrillic characters too
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Delay helper for rate limiting
 * @param {number} ms 
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
    getMetaFromImdb,
    parseSeriesId,
    formatEpisode,
    extractQuality,
    qualityRank,
    formatSize,
    sanitizeSearchQuery,
    delay
};
