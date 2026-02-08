const axios = require('axios');

const ZAMUNDA_URL = 'https://zamunda.ch';

/**
 * Create axios client with auth cookies
 */
function createClient(uid, pass) {
    return axios.create({
        baseURL: ZAMUNDA_URL,
        headers: {
            'Cookie': `uid=${uid}; pass=${pass}`,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html',
            'Referer': ZAMUNDA_URL
        },
        timeout: 15000
    });
}

module.exports = { createClient, ZAMUNDA_URL };
