/**
 * Simple in-memory cache with TTL
 */
class Cache {
    constructor(name, ttlMs) {
        this.name = name;
        this.ttl = ttlMs;
        this.store = new Map();
    }

    get(key) {
        const entry = this.store.get(key);
        if (!entry) return null;
        if (Date.now() - entry.timestamp > this.ttl) {
            this.store.delete(key);
            return null;
        }
        return entry.value;
    }

    set(key, value) {
        this.store.set(key, { value, timestamp: Date.now() });
    }

    get size() {
        return this.store.size;
    }

    // Clean expired entries periodically
    cleanup() {
        const now = Date.now();
        let cleaned = 0;
        for (const [key, entry] of this.store) {
            if (now - entry.timestamp > this.ttl) {
                this.store.delete(key);
                cleaned++;
            }
        }
        if (cleaned > 0) {
            console.log(`[Cache:${this.name}] Cleaned ${cleaned} expired entries, ${this.store.size} remaining`);
        }
    }
}

// Stream cache: IMDB ID -> streams array (2 hours)
const streamCache = new Cache('streams', 2 * 60 * 60 * 1000);

// Magnet cache: torrent ID -> magnet link (24 hours - these rarely change)
const magnetCache = new Cache('magnets', 24 * 60 * 60 * 1000);

// Search cache: query -> results array (1 hour)
const searchCache = new Cache('search', 1 * 60 * 60 * 1000);

// Cleanup every 30 minutes
setInterval(() => {
    streamCache.cleanup();
    magnetCache.cleanup();
    searchCache.cleanup();
}, 30 * 60 * 1000);

module.exports = { streamCache, magnetCache, searchCache };
