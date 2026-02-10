const dgram = require('dgram');
const crypto = require('crypto');
const url = require('url');

/**
 * Scrape seeders/leechers from a UDP tracker for a given info_hash
 * @param {string} trackerUrl - e.g. "udp://tracker.opentrackr.org:1337/announce"
 * @param {string} infoHash - 40-char hex string
 * @param {number} timeoutMs - timeout in ms (default 3000)
 * @returns {Promise<{seeders: number, leechers: number, completed: number} | null>}
 */
function scrapeUDP(trackerUrl, infoHash, timeoutMs = 3000) {
    return new Promise((resolve) => {
        try {
            const parsed = new URL(trackerUrl.replace('/announce', '/scrape'));
            const host = parsed.hostname;
            const port = parseInt(parsed.port) || 80;
            const hashBuf = Buffer.from(infoHash, 'hex');

            const socket = dgram.createSocket('udp4');
            const transactionId = crypto.randomBytes(4);
            const connectionId = Buffer.from([0x00, 0x00, 0x04, 0x17, 0x27, 0x10, 0x19, 0x80]); // magic

            let timeout = setTimeout(() => {
                socket.close();
                resolve(null);
            }, timeoutMs);

            // Step 1: Connect
            const connectReq = Buffer.alloc(16);
            connectionId.copy(connectReq, 0);     // connection_id
            connectReq.writeUInt32BE(0, 8);        // action = connect
            transactionId.copy(connectReq, 12);    // transaction_id

            socket.on('message', (msg) => {
                if (msg.length < 8) return;
                const action = msg.readUInt32BE(0);
                const txId = msg.slice(4, 8);

                if (!txId.equals(transactionId)) return;

                if (action === 0 && msg.length >= 16) {
                    // Connect response — now scrape
                    const connId = msg.slice(8, 16);
                    const scrapeReq = Buffer.alloc(36);
                    connId.copy(scrapeReq, 0);          // connection_id
                    scrapeReq.writeUInt32BE(2, 8);       // action = scrape
                    transactionId.copy(scrapeReq, 12);   // transaction_id
                    hashBuf.copy(scrapeReq, 16);         // info_hash

                    socket.send(scrapeReq, 0, 36, port, host);
                } else if (action === 2 && msg.length >= 20) {
                    // Scrape response
                    clearTimeout(timeout);
                    const seeders = msg.readUInt32BE(8);
                    const completed = msg.readUInt32BE(12);
                    const leechers = msg.readUInt32BE(16);
                    socket.close();
                    resolve({ seeders, leechers, completed });
                }
            });

            socket.on('error', () => {
                clearTimeout(timeout);
                socket.close();
                resolve(null);
            });

            socket.send(connectReq, 0, 16, port, host);
        } catch (e) {
            resolve(null);
        }
    });
}

/**
 * Try multiple trackers and return the best (highest) seeders count
 * @param {string[]} trackers - array of tracker URLs
 * @param {string} infoHash - 40-char hex
 * @returns {Promise<{seeders: number, leechers: number}>}
 */
async function getSeeders(trackers, infoHash) {
    // Try up to 3 UDP trackers in parallel
    const udpTrackers = trackers.filter(t => t.startsWith('udp://')).slice(0, 3);

    if (udpTrackers.length === 0) {
        return { seeders: -1, leechers: -1 };
    }

    const results = await Promise.all(
        udpTrackers.map(t => scrapeUDP(t, infoHash, 3000))
    );

    let best = { seeders: -1, leechers: -1 };
    for (const r of results) {
        if (r && r.seeders > best.seeders) {
            best = { seeders: r.seeders, leechers: r.leechers };
        }
    }

    return best;
}

module.exports = { getSeeders };
