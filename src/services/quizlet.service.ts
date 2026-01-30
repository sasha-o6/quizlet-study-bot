import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { prisma } from './prisma.service';
import { Browser } from 'puppeteer';

puppeteer.use(StealthPlugin());

export class QuizletSyncService {
  private browser: Browser | null = null;

  async init() {
    this.browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async scrapeFolder(url: string, userId: number) {
    if (!this.browser) await this.init();
    const page = await this.browser!.newPage();

    try {
      console.log(`Navigating to folder ${url}...`);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

      // Extract Folder Name
      const folderName = await page.evaluate(() => {
          return document.querySelector('h1')?.innerText || 'Unknown Folder';
      });

      // Upsert Folder in DB to handle existing ones
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

      // Extract Set URLs from the folder
      const setUrls = await page.evaluate(() => {
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

      console.log(`Found ${setUrls.length} sets in folder "${folderName}".`);
      
      let totalWords = 0;
      let setsScraped = 0;

      for (const setUrl of setUrls) {
          // Check if set already exists to skip (Module level skipping)
          const existingSet = await prisma.set.findUnique({ where: { quizletId: setUrl } });
          if (existingSet) {
              console.log(`Set ${setUrl} already exists. Skipping.`);
              continue;
          }

          // Pass folderId to link the set
          const result = await this.scrapeSet(setUrl, userId, folder.id);
          if (result.success && result.count) {
              totalWords += result.count;
              setsScraped++;
          }
      }

      return { success: true, setsCount: setsScraped, totalWords };

    } catch (error) {
        console.error('Error scraping folder:', error);
        return { success: false, error: 'Failed to scrape folder' };
    } finally {
        await page.close();
    }
  }

  async scrapeSet(url: string, userId: number, folderId?: number) {
    if (!this.browser) await this.init();
    const page = await this.browser!.newPage();

    try {
      console.log(`Navigating to set ${url}...`);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

      // Extract set title
      const title = await page.evaluate(() => {
        const titleEl = document.querySelector('h1');
        return titleEl ? titleEl.innerText : 'Unknown Set';
      });

      // Extract terms and definitions using the new logic
      // All words are in [data-testid="terms-list"] -> .TermText
      // Odd index (1-based) / Even index (0-based) = Term
      // Even index (1-based) / Odd index (0-based) = Definition
      const words = await page.evaluate(() => {
        const termList = document.querySelector('[data-testid="terms-list"]');
        if (!termList) return [];

        const textElements = termList.querySelectorAll('.TermText');
        const extracted: { term: string; definition: string }[] = [];

        // Iterate in pairs
        for (let i = 0; i < textElements.length; i += 2) {
            const termEl = textElements[i] as HTMLElement;
            const defEl = textElements[i+1] as HTMLElement;

            if (termEl && defEl) {
                const term = termEl.innerText.trim();
                const definition = defEl.innerText.trim();
                if (term || definition) {
                    extracted.push({ term, definition });
                }
            }
        }
        return extracted;
      });

      console.log(`Found ${words.length} words in set "${title}".`);

      if (words.length > 0) {
        // Database Transaction
        await prisma.$transaction(async (tx) => {
            // Create or Update Set
            const set = await tx.set.upsert({
                where: { quizletId: url },
                update: { 
                    title, 
                    updatedAt: new Date(),
                    folderId: folderId ?? undefined // Update folder connection if provided
                },
                create: {
                    quizletId: url,
                    title,
                    url,
                    userId,
                    folderId: folderId // Connect to folder if provided
                }
            });

            // Upsert words
            for (const word of words) {
                await tx.word.upsert({
                    where: {
                        setId_term: {
                            setId: set.id,
                            term: word.term
                        }
                    },
                    update: { definition: word.definition },
                    create: {
                        term: word.term,
                        definition: word.definition,
                        setId: set.id
                    }
                });
            }
        });
      }

      return { success: true, count: words.length, title };

    } catch (error) {
      console.error('Error scraping set:', error);
      return { success: false, error: 'Failed to scrape set' };
    } finally {
      await page.close(); // Close page is safe here as checks are done
    }
  }
}

export const quizletService = new QuizletSyncService();
