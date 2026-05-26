import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamText } from 'hono/streaming'
import { prisma } from './prisma'
import { validateInitData, getTelegramUserId } from './telegram-auth'
import { scrapeSet, scrapeFolder } from './quizlet'
import { sendWordBatch } from './send-words'

type TVariables = {
  telegramId: bigint
  dbUserId: number
}

const app = new Hono<{ Variables: TVariables }>()

app.use(
  '*',
  cors({
    origin: '*', // In production, restrict to your TMA URL
    allowHeaders: ['Content-Type', 'X-Telegram-Init-Data'],
    allowMethods: ['POST', 'GET', 'OPTIONS', 'PATCH'],
  })
)

// Telegram WebApp HMAC validation middleware
app.use('/api/*', async (c, next) => {
  const initData = c.req.header('X-Telegram-Init-Data')

  if (!initData) {
    // Dev fallback: use first user in DB
    if (process.env.NODE_ENV !== 'production') {
      const firstUser = await prisma.user.findFirst()
      if (firstUser) {
        c.set('telegramId', firstUser.telegramId)
        c.set('dbUserId', firstUser.id)
        return await next()
      }
    }
    return c.json({ error: 'Unauthorized: missing init data' }, 401)
  }

  // Validate HMAC in production
  if (process.env.NODE_ENV === 'production' && !validateInitData(initData)) {
    return c.json({ error: 'Unauthorized: invalid init data' }, 403)
  }

  const telegramId = getTelegramUserId(initData)
  if (!telegramId) {
    return c.json({ error: 'Unauthorized: no user in init data' }, 401)
  }

  const user = await prisma.user.findUnique({ where: { telegramId } })
  if (!user) {
    return c.json({ error: 'User not found. Run /start in the bot first.' }, 404)
  }

  c.set('telegramId', telegramId)
  c.set('dbUserId', user.id)
  await next()
})

// --- Routes ---

app.get('/api/user', async (c) => {
  const telegramId = c.get('telegramId')

  try {
    const user = await prisma.user.findUnique({
      where: { telegramId },
      include: {
        sets: { include: { _count: { select: { words: true } } } },
        savedSets: { include: { _count: { select: { words: true } } } },
      },
    })

    if (!user) return c.json({ error: 'User not found' }, 404)

    const allUserSets = [...user.sets, ...user.savedSets]
    const uniqueSetsMap = new Map()
    allUserSets.forEach((s) => uniqueSetsMap.set(s.id, s))
    const userSets = Array.from(uniqueSetsMap.values())

    const totalWords = userSets.reduce((acc: number, s: any) => acc + s._count.words, 0)
    const learnedWords = await prisma.wordReview.count({
      where: { userId: user.id, isLearned: true },
    })

    return c.json({
      totalSets: userSets.length,
      totalWords,
      learnedWords,
      settings: {
        interval: user.notificationInterval,
        batch: user.wordsPerBatch,
        quietStart: user.quietStartHour,
        quietStartMin: user.quietStartMin,
        quietEnd: user.quietEndHour,
        quietEndMin: user.quietEndMin,
        isActive: user.isActive,
        timezone: user.timezone,
        quietDays: user.quietDays,
      },
    })
  } catch (error) {
    console.error(error)
    return c.json({ error: 'Internal Server Error' }, 500)
  }
})

app.patch('/api/user/settings', async (c) => {
  const telegramId = c.get('telegramId')
  const body = await c.req.json()

  try {
    await prisma.user.update({
      where: { telegramId },
      data: {
        notificationInterval: body.interval,
        wordsPerBatch: body.batch,
        quietStartHour: body.quietStart,
        quietStartMin: body.quietStartMin ?? 0,
        quietEndHour: body.quietEnd,
        quietEndMin: body.quietEndMin ?? 0,
        isActive: body.isActive,
        ...(body.timezone ? { timezone: body.timezone } : {}),
        ...(body.quietDays !== undefined ? { quietDays: body.quietDays } : {}),
      },
    })
    return c.json({ success: true })
  } catch (error) {
    console.error(error)
    return c.json({ error: 'Failed to update settings' }, 500)
  }
})

app.get('/api/sets/words', async (c) => {
  const dbUserId = c.get('dbUserId')

  try {
    const user = await prisma.user.findUnique({
      where: { id: dbUserId },
      include: {
        sets: {
          include: {
            words: {
              include: {
                reviews: {
                  where: { userId: dbUserId }
                }
              }
            }
          }
        },
        savedSets: {
          include: {
            words: {
              include: {
                reviews: {
                  where: { userId: dbUserId }
                }
              }
            }
          }
        }
      }
    })

    if (!user) return c.json({ error: 'User not found' }, 404)

    const allUserSets = [...user.sets, ...user.savedSets]
    const uniqueSetsMap = new Map()
    allUserSets.forEach((s) => uniqueSetsMap.set(s.id, s))
    const userSets = Array.from(uniqueSetsMap.values())

    const result = userSets.map(set => ({
      id: set.id,
      title: set.title,
      createdAt: set.createdAt,
      words: set.words.map(w => ({
        id: w.id,
        term: w.term,
        definition: w.definition,
        isLearned: w.reviews.length > 0 ? w.reviews[0].isLearned : false
      }))
    }))

    return c.json({ sets: result })
  } catch (error) {
    console.error(error)
    return c.json({ error: 'Internal Server Error' }, 500)
  }
})

app.patch('/api/words/:id/toggle-learned', async (c) => {
  const dbUserId = c.get('dbUserId')
  const wordId = parseInt(c.req.param('id'), 10)

  if (isNaN(wordId)) return c.json({ error: 'Invalid word ID' }, 400)

  try {
    let review = await prisma.wordReview.findUnique({
      where: {
        userId_wordId: {
          userId: dbUserId,
          wordId
        }
      }
    })

    if (review) {
      review = await prisma.wordReview.update({
        where: { id: review.id },
        data: { isLearned: !review.isLearned }
      })
    } else {
      review = await prisma.wordReview.create({
        data: {
          userId: dbUserId,
          wordId,
          isLearned: true
        }
      })
    }

    return c.json({ success: true, isLearned: review.isLearned })
  } catch (error) {
    console.error(error)
    return c.json({ error: 'Internal Server Error' }, 500)
  }
})

app.post('/api/scrape', async (c) => {
  const dbUserId = c.get('dbUserId')
  const { url } = await c.req.json()

  if (!url || typeof url !== 'string') {
    return c.json({ error: 'URL is required' }, 400)
  }

  if (!url.includes('quizlet.com')) {
    return c.json({ error: 'Must be a Quizlet URL' }, 400)
  }

  if (url.includes('/folders/')) {
    return streamText(c, async (stream) => {
      try {
        const result = await scrapeFolder(url, dbUserId, async (msg: string) => {
          await stream.write(msg + '\n\n')
        })
        await stream.write(`[RESULT] ${JSON.stringify(result)}\n\n`)

        // Send first word batch after successful folder add
        if (result.success && result.totalWords && result.totalWords > 0) {
          sendWordBatch(dbUserId).catch((e) => console.error('[scrape] sendWordBatch error:', e))
        }
      } catch (error: any) {
        await stream.write(`[ERROR] ${error.message || 'Scraping failed'}\n\n`)
      }
    })
  }

  try {
    const result = await scrapeSet(url, dbUserId)

    // Send first word batch after successful set add (not "Already exists")
    if (result.success && result.count > 0 && !('message' in result && result.message)) {
      sendWordBatch(dbUserId).catch((e) => console.error('[scrape] sendWordBatch error:', e))
    }

    return c.json(result)
  } catch (error: any) {
    console.error('[/api/scrape] Error:', error)
    return c.json({ error: error.message || 'Scraping failed' }, 500)
  }
})

// --- Server ---

const port = parseInt(process.env.PORT || '3000', 10)
console.log(`Backend server running on port ${port}`)

export default {
  port,
  fetch: app.fetch,
}
