const axios = require('axios');

const WORKER_URL = process.env.WORKER_URL || 'https://zamunda-proxy.ilian-vezirski.workers.dev';

/**
 * Create axios client that routes through Cloudflare Worker
 */
function createClient(uid, pass) {
    const cookies = `uid=${uid}; pass=${pass}`;
    
    return {
        async get(path) {
            const url = `${WORKER_URL}/?path=${encodeURIComponent(path)}&cookies=${encodeURIComponent(cookies)}`;
            console.log(`[Client] GET ${path}`);
            
            const response = await axios.get(url, {
                timeout: 20000,
                headers: {
                    'Accept': 'text/html'
                }
            });
            
            return response;
        }
    };
}

module.exports = { createClient, WORKER_URL };
