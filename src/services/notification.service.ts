import { CronJob } from 'cron';
import { Bot, Context, InlineKeyboard } from 'grammy';
import { prisma } from './prisma.service';

export class NotificationService {
  private job: CronJob | null = null;
  private bot: Bot<Context> | null = null;

  constructor() { }

  init(bot: Bot<Context>) {
    this.bot = bot;
    // Run every 7 minutes
    this.job = process.env.NODE_ENV === 'development' ? new CronJob('*/1 * * * *', () => this.checkAndSend()) : new CronJob('*/7 * * * *', () => this.checkAndSend());
    this.job.start();
    console.log('Notification scheduler started.');
  }

  async checkAndSend() {
    if (!this.bot) return;

    try {
      const now = new Date();
      const currentHour = now.getHours();

      // Find users who are active and need a notification
      const users = await prisma.user.findMany({
        where: { isActive: true },
        include: { sets: { include: { words: true } } } // Simple include for MVP
      });

      for (const user of users) {
        // 1. Quiet Hours Check
        let inQuietHours = false;
        if (user.quietStartHour > user.quietEndHour) {
          // Spans midnight (e.g. 23 to 7)
          if (currentHour >= user.quietStartHour || currentHour < user.quietEndHour) inQuietHours = true;
        } else {
          // Standard day (e.g. 1 to 5) - rare but possible
          if (currentHour >= user.quietStartHour && currentHour < user.quietEndHour) inQuietHours = true;
        }

        if (inQuietHours) continue;

        // 2. Interval Check
        const timeSinceLast = now.getTime() - user.lastNotification.getTime();
        const intervalMs = user.notificationInterval * 60 * 1000;

        if (timeSinceLast >= intervalMs) {
          await this.sendBatch(user);
        }
      }

    } catch (error) {
      console.error('Error in notification loop:', error);
    }
  }

  async sendBatch(user: any) {
    if (!this.bot) return;

    // Filter out learned words
    // We need to fetch WordReview for this user to know what is learned
    const reviews = await prisma.wordReview.findMany({
      where: { userId: user.id },
      select: { wordId: true, isLearned: true }
    });

    const learnedWordIds = new Set(reviews.filter(r => r.isLearned).map(r => r.wordId));

    // Flatten all words available for the user
    // Now we also filter by !isLearned
    const allWords = user.sets
      .flatMap((s: any) => s.words)
      .filter((w: any) => !learnedWordIds.has(w.id));

    if (allWords.length === 0) return;

    // Select random words
    const batchSize = user.wordsPerBatch;
    const selectedWords: any[] = [];
    const usedIndices = new Set<number>();

    // Safety loop to prevent infinite loop if batchSize > total words
    const limit = Math.min(batchSize, allWords.length);

    while (selectedWords.length < limit) {
      const idx = Math.floor(Math.random() * allWords.length);
      if (!usedIndices.has(idx)) {
        usedIndices.add(idx);
        selectedWords.push(allWords[idx]);
      }
    }

    if (selectedWords.length === 0) return;

    // Construct Message
    let message = '';
    // `🎯 **Time to learn!**\n\n`;

    // Create Inline Keyboard for "Mark as Learned"
    const keyboard = new InlineKeyboard();

    selectedWords.forEach((w, index) => {
      const num = index + 1;
      message += `${num}. *${w.term}* - ${w.definition}\n`;
      keyboard.text(`[${num}]`, `learn:${w.id}`);
    });

    message += `\n\n Tap the number below to mark a word as learned.`;

    try {
      await this.bot.api.sendMessage(Number(user.telegramId), message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });

      // Update last notification time
      await prisma.user.update({
        where: { id: user.id },
        data: { lastNotification: new Date() }
      });

    } catch (e) {
      console.error(`Failed to send message to ${user.telegramId}:`, e);
      // If user blocked bot, maybe deactivate user? For now just log.
    }
  }
}

export const notificationService = new NotificationService();
