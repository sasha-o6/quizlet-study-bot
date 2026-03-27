import { prisma } from './prisma.service';
import { scraperService } from './scraper.service';
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

    private generateProgressBar(current: number, total: number, length: number = 10): string {
        const percent = Math.round((current / total) * 100);
        const filled = Math.round((current / total) * length);
        const empty = length - filled;
        return `${'█'.repeat(filled)}${'░'.repeat(empty)} ${percent}%`;
        // return `${'▄'.repeat(filled)}${'▁'.repeat(empty)} ${percent}%`;
    }

    async scrapeFolder(url: string, userId: number, onProgress?: (msg: string) => Promise<void>) {
        try {
            if (onProgress) await onProgress(`📂 Scraping folder: ${url}`);

            console.log(`[Quizlet] Scraping folder: ${url}`);
            const html = await scraperService.fetchProtectedUrl(url);
            const $ = cheerio.load(html);

            // Extract Folder Name
            const folderName = $('h1').first().text().trim() || 'Unknown Folder';
            console.log(`[Quizlet] Folder Name: ${folderName}`);

            if (onProgress) await onProgress(`📂 Folder: ${folderName}\n🔍 Finding sets...`);

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
                            if (obj.studyMaterialId) {
                                setUrls.push(`https://quizlet.com/ua/${obj.studyMaterialId}/`);
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
            // If ScraperService evaluates JS, maybe we can get more. 
            // For now, let's stick to advanced selectors.


            // 2. Fallback to extracting links
            if (setUrls.length === 0) {
                // Try multiple selector patterns - updated with user feedback
                const selectors = [
                    '[data-testid="content-list-item-card"] a', // Look for links inside the cards
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
                if (onProgress) await onProgress(`⚠️ Found 0 sets in "${folderName}". Checking debug...`);
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

            for (let i = 0; i < setUrls.length; i++) {
                const setUrl = setUrls[i];

                if (onProgress) {
                    const progress = Math.round((i / setUrls.length) * 10);
                    const bar = '🟩'.repeat(progress) + '⬜'.repeat(10 - progress);
                    await onProgress(`📁 Syncing "${folderName}"\n\n${bar}\n📈 Progress: ${i} / ${setUrls.length} sets`);
                }

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

    async scrapeSet(url: string, userId: number, folderId?: number, onProgress?: (msg: string) => Promise<void>) {
        console.log(`[Quizlet] Scraping set: ${url}`);
        if (onProgress) await onProgress(`📘 Connecting to set: ${url}...`);

        // 1. Initial Duplicate Check
        const setId = this.getSetIdFromUrl(url);
        if (setId) {
            const existingSet = await prisma.set.findFirst({
                where: {
                    OR: [
                        { quizletId: setId },
                        { quizletId: url }
                    ]
                },
                include: {
                    savedBy: { select: { id: true } },
                    _count: { select: { words: true } }
                }
            });

            if (existingSet) {
                console.log(`[Quizlet] Set ${setId} already exists in DB.`);

                const isAlreadySavedByThisUser = existingSet.userId === userId || existingSet.savedBy.some((u: any) => u.id === userId);

                if (!isAlreadySavedByThisUser) {
                    const updateData: any = { savedBy: { connect: { id: userId } } };
                    if (folderId && !existingSet.folderId) {
                        updateData.folderId = folderId;
                    }
                    await prisma.set.update({
                        where: { id: existingSet.id },
                        data: updateData
                    });
                    return { success: true, count: existingSet._count.words, title: existingSet.title };
                } else {
                    return { success: true, count: 0, title: existingSet.title, message: 'Already exists' };
                }
            }
        }

        try {
            if (onProgress) await onProgress(`📘 Fetching data...`);
            const html = await scraperService.fetchProtectedUrl(url);
            const $ = cheerio.load(html);

            // Extract terms
            let terms: { term: string, definition: string }[] = [];

            // 1. Try JSON-LD Data (schema.org/Quiz)
            const ldJsonScripts = $('script[type="application/ld+json"]');

            ldJsonScripts.each((_, el) => {
                try {
                    const content = $(el).html();
                    if (!content) return;

                    const data = JSON.parse(content);

                    // Allow both direct Object and Array of Objects
                    const processLdJson = (json: any) => {
                        if (json['@type'] === 'Quiz' && Array.isArray(json.hasPart)) {
                            const extractedTerms = json.hasPart
                                .filter((part: any) => part['@type'] === 'Question' && part.eduQuestionType === 'Flashcard')
                                .map((part: any) => ({
                                    term: part.text || '',
                                    definition: part.acceptedAnswer?.text || ''
                                }))
                                .filter((t: any) => t.term || t.definition);

                            if (extractedTerms.length > 0) {
                                terms = terms.concat(extractedTerms);
                            }
                        }
                    };

                    if (Array.isArray(data)) {
                        data.forEach(processLdJson);
                    } else {
                        processLdJson(data);
                    }
                } catch (e) {
                    console.error('Error parsing JSON-LD data for set:', e);
                }
            });

            // 2. Try __NEXT_DATA__ if not enough terms
            if (terms.length <= 15) {
                const nextDataScript = $('script#__NEXT_DATA__').html();
                if (nextDataScript) {
                    try {
                        const nextData = JSON.parse(nextDataScript);
                        
                        const findTerms = (obj: any) => {
                            if (!obj || typeof obj !== 'object') return;
                            
                            // Check for standard Quizlet term structure
                            if (obj.wordSide && obj.definitionSide) {
                                const termText = obj.wordSide.media?.find((m: any) => m.type === 1)?.plainText || '';
                                const defText = obj.definitionSide.media?.find((m: any) => m.type === 1)?.plainText || '';
                                
                                if (termText || defText) {
                                    if (!terms.some(t => t.term === termText && t.definition === defText)) {
                                        terms.push({ term: termText, definition: defText });
                                    }
                                }
                            } else if (Array.isArray(obj.cardSides) && obj.cardSides.length >= 2) {
                                // Newer Quizlet structure (studiableItems -> cardSides)
                                const wordSide = obj.cardSides.find((s: any) => s.label === 'word') || obj.cardSides[0];
                                const defSide = obj.cardSides.find((s: any) => s.label === 'definition') || obj.cardSides[1];
                                
                                const termText = wordSide.media?.[0]?.plainText || '';
                                const defText = defSide.media?.[0]?.plainText || '';
                                
                                if (termText || defText) {
                                    if (!terms.some(t => t.term === termText && t.definition === defText)) {
                                        terms.push({ term: termText, definition: defText });
                                    }
                                }
                            }
    
                            // Recurse
                            for (const key in obj) {
                                if (Object.prototype.hasOwnProperty.call(obj, key)) {
                                    if (typeof obj[key] === 'object') {
                                        findTerms(obj[key]);
                                    } else if (typeof obj[key] === 'string' && obj[key].startsWith('{') && (obj[key].includes('wordSide') || obj[key].includes('cardSides') || obj[key].includes('studiableItems'))) {
                                        try { findTerms(JSON.parse(obj[key])); } catch (e) {}
                                    }
                                }
                            }
                        };
                        
                        findTerms(nextData);
                    } catch (e) {
                        console.error('Error parsing __NEXT_DATA__:', e);
                    }
                }
            }

            // 3. Fallback DOM
            if (terms.length === 0) {
                console.log('[Quizlet] JSON extraction failed/empty. Trying DOM...');
                // Better DOM strategy: iterate rows
                // Look for both test IDs and legacy classes
                const rows = $('[data-testid="set-page-card-side"], .SetPageTerm-content');

                if (rows.length > 0) {
                    // The scraping logic for DOM might be specific to structure. 
                    // Assuming rows contain term and definition.
                    // The previous logic was a bit weak. Let's try iterating common containers.
                    // Actually, if we found rows via test-id, we can parse them.
                    // But let's stick to the previous text() parity logic if rows aren't cleanly paired.
                }

                // Previous parity logic (improved)
                const termTexts = $('.TermText');
                if (termTexts.length > 0) {
                    for (let i = 0; i < termTexts.length; i += 2) {
                        const term = $(termTexts[i]).text().trim();
                        const def = $(termTexts[i + 1]).text().trim();
                        if (term || def) {
                            terms.push({ term, definition: def });
                        }
                    }
                }
            }

            const title = $('h1').first().text().trim() || `Quizlet Set ${setId || 'Unknown'}`;
            console.log(`[Quizlet] Found ${terms.length} terms in "${title}"`);

            if (onProgress) {
                await onProgress(`📘 **${title}**\nFound ${terms.length} terms. Saving...`);
            }

            if (terms.length > 0) {
                // Upsert Set First
                await prisma.set.upsert({
                    where: { quizletId: setId || url },
                    update: {
                        title,
                        updatedAt: new Date(),
                        folderId: folderId ?? undefined,
                        savedBy: { connect: { id: userId } }
                    },
                    create: {
                        quizletId: setId || url,
                        title,
                        url,
                        userId,
                        folderId,
                        savedBy: { connect: { id: userId } }
                    }
                });

                // Retrieve Set ID for words
                const set = await prisma.set.findUnique({ where: { quizletId: setId || url } });
                if (!set) throw new Error("Set not found after upsert");

                let wordsAdded = 0;
                const totalTerms = terms.length;

                // Initial Progress
                if (onProgress) {
                    const bar = this.generateProgressBar(0, totalTerms);
                    await onProgress(`📘 **${title}**\n${0} / ${totalTerms}\n${bar}`);
                }

                for (let i = 0; i < totalTerms; i++) {
                    const word = terms[i];

                    // Update progress every 5 words or so to reduce spam
                    if (onProgress && (i % 5 === 0 || i === totalTerms - 1)) {
                        const bar = this.generateProgressBar(i, totalTerms);
                        await onProgress(`📘 **${title}**\n${i} / ${totalTerms}\n${bar}\nSaving word: "${word.term.slice(0, 15)}"...`);
                    }

                    await prisma.word.upsert({
                        where: { setId_term: { setId: set.id, term: word.term } },
                        update: { definition: word.definition },
                        create: { term: word.term, definition: word.definition, setId: set.id }
                    });
                    wordsAdded++;
                }

                if (onProgress) {
                    const bar = this.generateProgressBar(totalTerms, totalTerms);
                    await onProgress(`📘 **${title}**\n${totalTerms} / ${totalTerms}\n${bar}\n✅ Set Saved!\n\nAdded/Updated: ${wordsAdded}\nTotal Words: ${totalTerms}`);
                }

                return { success: true, count: terms.length, title };
            }

            return { success: false, error: 'No words found.' };

        } catch (error: any) {
            console.error('Error scraping set:', error);
            if (onProgress) await onProgress(`❌ Error scraping set: ${error.message}`);
            return { success: false, error: `Failed to scrape set: ${error.message}` };
        }
    }
}

export const quizletService = new QuizletSyncService();
