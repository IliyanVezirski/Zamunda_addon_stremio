const axios = require('axios');
const https = require('https');

const ZAMUNDA_IP = '104.21.23.130';
const ZAMUNDA_HOST = 'zamunda.ch';
const ZAMUNDA_URL = `https://${ZAMUNDA_IP}`;

/**
 * Create axios client with auth cookies - connects via IP, sends Host header
 */
function createClient(uid, pass) {
    return axios.create({
        baseURL: ZAMUNDA_URL,
        headers: {
            'Host': ZAMUNDA_HOST,
            'Cookie': `uid=${uid}; pass=${pass}`,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html',
            'Referer': `https://${ZAMUNDA_HOST}`
        },
        httpsAgent: new https.Agent({
            rejectUnauthorized: false,
            servername: ZAMUNDA_HOST
        }),
        timeout: 15000
    });
}

module.exports = { createClient, ZAMUNDA_URL };
