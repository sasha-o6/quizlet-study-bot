import { CronJob } from 'cron';
import { Bot, Context } from 'grammy';
import { prisma } from './prisma.service';

export class NotificationService {
  private job: CronJob | null = null;
  private bot: Bot<Context> | null = null;

  constructor() { }

  init(bot: Bot<Context>) {
    this.bot = bot;
    // Run every 5 minutes
    this.job = new CronJob('*/5 * * * *', () => this.checkAndSend());
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

    // Flatten all words available for the user
    const allWords = user.sets.flatMap((s: any) => s.words);
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
    selectedWords.forEach(w => {
      message += `*${w.term}* - _${w.definition}_\n`;
    });

    try {
      await this.bot.api.sendMessage(Number(user.telegramId), message, { parse_mode: 'Markdown' });

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
