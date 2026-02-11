import { prisma } from './prisma.service';
import { flareSolverrService } from './flaresolverr.service';
import * as cheerio from 'cheerio';

export class QuizletSyncService {

    // Helper for random delays
    private async wait(min: number, max: number) {
        const time = Math.floor(Math.random() * (max - min + 1)) + min;
        return new Promise(resolve => setTimeout(resolve, time));
    }

    getSetIdFromUrl(url: string): string | null {
        const match = url.match(/quizlet\.com\/(?:[a-z]{2}\/)?(\d+)/);
        return match ? match[1] : null;
    }

    async scrapeFolder(url: string, userId: number) {
        try {
            console.log(`[Quizlet] Scraping folder: ${url}`);
            const html = await flareSolverrService.fetchProtectedUrl(url);
            const $ = cheerio.load(html);

            // Extract Folder Name
            const folderName = $('h1').first().text().trim() || 'Unknown Folder';
            console.log(`[Quizlet] Folder Name: ${folderName}`);

            // Upsert Folder
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

            // Extract Set URLs
            // Strategy: Look for Next.js data or links
            let setUrls: string[] = [];

            // 1. Try Next.js Data
            const nextDataScript = $('#__NEXT_DATA__').html();
            if (nextDataScript) {
                try {
                    const json = JSON.parse(nextDataScript);
                    const findUrl = (obj: any) => {
                        if (!obj) return;
                        if (typeof obj === 'object') {
                            if (obj.url && typeof obj.url === 'string' && obj.url.includes('/flash-cards/')) {
                                setUrls.push("https://quizlet.com" + obj.url);
                            }
                            // Also check for `webUrl` which sometimes appears
                            if (obj.webUrl && typeof obj.webUrl === 'string' && obj.webUrl.includes('/flash-cards/')) {
                                setUrls.push(obj.webUrl);
                            }
                            Object.values(obj).forEach(findUrl);
                        }
                    };
                    findUrl(json);
                } catch (e) {
                    console.error('Error parsing Next.js data for folder:', e);
                }
            }

            // 1.5. Check for Redux/Page Data in window
            // Sometimes data is in window.Quizlet or similar, but Cheerio sees static HTML.
            // If FlareSolverr evaluates JS, maybe we can get more. 
            // For now, let's stick to advanced selectors.


            // 2. Fallback to extracting links
            if (setUrls.length === 0) {
                // Try multiple selector patterns
                // User reported: [data-testid="content-list-item-card"]
                const selectors = [
                    '[data-testid="content-list-item-card"] a',
                    '.SetPreviewCard-header a',
                    'a[href*="/flash-cards/"]',
                    'a[href*="/learn/"]'
                ];

                selectors.forEach(sel => {
                    $(sel).each((_: number, el: any) => {
                        const href = $(el).attr('href');
                        if (href && (href.includes('/flash-cards/') || /\/\d+\//.test(href))) {
                            setUrls.push(href.startsWith('http') ? href : `https://quizlet.com${href}`);
                        }
                    });
                });
            }

            setUrls = [...new Set(setUrls)];
            console.log(`[Quizlet] Found ${setUrls.length} sets in folder.`);

            if (setUrls.length === 0) {
                console.log('[Debug] No sets found. HTML preview:');
                console.log(html.substring(0, 500));
                console.log('...HTML end...');
                // Try to save to file for inspection if running locally
                try {
                    require('fs').writeFileSync('debug_folder.html', html);
                    console.log('[Debug] Saved debug_folder.html');
                } catch (e) { }
            }

            setUrls = [...new Set(setUrls)];
            console.log(`[Quizlet] Found ${setUrls.length} sets in folder.`);

            let totalWords = 0;
            let setsScraped = 0;
            let failedCount = 0;

            for (const setUrl of setUrls) {
                // Check if set exists
                const existingSet = await prisma.set.findUnique({ where: { quizletId: setUrl } });
                if (existingSet) {
                    console.log(`[Quizlet] Set ${setUrl} already exists. Skipping.`);
                    continue;
                }

                // Scrape Set
                const result = await this.scrapeSet(setUrl, userId, folder.id);
                if (result.success) {
                    if (result.count) {
                        totalWords += result.count;
                        setsScraped++;
                    }
                } else {
                    failedCount++;
                    const errorMsg = 'error' in result ? result.error : "Unknown error";
                    console.error(`[Quizlet] Failed to scrape set ${setUrl}: ${errorMsg}`);
                }

                await this.wait(1000, 3000);
            }

            return { success: true, setsCount: setsScraped, totalWords, failedCount };

        } catch (error: any) {
            console.error('Error scraping folder:', error);
            return { success: false, error: `Failed to scrape folder: ${error.message}` };
        }
    }

    async scrapeSet(url: string, userId: number, folderId?: number) {
        console.log(`[Quizlet] Scraping set: ${url}`);

        // 1. Initial Duplicate Check
        const setId = this.getSetIdFromUrl(url);
        if (setId) {
            const existingSet = await prisma.set.findFirst({
                where: {
                    OR: [
                        { quizletId: setId },
                        { quizletId: url }
                    ]
                }
            });

            if (existingSet) {
                console.log(`[Quizlet] Set ${setId} already exists in DB.`);
                if (folderId && !existingSet.folderId) {
                    await prisma.set.update({
                        where: { id: existingSet.id },
                        data: { folderId }
                    });
                }
                return { success: true, count: 0, title: existingSet.title, message: 'Already exists' };
            }
        }

        try {
            const html = await flareSolverrService.fetchProtectedUrl(url);
            const $ = cheerio.load(html);

            // Extract terms
            let terms: { term: string, definition: string }[] = [];

            // 1. Try Next.js Data
            const nextDataScript = $('#__NEXT_DATA__').html();
            if (nextDataScript) {
                try {
                    const json = JSON.parse(nextDataScript);

                    // Recursive finder for studiableItems
                    const findItems = (obj: any): any[] | null => {
                        if (!obj || typeof obj !== 'object') return null;
                        if (Array.isArray(obj.studiableItems) && obj.studiableItems.length > 0) return obj.studiableItems;
                        for (const k in obj) {
                            const res = findItems(obj[k]);
                            if (res) return res;
                        }
                        return null;
                    };

                    const items = findItems(json);
                    if (items) {
                        terms = items.map((t: any) => ({
                            term: t.cardSides?.[0]?.media?.[0]?.plainText || t.word || '',
                            definition: t.cardSides?.[1]?.media?.[0]?.plainText || t.definition || ''
                        })).filter((t: any) => t.term || t.definition);
                    }
                } catch (e) {
                    console.error('Error parsing Next.js data for set:', e);
                }
            }

            // 2. Fallback DOM
            if (terms.length === 0) {
                console.log('[Quizlet] JSON extraction failed/empty. Trying DOM...');
                $('.TermText').each((i: number, el: any) => {
                    // Quizlet DOM structure usually alternates Term/Definition or groups them
                    // This is a naive selector, assuming parity. 
                    // Often it's better to find row containers.
                    // But let's try a robust container selector first.
                    // Actually, usually it is .SetPageTerm-content .SetPageTerm-side
                });

                // Better DOM strategy: iterate rows
                const rows = $('[data-testid="set-page-card-side"]');
                // Note: Class names are obfuscated, testids are safer if available.
                // If not, we fall back to TermText parity.
                const termTexts = $('.TermText');
                for (let i = 0; i < termTexts.length; i += 2) {
                    const term = $(termTexts[i]).text().trim();
                    const def = $(termTexts[i + 1]).text().trim();
                    if (term || def) {
                        terms.push({ term, definition: def });
                    }
                }
            }

            const title = $('h1').first().text().trim() || `Quizlet Set ${setId || 'Unknown'}`;
            console.log(`[Quizlet] Found ${terms.length} terms in "${title}"`);

            if (terms.length > 0) {
                await prisma.$transaction(async (tx) => {
                    const uniqueId = setId || url;
                    const set = await tx.set.upsert({
                        where: { quizletId: uniqueId },
                        update: { title, updatedAt: new Date(), folderId: folderId ?? undefined },
                        create: { quizletId: uniqueId, title, url, userId, folderId }
                    });

                    for (const word of terms) {
                        await tx.word.upsert({
                            where: { setId_term: { setId: set.id, term: word.term } }, // Assumes term uniqueness per set
                            update: { definition: word.definition },
                            create: { term: word.term, definition: word.definition, setId: set.id }
                        });
                    }
                });
                return { success: true, count: terms.length, title };
            }

            return { success: false, error: 'No words found.' };

        } catch (error: any) {
            console.error('Error scraping set:', error);
            return { success: false, error: `Failed to scrape set: ${error.message}` };
        }
    }
}

export const quizletService = new QuizletSyncService();
