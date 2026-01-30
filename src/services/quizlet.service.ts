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

  async scrapeSet(url: string, userId: number) {
    if (!this.browser) await this.init();
    const page = await this.browser!.newPage();

    try {
      console.log(`Navigating to ${url}...`);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

      // Extract set title
      const title = await page.evaluate(() => {
        const titleEl = document.querySelector('h1');
        return titleEl ? titleEl.innerText : 'Unknown Set';
      });

      // Extract terms and definitions
      // Note: Quizlet selectors change frequently. This is a best-effort selector strategy.
      // We look for the "SetPageTerms-term" elements.
      const words = await page.evaluate(() => {
        const wordRows = document.querySelectorAll('.SetPageTerms-term');
        const extracted: { term: string; definition: string }[] = [];

        wordRows.forEach((row) => {
          const termEl = row.querySelector('.SetPageTerms-wordText .TermText');
          const defEl = row.querySelector('.SetPageTerms-definitionText .TermText');
          
          if (termEl && defEl) {
             // Clean up text
            const term = (termEl as HTMLElement).innerText.trim();
            const definition = (defEl as HTMLElement).innerText.trim();
            if (term && definition) {
                extracted.push({ term, definition });
            }
          }
        });
        return extracted;
      });

      console.log(`Found ${words.length} words in set "${title}".`);

      // Database Transaction
      await prisma.$transaction(async (tx) => {
        // Create or Update Set
        const set = await tx.set.upsert({
            where: { quizletId: url }, // Using URL as unique ID for simplicity (or extract ID from URL)
            update: { title, updatedAt: new Date() },
            create: {
                quizletId: url,
                title,
                url,
                userId,
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

      return { success: true, count: words.length, title };

    } catch (error) {
      console.error('Error scraping set:', error);
      return { success: false, error: 'Failed to scrape set' };
    } finally {
      await page.close();
    }
  }
}

export const quizletService = new QuizletSyncService();
