import { bot } from './bot';
import { prisma } from './services/prisma.service';

async function main() {
  console.log('Starting Quizlet Bot...');

  // 1. Connect to DB
  try {
    await prisma.$connect();
    console.log('✅ Connected to Database');
  } catch (e) {
    console.error('❌ Database connection failed:', e);
    process.exit(1);
  }

  // 2. Start Bot
  bot.start({
    onStart: (botInfo) => {
      console.log(`✅ Bot @${botInfo.username} started!`);
    }
  });

  // Graceful shutdown
  process.once('SIGINT', () => {
    bot.stop();
    prisma.$disconnect();
  });
  process.once('SIGTERM', () => {
    bot.stop();
    prisma.$disconnect();
  });
}

main();
