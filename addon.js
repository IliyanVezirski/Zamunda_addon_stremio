const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');

const { getStreams } = require('./lib/zamundaService');
const { getMetaFromImdb, parseSeriesId, formatEpisode, sanitizeSearchQuery } = require('./lib/utils');

const manifest = {
    id: 'org.zamunda.stremio.addon',
    version: '1.1.0',
    name: 'Zamunda',
    description: 'Торенти от Zamunda.ch за Stremio',
    logo: 'https://i.imgur.com/wGXxPKV.png',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    config: [
        {
            key: 'username',
            type: 'text',
            title: 'Zamunda потребителско име'
        },
        {
            key: 'password',
            type: 'password',
            title: 'Zamunda парола'
        }
    ],
    behaviorHints: {
        configurable: true,
        configurationRequired: true
    }
};

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id, config }) => {
    console.log(`[Stream] type=${type} id=${id}`);

    const username = config?.username;
    const password = config?.password;

    if (!username || !password) {
        console.log('[Stream] Missing credentials');
        return { streams: [] };
    }

    try {
        let searchQuery = '';
        let meta = null;

        if (type === 'movie') {
            meta = await getMetaFromImdb('movie', id);
            if (!meta) return { streams: [] };
            searchQuery = meta.name;
            if (meta.year) searchQuery += ` ${meta.year}`;
        } else if (type === 'series') {
            const seriesInfo = parseSeriesId(id);
            if (!seriesInfo) return { streams: [] };
            meta = await getMetaFromImdb('series', seriesInfo.imdbId);
            if (!meta) return { streams: [] };
            searchQuery = `${meta.name} ${formatEpisode(seriesInfo.season, seriesInfo.episode)}`;
        } else {
            return { streams: [] };
        }

        console.log(`[Stream] Search: "${searchQuery}"`);
        searchQuery = sanitizeSearchQuery(searchQuery);

        let streams = await getStreams(username, password, searchQuery, type);

        // Fallback: try without year for movies
        if (streams.length === 0 && type === 'movie' && meta?.year) {
            console.log('[Stream] Retrying without year...');
            streams = await getStreams(username, password, sanitizeSearchQuery(meta.name), type);
        }

        // Fallback: try season search for series
        if (streams.length === 0 && type === 'series') {
            const si = parseSeriesId(id);
            if (si) {
                console.log('[Stream] Retrying with season search...');
                streams = await getStreams(username, password, sanitizeSearchQuery(`${meta.name} Season ${si.season}`), type);
            }
        }

        console.log(`[Stream] Found ${streams.length} streams`);
        return { streams };
    } catch (error) {
        console.error(`[Stream] Error:`, error.message);
        return { streams: [] };
    }
});

serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });
