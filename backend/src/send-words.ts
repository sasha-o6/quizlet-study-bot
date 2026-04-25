import { prisma } from './prisma'

const BOT_TOKEN = process.env.BOT_TOKEN || ''

/**
 * Send a random word batch to a user via Telegram Bot API.
 * Lightweight version for the backend (no grammy dependency).
 * Mirrors NotificationService.sendBatch logic.
 */
export async function sendWordBatch(dbUserId: number): Promise<void> {
  if (!BOT_TOKEN) {
    console.error('[sendWordBatch] BOT_TOKEN not set')
    return
  }

  const user = await prisma.user.findUnique({
    where: { id: dbUserId },
    include: {
      sets: { include: { words: true } },
      savedSets: { include: { words: true } },
    },
  })

  if (!user) return

  // Get learned word IDs
  const reviews = await prisma.wordReview.findMany({
    where: { userId: dbUserId },
    select: { wordId: true, isLearned: true },
  })
  const learnedWordIds = new Set(
    reviews.filter((r) => r.isLearned).map((r) => r.wordId)
  )

  // Combine and deduplicate sets
  const allSets = [...user.sets, ...user.savedSets]
  const uniqueSets = new Map<number, (typeof allSets)[0]>()
  allSets.forEach((s) => uniqueSets.set(s.id, s))

  // Flatten words, exclude learned
  const allWords = Array.from(uniqueSets.values())
    .flatMap((s) => s.words)
    .filter((w) => !learnedWordIds.has(w.id))

  if (allWords.length === 0) return

  // Select random words
  const batchSize = Math.min(user.wordsPerBatch, allWords.length)
  const usedIndices = new Set<number>()
  const selected: typeof allWords = []

  while (selected.length < batchSize) {
    const idx = Math.floor(Math.random() * allWords.length)
    if (!usedIndices.has(idx)) {
      usedIndices.add(idx)
      selected.push(allWords[idx])
    }
  }

  if (selected.length === 0) return

  // Build message + inline keyboard
  let message = ''
  const keyboard: { text: string; callback_data: string }[][] = []

  selected.forEach((w, i) => {
    const num = i + 1
    message += `${num}. *${w.term}* - ${w.definition}\n`
    keyboard.push([{ text: `[${num}]`, callback_data: `learn:${w.id}` }])
  })

  message += `\n\n Tap the number below to mark a word as learned.`

  // Send via Telegram Bot API
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: Number(user.telegramId),
        text: message,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [keyboard.map((row) => row[0])] },
      }),
    })
  } catch (e) {
    console.error(`[sendWordBatch] Failed to send to ${user.telegramId}:`, e)
  }
}
