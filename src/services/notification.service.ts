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

      // Find users who are active and need a notification
      const users = await prisma.user.findMany({
        where: { isActive: true },
        include: {
          sets: { include: { words: true } },
          savedSets: { include: { words: true } }
        }
      });

      for (const user of users) {
        // 1a. Quiet Days Check — use user's timezone
        const userDay = this.getUserLocalDay(now, user.timezone);
        if (user.quietDays && user.quietDays.includes(userDay)) continue;

        // 1b. Quiet Time Check — use user's timezone (hour + minute precision)
        const userHour = this.getUserLocalHour(now, user.timezone);
        const userMinute = this.getUserLocalMinute(now, user.timezone);
        const currentMinutes = userHour * 60 + userMinute;
        const startMinutes = user.quietStartHour * 60 + (user.quietStartMin || 0);
        const endMinutes = user.quietEndHour * 60 + (user.quietEndMin || 0);

        let inQuietHours = false;
        if (startMinutes > endMinutes) {
          // Spans midnight (e.g. 23:00 to 7:30)
          if (currentMinutes >= startMinutes || currentMinutes < endMinutes) inQuietHours = true;
        } else {
          if (currentMinutes >= startMinutes && currentMinutes < endMinutes) inQuietHours = true;
        }

        if (inQuietHours) continue;

        // 2. Schedule Check using nextNotificationTime
        // If nextNotificationTime is in the past, send notification
        if (now >= user.nextNotificationTime) {
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

    const learnedWordIds = new Set(reviews.filter((r: { isLearned: boolean }) => r.isLearned).map((r: { wordId: number }) => r.wordId));

    // Combine and deduplicate sets
    const allUserSets = [...user.sets, ...user.savedSets];
    const uniqueSetsMap = new Map();
    allUserSets.forEach((s: { id: number }) => uniqueSetsMap.set(s.id, s));
    const userSets = Array.from(uniqueSetsMap.values());

    // Flatten all words available for the user
    // Now we also filter by !isLearned
    const allWords = userSets
      .flatMap((s: { words: { id: number; term: string; definition: string }[] }) => s.words)
      .filter((w: { id: number }) => !learnedWordIds.has(w.id));

    if (allWords.length === 0) return;

    // Select random words
    const batchSize = user.wordsPerBatch;
    const selectedWords: { id: number; term: string; definition: string }[] = [];
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

    selectedWords.forEach((w: { id: number; term: string; definition: string }, index: number) => {
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

      // Calculate next notification time with randomization
      // Base interval in minutes
      const baseInterval = user.notificationInterval;
      // Variance: +/- 15%
      const variance = baseInterval * 0.05;
      const randomMinutes = Math.floor(Math.random() * (variance * 2 + 1)) - variance; // Range [-variance, +variance]
      const nextIntervalMinutes = baseInterval + randomMinutes;

      const nextTime = new Date();
      nextTime.setMinutes(nextTime.getMinutes() + nextIntervalMinutes);

      // Update last notification time and next schedule
      await prisma.user.update({
        where: { id: user.id },
        data: {
          lastNotification: new Date(),
          nextNotificationTime: nextTime
        }
      });

    } catch (e) {
      console.error(`Failed to send message to ${user.telegramId}:`, e);
      // If user blocked bot, maybe deactivate user? For now just log.
    }
  }

  private getUserLocalHour(now: Date, timezone: string): number {
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        hour12: false,
        timeZone: timezone || 'UTC',
      });
      return parseInt(formatter.format(now), 10);
    } catch {
      // Fallback if timezone string is invalid
      return now.getUTCHours();
    }
  }

  private getUserLocalMinute(now: Date, timezone: string): number {
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        minute: 'numeric',
        timeZone: timezone || 'UTC',
      });
      return parseInt(formatter.format(now), 10);
    } catch {
      return now.getUTCMinutes();
    }
  }

  private getUserLocalDay(now: Date, timezone: string): number {
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        weekday: 'short',
        timeZone: timezone || 'UTC',
      });
      const dayStr = formatter.format(now);
      const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      return dayMap[dayStr] ?? now.getUTCDay();
    } catch {
      return now.getUTCDay();
    }
  }
}

export const notificationService = new NotificationService();
