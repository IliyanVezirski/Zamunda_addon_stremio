const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const cors = require('cors');

const { getStreams, loginAndGetCookies } = require('./lib/zamundaService');
const { getMetaFromImdb, parseSeriesId, formatEpisode, sanitizeSearchQuery } = require('./lib/utils');

const PORT = process.env.PORT || 7000;

const manifest = {
    id: 'org.zamunda.stremio.addon',
    version: '1.0.0',
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
        return { streams: [] };
    }

    try {
        // Login (cached) and get cookies
        const cookies = await loginAndGetCookies(username, password);
        if (!cookies) {
            console.log('[Stream] Login failed');
            return { streams: [] };
        }

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

        let streams = await getStreams(cookies, searchQuery, type);

        // Fallback without year
        if (streams.length === 0 && type === 'movie' && meta?.year) {
            streams = await getStreams(cookies, sanitizeSearchQuery(meta.name), type);
        }

        // Fallback season pack
        if (streams.length === 0 && type === 'series') {
            const si = parseSeriesId(id);
            if (si) {
                streams = await getStreams(cookies, sanitizeSearchQuery(`${meta.name} Season ${si.season}`), type);
            }
        }

        console.log(`[Stream] Found ${streams.length} streams`);
        return { streams };

    } catch (error) {
        console.error(`[Stream] Error:`, error.message);
        return { streams: [] };
    }
});

const app = express();
app.use(cors());

app.get('/health', (req, res) => { res.json({ status: 'ok' }); });

const addonInterface = builder.getInterface();
const router = getRouter(addonInterface);
app.use(router);

// Fallback configure page
app.get('/configure', (req, res) => {
    res.redirect(`stremio://${req.get('host')}/manifest.json`);
});
app.get('/:config/configure', (req, res) => {
    res.redirect(`stremio://${req.get('host')}/manifest.json`);
});
app.get('/', (req, res) => {
    res.redirect(`stremio://${req.get('host')}/manifest.json`);
});

app.listen(PORT, () => {
    console.log(`Zamunda Addon v${manifest.version} - http://localhost:${PORT}`);
});
