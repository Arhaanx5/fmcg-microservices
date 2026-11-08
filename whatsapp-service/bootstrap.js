/**
 * Bootstrap script for WhatsApp Service
 * 
 * Sets PUPPETEER_EXECUTABLE_PATH before loading Puppeteer (via whatsapp-web.js),
 * which is critical when running as a Windows service under LocalSystem account.
 * 
 * LocalSystem's user profile is C:\WINDOWS\system32\config\systemprofile,
 * so Puppeteer can't find Chrome in its default cache location.
 * This script scans all user profiles to find the Puppeteer-managed Chrome.
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

function findChromePath() {
    const candidates = [];

    // 1. Current user's puppeteer cache
    const userHome = process.env.USERPROFILE || process.env.HOME || '';
    if (userHome) {
        candidates.push(join(userHome, '.cache', 'puppeteer', 'chrome'));
    }

    // 2. Scan all user profiles (critical for LocalSystem services)
    const usersDir = (process.env.SystemDrive || 'C:') + '\\Users';
    try {
        if (existsSync(usersDir)) {
            for (const user of readdirSync(usersDir)) {
                if (['Public', 'Default', 'Default User', 'All Users'].includes(user)) continue;
                candidates.push(join(usersDir, user, '.cache', 'puppeteer', 'chrome'));
            }
        }
    } catch (_) {}

    // 3. System-installed Chrome
    candidates.push(
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    );

    for (const candidate of candidates) {
        try {
            if (!existsSync(candidate)) continue;

            // Direct .exe file
            if (candidate.endsWith('.exe') && statSync(candidate).isFile()) {
                return candidate;
            }

            // Puppeteer cache directory — find chrome.exe inside
            if (statSync(candidate).isDirectory()) {
                const versions = readdirSync(candidate)
                    .filter(d => d.startsWith('win'))
                    .sort().reverse();
                for (const ver of versions) {
                    for (const sub of ['chrome-win64', 'chrome-win32']) {
                        const exePath = join(candidate, ver, sub, 'chrome.exe');
                        if (existsSync(exePath)) {
                            return exePath;
                        }
                    }
                }
            }
        } catch (_) {}
    }

    return null;
}

// ── Set environment variables BEFORE loading whatsapp-web.js / puppeteer ──
if (!process.env.PUPPETEER_EXECUTABLE_PATH) {
    const chromePath = findChromePath();
    if (chromePath) {
        process.env.PUPPETEER_EXECUTABLE_PATH = chromePath;
        // Set cache dir too for consistency
        const match = chromePath.match(/^(.*[\/\\]\.cache[\/\\]puppeteer)[\/\\]/);
        if (match) {
            process.env.PUPPETEER_CACHE_DIR = match[1];
        }
        console.log(`[BOOTSTRAP] ✅ Chrome auto-detected: ${chromePath}`);
    } else {
        console.error('[BOOTSTRAP] ⚠️ Could not find Chrome — Puppeteer may fail to start.');
    }
}

// ── Now load the actual server ──
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
await import(join('file:///', __dirname, 'server.js').replace(/\\/g, '/'));
