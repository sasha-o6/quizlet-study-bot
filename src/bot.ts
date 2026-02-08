import { Bot, session, Context } from 'grammy';
import { prisma } from './services/prisma.service';
import { quizletService } from './services/quizlet.service';
import { notificationService } from './services/notification.service';

// Basic error handling for bot
const botToken = process.env.BOT_TOKEN;
if (!botToken) {
  throw new Error('BOT_TOKEN is missing');
}

export const bot = new Bot(botToken);

// Middleware to ensure user exists in DB
bot.use(async (ctx, next) => {
  if (ctx.from?.id) {
    // Simple upsert logic could go here, or just lazy load in commands
  }
  await next();
});

// Commands
bot.command('start', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  try {
    await prisma.user.upsert({
      where: { telegramId: BigInt(userId) },
      update: { isActive: true },
      create: { telegramId: BigInt(userId) }
    });
    ctx.reply('Welcome! I will help you learn vocabulary. \n\nUse /add [url] to add a Quizlet set.\nUse /settings to configure intervals.');
  } catch (e) {
    console.error(e);
    ctx.reply('Error starting bot.');
  }
});

bot.command('add', async (ctx) => {
  const url = ctx.match;
  const userId = ctx.from?.id;
  if (!userId) return;
  if (!url) {
    return ctx.reply('Please provide a Quizlet URL: /add https://quizlet.com/...');
  }

  // Reply immediately to acknowledge command
  await ctx.reply('⏳ Starting sync... This might take a minute.');

  // Process in background so other users/commands are not blocked
  (async () => {
    try {
      // Find internal user ID
      const user = await prisma.user.findUnique({ where: { telegramId: BigInt(userId) } });
      if (!user) {
        return ctx.reply('User not found. Run /start first.');
      }

      if (url.includes('/folders/')) {
        await ctx.reply('📂 Detecting Folder... This may take a while to sync all sets.');
        const result = await quizletService.scrapeFolder(url, user.id);
        if (result.success) {
          let msg = `✅ Folder Sync Complete! Added ${result.setsCount} sets with ${result.totalWords} total words.`;
          if (result.failedCount && result.failedCount > 0) {
            msg += `\n⚠️ Failed to download ${result.failedCount} sets.`;
          }
          await ctx.reply(msg);
        } else {
          await ctx.reply(`❌ Failed to sync folder: ${result.error}`);
        }
      } else {
        const result = await quizletService.scrapeSet(url, user.id);
        if (result.success) {
          let msg = `✅ Success! Added ${result.count} words from "${result.title}".`;
          const message = (result as any).message;
          if (message) msg += ` (${message})`;
          await ctx.reply(msg);
        } else {
          const errorMsg = 'error' in result ? result.error : "Unknown error";
          await ctx.reply(`❌ Failed to sync: ${errorMsg}`);
        }
      }
    } catch (e) {
      console.error(e);
      await ctx.reply('An unexpected error occurred during sync.');
    }
  })();
});

bot.command('progress', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(userId) },
    include: { sets: { include: { _count: { select: { words: true } } } } }
  });

  if (!user) return ctx.reply('Not registered.');

  const totalWords = user.sets.reduce((acc, s) => acc + s._count.words, 0);
  const totalSets = user.sets.length;

  let msg = `📊 *Progres status*\n`;
  msg += `Set Count: ${totalSets}\n`;
  msg += `Total Words: ${totalWords}\n`;
  msg += `Active: ${user.isActive ? 'Yes' : 'No'}\n`;
  msg += `Interval: ${user.notificationInterval} mins\n`;
  msg += `Quiet Hours: ${user.quietStartHour}:00 - ${user.quietEndHour}:00\n`;

  ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.command('settings', async (ctx) => {
  // Simple command based settings for MVP
  ctx.reply('Use these commands to change settings:\n/interval [minutes] - Set notification frequency\n/batch [number] - Words per notification\n/quiet [start] [end] - Set quiet hours (0-23)');
});

bot.command('interval', async (ctx) => {
  const min = parseInt(ctx.match || '');
  if (isNaN(min) || min < 1) return ctx.reply('Invalid number.');

  await prisma.user.update({
    where: { telegramId: BigInt(ctx.from!.id) },
    data: { notificationInterval: min }
  });
  ctx.reply(`Interval set to ${min} minutes.`);
});

bot.command('batch', async (ctx) => {
  const num = parseInt(ctx.match || '');
  if (isNaN(num) || num < 1) return ctx.reply('Invalid number.');

  await prisma.user.update({
    where: { telegramId: BigInt(ctx.from!.id) },
    data: { wordsPerBatch: num }
  });
  ctx.reply(`Batch size set to ${num} words.`);
});

bot.command('quiet', async (ctx) => {
  const args = (ctx.match || '').split(' ').map(n => parseInt(n));
  if (args.length !== 2 || args.some(n => isNaN(n) || n < 0 || n > 23)) {
    return ctx.reply('Usage: /quiet [start_hour] [end_hour] (e.g., /quiet 23 7)');
  }

  await prisma.user.update({
    where: { telegramId: BigInt(ctx.from!.id) },
    data: { quietStartHour: args[0], quietEndHour: args[1] }
  });
  ctx.reply(`Quiet hours set: ${args[0]}:00 to ${args[1]}:00.`);
});

bot.command('pause', async (ctx) => {
  await prisma.user.update({
    where: { telegramId: BigInt(ctx.from!.id) },
    data: { isActive: false }
  });
  ctx.reply('Paused notifications.');
});

bot.command('resume', async (ctx) => {
  await prisma.user.update({
    where: { telegramId: BigInt(ctx.from!.id) },
    data: { isActive: true }
  });
  ctx.reply('Resumed notifications.');
});

// Start scheduler
notificationService.init(bot);
