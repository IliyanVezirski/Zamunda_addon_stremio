const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const PORT = process.env.PORT || 7000;

try {
    const builder = new addonBuilder({
        id: 'org.zamunda-stremio-addon',
        version: '1.0.0',
        name: 'Zamunda Test',
        description: 'Provides magnet links from Zamunda.net',
        resources: ['catalog', 'stream'],
        types: ['movie', 'series'],
        catalogs: [
            {
                type: 'movie',
                id: 'zamunda-movies',
                name: 'Zamunda Movies'
            }
        ]
    });

    const testMovies = [
        {
            id: 'tt0376968',
            type: 'movie',
            name: 'The Return',
            poster: 'https://m.media-amazon.com/images/M/MV5BNDQ4MTEyNzk1MV5BMl5BanBnXkFtZTcwNzU3MjAzMQ@@._V1_SX300.jpg'
        }
    ];

    builder.defineCatalogHandler(async ({type, id, extra}) => {
        console.log('Request for catalog:', type, id);
        if (type === 'movie' && id === 'zamunda-movies') {
            return { metas: testMovies };
        }
        return { metas: [] };
    });

    builder.defineStreamHandler(async ({type, id}) => {
        console.log(`Request for streams: ${type} ${id}`);
        if (type !== 'movie') {
            return { streams: [] };
        }
        const searchUrl = `https://zamunda.net/bananas?search=${id}&got=1&incldead=1`;
        console.log(`Searching at: ${searchUrl}`);
        try {
            const response = await axios.get(searchUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                }
            });
            const $ = cheerio.load(response.data);
            const streams = [];
            $('table.bananas tr.firstr, tr.secstr').each((i, elem) => {
                const row = $(elem);
                const magnetLink = row.find('a[href^="magnet:"]').attr('href');
                const titleElement = row.find('td').eq(1).find('a');
                const title = titleElement.attr('title') || titleElement.text();
                if (magnetLink && title) {
                    let fileInfo = 'N/A';
                    if (title.toLowerCase().includes('1080p')) fileInfo = '1080p';
                    if (title.toLowerCase().includes('720p')) fileInfo = '720p';
                    if (title.toLowerCase().includes('dvdrip')) fileInfo = 'DVDrip';
                    streams.push({
                        title: `[Zamunda] ${title.substring(0, 100)}`,
                        url: magnetLink,
                        behaviorHints: {
                            bingeGroup: `zamunda-${fileInfo}`
                        }
                    });
                }
            });
            return { streams };
        } catch (error) {
            console.error(`Error fetching streams for ${id}:`, error.message);
            return { streams: [] };
        }
    });

    const addonInterface = builder.getInterface();
    const app = express();

    // Enable CORS
    app.use(cors());

    // Create the router from the addon interface and mount it
    const router = getRouter(addonInterface);
    app.use(router);

    // Start the server
    app.listen(PORT, () => {
        console.log(`Addon server running on http://localhost:${PORT}`);
        console.log(`Manifest available at /manifest.json`);
    });

} catch (e) {
    console.error('A critical error occurred:', e);
}
