import fs from 'fs/promises';
import path from 'path';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { prisma } from './prisma.service';
import { Browser } from 'puppeteer';

puppeteer.use(StealthPlugin());

export class QuizletSyncService {
    private browser: Browser | null = null;

    // Helper for random delays
    private async wait(min: number, max: number) {
        const time = Math.floor(Math.random() * (max - min + 1)) + min;
        return new Promise(resolve => setTimeout(resolve, time));
    }

    async init() {
        const args = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-blink-features=AutomationControlled', // Critical for stealth
            '--window-size=1920,1080'
        ];

        if (process.env.PROXY_URL) {
            console.log(`[Proxy] Using proxy: ${process.env.PROXY_URL}`);
            args.push(`--proxy-server=${process.env.PROXY_URL}`);
        }

        this.browser = await puppeteer.launch({
            headless: true,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
            args
        });
    }

    async autoScroll(page: any) {
        await page.evaluate(async () => {
            await new Promise<void>((resolve) => {
                let totalHeight = 0;
                const distance = 100;
                const timer = setInterval(() => {
                    const scrollHeight = document.body.scrollHeight;
                    window.scrollBy(0, distance);
                    totalHeight += distance;

                    if (totalHeight >= scrollHeight - window.innerHeight) {
                        clearInterval(timer);
                        resolve();
                    }
                }, 100);
            });
        });
    }

    // New Helper: Extract data from Next.js hydration data
    async extractFromNextData(page: any) {
        return page.evaluate(() => {
            try {
                const nextData = document.querySelector('script[id="__NEXT_DATA__"]');
                if (!nextData) return null;

                const json = JSON.parse(nextData.innerHTML);

                let terms = null;

                const findKey = (obj: any, key: string): any => {
                    if (!obj || typeof obj !== 'object') return null;
                    if (key in obj) return obj[key];
                    for (const k in obj) {
                        const result = findKey(obj[k], key);
                        if (result) return result;
                    }
                    return null;
                };

                const setModel = findKey(json, 'studySet');
                if (setModel && setModel.studiableItems) {
                    terms = setModel.studiableItems;
                } else if (findKey(json, 'studiableItems')) {
                    terms = findKey(json, 'studiableItems');
                }

                if (!terms || !Array.isArray(terms)) return null;

                return terms.map((t: any) => ({
                    term: t.cardSides?.[0]?.media?.[0]?.plainText || t.word || '',
                    definition: t.cardSides?.[1]?.media?.[0]?.plainText || t.definition || ''
                })).filter((t: any) => t.term && t.definition);

            } catch (e) {
                return null;
            }
        });
    }

    async loadCookies(page: any) {
        try {
            const cookiePath = path.resolve(process.cwd(), 'cookies.json');
            const cookiesExist = await fs.access(cookiePath).then(() => true).catch(() => false);

            if (cookiesExist) {
                const cookiesString = await fs.readFile(cookiePath, 'utf8');
                const rawCookies = JSON.parse(cookiesString);

                if (Array.isArray(rawCookies)) {
                    // Sanitize cookies for Puppeteer
                    const validCookies = rawCookies.map((c: any) => {
                        const cookie: any = {
                            name: c.name,
                            value: c.value,
                            domain: c.domain,
                            path: c.path || '/',
                            secure: c.secure,
                            httpOnly: c.httpOnly,
                        };

                        if (c.expirationDate) cookie.expires = c.expirationDate;

                        // Fix sameSite
                        if (c.sameSite === 'no_restriction' || c.sameSite === 'None') cookie.sameSite = 'None';
                        else if (c.sameSite === 'lax' || c.sameSite === 'Lax') cookie.sameSite = 'Lax';
                        else if (c.sameSite === 'strict' || c.sameSite === 'Strict') cookie.sameSite = 'Strict';
                        // If key is null or unknown, don't include it (Puppeteer protocol expects string or undefined)

                        return cookie;
                    });

                    await page.setCookie(...validCookies);
                    console.log(`[Cookies] Loaded ${validCookies.length} sanitized cookies from cookies.json`);
                }
            }
        } catch (error) {
            console.error('Error loading cookies:', error);
        }
    }

    async solveCloudflare(page: any) {
        try {
            console.log('Attempting to solve Cloudflare challenge...');
            await page.waitForSelector('#turnstile-wrapper iframe', { timeout: 3000 }).catch(() => null);

            // Try clicking shadow dom or iframe
            const frames = page.frames();
            for (const frame of frames) {
                try {
                    const button = await frame.$('.ctp-checkbox-label');
                    if (button) {
                        console.log('Found cloudflare checkbox, clicking...');
                        await button.click();
                        await this.wait(2000, 5000);
                        return;
                    }
                } catch (e) { }
            }

            // Fallback verify link
            const verifyLink = await page.$('a[href*="verify"]');
            if (verifyLink) await verifyLink.click();

        } catch (e) {
            console.log('Automated solving failed or not applicable');
        }
    }

    getSetIdFromUrl(url: string): string | null {
        const match = url.match(/quizlet\.com\/(?:[a-z]{2}\/)?(\d+)/);
        return match ? match[1] : null;
    }

    // Helper to build Cookie header from cookies.json
    async getCookieHeader(): Promise<string> {
        try {
            const cookiePath = path.resolve(process.cwd(), 'cookies.json');
            const data = await fs.readFile(cookiePath, 'utf8');
            const cookies = JSON.parse(data);
            if (!Array.isArray(cookies)) return '';

            return cookies.map((c: any) => `${c.name}=${c.value}`).join('; ');
        } catch (e) {
            console.error('Failed to load cookies for API:', e);
            return '';
        }
    }

    /*
    async scrapeSetViaApi(setId: string) {
        if (!this.browser) await this.init();
        const page = await this.browser!.newPage();
        try {
            await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

            const apiUrl = `https://quizlet.com/webapi/3.4/studiable-item-documents?filters%5BstudiableContainerId%5D=${setId}&filters%5BstudiableContainerType%5D=1&perPage=1000&page=1`;
            console.log(`[API] Fetching JSON from ${apiUrl}...`);

            await page.goto(apiUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

            // Check if we got JSON in body
            const data = await page.evaluate(() => {
                try {
                    return JSON.parse(document.body.innerText);
                } catch { return null; }
            });

            if (data && data.responses && data.responses[0] && data.responses[0].models) {
                const terms = data.responses[0].models.studiableItem.map((item: any) => ({
                    term: item.cardSides[0].media[0].plainText,
                    definition: item.cardSides[1].media[0].plainText
                }));
                return { success: true, count: terms.length, terms };
            }

            return { success: false, error: 'Invalid API response structure' };

        } catch (error) {
            console.error('[API] Scrape failed:', error);
            return { success: false, error: 'API Request Failed' };
        } finally {
            await page.close();
        }
    }
    */

    // Hybrid Method: Use Puppeteer to execute the API request (Bypasses TLS blocking)
    async scrapeSetViaPuppeteerApi(setId: string) {
        if (!this.browser) await this.init();
        const page = await this.browser!.newPage();

        try {
            await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

            // Go to base domain to set origin/cookies context
            console.log('[Puppeteer-API] Initializing browser context...');
            await page.goto('https://quizlet.com', { waitUntil: 'domcontentloaded', timeout: 30000 });

            const apiUrl = `https://quizlet.com/webapi/3.4/studiable-item-documents?filters%5BstudiableContainerId%5D=${setId}&filters%5BstudiableContainerType%5D=1&perPage=1000&page=1`;
            console.log(`[Puppeteer-API] Fetching JSON from ${apiUrl}...`);

            // Execute fetch INSIDE the browser
            const responseData = await page.evaluate(async (url) => {
                try {
                    const res = await fetch(url, {
                        method: 'GET',
                        headers: {
                            'Accept': 'application/json',
                            'X-Requested-With': 'XMLHttpRequest' // Mimic internal call
                        }
                    });

                    if (!res.ok) return { success: false, status: res.status, text: await res.text() };
                    return { success: true, data: await res.json() };
                } catch (e: any) {
                    return { success: false, error: e.toString() };
                }
            }, apiUrl);

            if (!responseData.success) {
                console.error(`[Puppeteer-API] Fetch failed: ${responseData.status} - ${responseData.text?.substring(0, 100)}`);
                return { success: false, error: `Browser Fetch Failed: ${responseData.status}` };
            }

            const data = responseData.data;

            if (data && data.responses && data.responses[0] && data.responses[0].models) {
                const terms = data.responses[0].models.studiableItem.map((item: any) => ({
                    term: item.cardSides[0].media[0].plainText,
                    definition: item.cardSides[1].media[0].plainText
                }));
                return { success: true, count: terms.length, terms };
            }

            return { success: false, error: 'Invalid API response structure' };

        } catch (error) {
            console.error('[Puppeteer-API] Execution failed:', error);
            return { success: false, error: 'Browser API Request Failed' };
        } finally {
            await page.close();
        }
    }

    async scrapeFolder(url: string, userId: number) {
        // Folder scraping usually requires the page to get the list of set IDs.
        // We will keep Puppeteer for Folder scraping for now as it's more complex to reverse engineer.
        if (!this.browser) await this.init();
        const page = await this.browser!.newPage();

        try {
            await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
            await page.setViewport({ width: 1920, height: 1080 });
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9',
            });
            // await this.loadCookies(page); // User disabled cookies

            console.log(`Navigating to folder ${url}...`);
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
            // await this.wait(2000, 5000); 

            // Debug: Check title
            const pageTitle = await page.title();
            console.log(`Page Title: "${pageTitle}"`);

            // Attempt JSON extraction for Folder Sets
            const nextDataSets = await page.evaluate(() => {
                try {
                    const script = document.querySelector('script[id="__NEXT_DATA__"]');
                    if (!script) return null;
                    const json = JSON.parse(script.innerHTML);

                    const sets: string[] = [];
                    const findUrl = (obj: any) => {
                        if (!obj) return;
                        if (typeof obj === 'object') {
                            if (obj.url && typeof obj.url === 'string' && obj.url.includes('/flash-cards/')) {
                                sets.push("https://quizlet.com" + obj.url);
                            }
                            Object.values(obj).forEach(findUrl);
                        }
                    };
                    findUrl(json);
                    return [...new Set(sets)];
                } catch { return null; }
            });

            let setUrls: string[] = [];

            if (nextDataSets && nextDataSets.length > 0) {
                console.log(`[JSON] Found ${nextDataSets.length} sets from data.`);
                setUrls = nextDataSets;
            } else {
                // Fallback to DOM
                await this.autoScroll(page);
                await this.wait(1000, 3000);
                setUrls = await page.evaluate(() => {
                    const cards = document.querySelectorAll('[data-testid="content-list-item-card"]');
                    const urls: string[] = [];
                    cards.forEach(card => {
                        const link = card.querySelector('a');
                        if (link && link.href) {
                            urls.push(link.href);
                        }
                    });
                    return urls;
                });
            }

            // Extract Folder Name
            const folderName = await page.evaluate(() => {
                return document.querySelector('h1')?.innerText || 'Unknown Folder';
            });

            // Upsert Folder in DB
            const folder = await prisma.folder.upsert({
                where: { quizletId: url },
                update: { name: folderName, updatedAt: new Date() },
                create: {
                    quizletId: url,
                    name: folderName,
                    url: url,
                    userId: userId
                }
            });

            console.log(`Found ${setUrls.length} sets in folder "${folderName}".`);

            let totalWords = 0;
            let setsScraped = 0;
            let failedCount = 0;

            for (const setUrl of setUrls) {
                const existingSet = await prisma.set.findUnique({ where: { quizletId: setUrl } });
                if (existingSet) {
                    console.log(`Set ${setUrl} already exists. Skipping.`);
                    continue;
                }

                // Small pause between sets to assume user usage
                await this.wait(3000, 7000);

                // Use new scrapeSet
                const result = await this.scrapeSet(setUrl, userId, folder.id);
                if (result.success) {
                    if (result.count) {
                        totalWords += result.count;
                        setsScraped++;
                    }
                } else {
                    failedCount++;
                    const errorMsg = 'error' in result ? result.error : "Unknown error";
                    console.error(`Failed to scrape set ${setUrl}: ${errorMsg}`);
                }
                // Rate limit
                await this.wait(1000, 3000);
            }

            return { success: true, setsCount: setsScraped, totalWords, failedCount };

        } catch (error) {
            console.error('Error scraping folder:', error);
            return { success: false, error: `Failed to scrape folder` };
        } finally {
            await page.close();
        }
    }

    async scrapeSet(url: string, userId: number, folderId?: number) {
        // 1. Initial Duplicate Check (by ID or URL)
        const setId = this.getSetIdFromUrl(url);

        if (setId) {
            // Check if set already exists in DB by ID or strict URL
            const existingSet = await prisma.set.findFirst({
                where: {
                    OR: [
                        { quizletId: setId },
                        { quizletId: url }
                    ]
                }
            });

            if (existingSet) {
                console.log(`Set ${setId} (or URL) already exists in DB. Skipping scrape.`);

                // If we are part of a folder sync, ensure the link exists
                if (folderId && !existingSet.folderId) {
                    await prisma.set.update({
                        where: { id: existingSet.id },
                        data: { folderId }
                    });
                    console.log(`Linked existing set ${existingSet.id} to folder ${folderId}`);
                }

                return { success: true, count: 0, title: existingSet.title, message: 'Already exists' };
            }
        }

        // 2. Try API via Browser Context
        if (setId) {
            console.log(`Extracted Set ID: ${setId}. Attempting Hybrid Browser-API scrape...`);
            const apiResult = await this.scrapeSetViaPuppeteerApi(setId);

            if (apiResult.success && apiResult.terms && apiResult.terms.length > 0) {
                console.log(`[Browser-API] Successfully fetched ${apiResult.count} words.`);

                const title = `Quizlet Set ${setId}`;

                await prisma.$transaction(async (tx) => {
                    // Prefer using the numeric ID as the unique identifier if possible
                    const uniqueId = setId || url;

                    const set = await tx.set.upsert({
                        where: { quizletId: uniqueId },
                        update: { title, updatedAt: new Date(), folderId: folderId ?? undefined },
                        create: { quizletId: uniqueId, title, url, userId, folderId }
                    });

                    for (const word of apiResult.terms) {
                        await tx.word.upsert({
                            where: { setId_term: { setId: set.id, term: word.term } },
                            update: { definition: word.definition },
                            create: { term: word.term, definition: word.definition, setId: set.id }
                        });
                    }
                });
                return { success: true, count: apiResult.count, title };
            } else {
                console.log(`[Browser-API] Failed: ${apiResult.error}`);
            }
        }

        console.log('API method failed. Attempting Fallback: Headful Puppeteer (XVFB)...');
        return await this.scrapeSetViaHeadfulPuppeteer(url, userId, folderId);

        // 2. Fallback to Browser Scraping (Cookies/DOM)
        // if (!this.browser) await this.init();
        // const page = await this.browser!.newPage();

        // try {
        //   await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        //   await page.setViewport({ width: 1920, height: 1080 });
        //   await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

        //   await this.loadCookies(page);

        //   console.log(`Navigating to set ${url}...`);
        //   await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        //   await this.wait(3000, 6000);

        //   let pageTitle = await page.title();
        //   console.log(`Page Title: "${pageTitle}"`);

        //   let content = await page.content();
        //   if (pageTitle.includes('Just a moment') || pageTitle.includes('Access denied') || 
        //       content.includes('Press & Hold to confirm you are a human') || content.includes('Verify you are human')) {

        //        console.error('Bot detected by Cloudflare. Attempting to solve...');
        //        await this.solveCloudflare(page);
        //        await this.wait(5000, 10000); 

        //        pageTitle = await page.title();
        //        content = await page.content();
        //        if (pageTitle.includes('Just a moment') || pageTitle.includes('Access denied') || content.includes('Press & Hold')) {
        //            return { success: false, error: 'Cloudflare blocked access. Please add valid cookies.json.' };
        //        }
        //   }

        //   // JSON Extraction from Next.js (Preferred)
        //   let words = await this.extractFromNextData(page);

        //   // Fallback to DOM
        //   if (!words || words.length === 0) {
        //       console.log('[JSON] Extraction failed. Falling back to DOM...');
        //       await this.autoScroll(page);
        //       await this.wait(2000, 4000);
        //       words = await page.evaluate(() => {
        //         const termList = document.querySelector('[data-testid="terms-list"]');
        //         if (!termList) return [];
        //         const textElements = termList.querySelectorAll('.TermText');
        //         const extracted: { term: string; definition: string }[] = [];
        //         for (let i = 0; i < textElements.length; i += 2) {
        //             const termEl = textElements[i] as HTMLElement;
        //             const defEl = textElements[i+1] as HTMLElement;
        //             if (termEl && defEl) {
        //                 extracted.push({ term: termEl.innerText.trim(), definition: defEl.innerText.trim() });
        //             }
        //         }
        //         return extracted;
        //       });
        //   }

        //   const title = await page.evaluate(() => document.querySelector('h1')?.innerText || 'Unknown Set');
        //   console.log(`Found ${words ? words.length : 0} words in set "${title}".`);

        //   if (words && words.length > 0) {
        //     await prisma.$transaction(async (tx) => {
        //         const set = await tx.set.upsert({
        //             where: { quizletId: url },
        //             update: { title, updatedAt: new Date(), folderId: folderId ?? undefined },
        //             create: { quizletId: url, title, url, userId, folderId }
        //         });

        //         for (const word of words) {
        //             await tx.word.upsert({
        //                 where: { setId_term: { setId: set.id, term: word.term } },
        //                 update: { definition: word.definition },
        //                 create: { term: word.term, definition: word.definition, setId: set.id }
        //             });
        //         }
        //     });
        //     return { success: true, count: words.length, title };
        //   } else {
        //      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        //      const filename = `debug_set_${timestamp}.html`;
        //      await fs.writeFile(path.resolve(process.cwd(), filename), await page.content());
        //      return { success: false, error: `No words found. HTML saved to ${filename}` };
        //   }

        // } catch (error) {
        //   console.error('Error scraping set:', error);
        //   return { success: false, error: 'Failed to scrape set' };
        // } finally {
        //   await page.close();
        // }
    }
    async scrapeSetViaHeadfulPuppeteer(url: string, userId: number, folderId?: number) {
        let browser: Browser | null = null;
        try {
            const args = [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-blink-features=AutomationControlled',
                '--window-size=1280,1024',
                // '--start-maximized'
            ];

            if (process.env.PROXY_URL) {
                args.push(`--proxy-server=${process.env.PROXY_URL}`);
            }

            // Launch HEADFUL browser (requires xvfb in Docker)
            browser = await puppeteer.launch({
                headless: false,
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
                args,
                defaultViewport: null
            });

            const page = await browser.newPage();
            await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

            await this.loadCookies(page);

            console.log(`[Headful] Navigating to set ${url}...`);
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await this.wait(3000, 6000);

            let pageTitle = await page.title();
            let content = await page.content();

            // Check for Cloudflare / Login Wall
            if (pageTitle.includes('Just a moment') || pageTitle.includes('Access denied') || content.includes('Verify you are human')) {
                console.log('[Headful] Cloudflare/Bot detection triggered. Attempting to solve...');
                await this.solveCloudflare(page);
                await this.wait(5000, 10000);

                // Re-check
                pageTitle = await page.title();
                content = await page.content();
                if (pageTitle.includes('Just a moment') || content.includes('Verify you are human')) {
                    return { success: false, error: 'Could not bypass Cloudflare even with Headful browser.' };
                }
            }

            // Attempt JSON scrape
            let words = await this.extractFromNextData(page);

            // Fallback DOM scrape
            if (!words || words.length === 0) {
                console.log('[Headful] JSON extraction failed. Falling back to DOM...');
                await this.autoScroll(page);
                await this.wait(2000, 4000);
                words = await page.evaluate(() => {
                    const termList = document.querySelector('[data-testid="terms-list"]');
                    if (!termList) return [];
                    const textElements = termList.querySelectorAll('.TermText');
                    const extracted: { term: string; definition: string }[] = [];
                    for (let i = 0; i < textElements.length; i += 2) {
                        const termEl = textElements[i] as HTMLElement;
                        const defEl = textElements[i + 1] as HTMLElement;
                        if (termEl && defEl) {
                            extracted.push({ term: termEl.innerText.trim(), definition: defEl.innerText.trim() });
                        }
                    }
                    return extracted;
                });
            }

            const title = await page.evaluate(() => document.querySelector('h1')?.innerText || 'Unknown Set');
            console.log(`Found ${words ? words.length : 0} words in set "${title}".`);

            if (words && words.length > 0) {
                const setId = this.getSetIdFromUrl(url);
                const uniqueId = setId || url;

                await prisma.$transaction(async (tx) => {
                    const set = await tx.set.upsert({
                        where: { quizletId: uniqueId },
                        update: { title, updatedAt: new Date(), folderId: folderId ?? undefined },
                        create: { quizletId: uniqueId, title, url, userId, folderId }
                    });

                    for (const word of words!) {
                        await tx.word.upsert({
                            where: { setId_term: { setId: set.id, term: word.term } },
                            update: { definition: word.definition },
                            create: { term: word.term, definition: word.definition, setId: set.id }
                        });
                    }
                });
                return { success: true, count: words.length, title };
            }

            return { success: false, error: 'No words found in Headful mode.' };

        } catch (e: any) {
            console.error('[Headful] Scrape failed:', e);
            return { success: false, error: `Headful scrape failed: ${e.message}` };
        } finally {
            if (browser) await browser.close();
        }
    }
}

export const quizletService = new QuizletSyncService();
