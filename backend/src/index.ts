import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamText } from 'hono/streaming'
import { prisma } from './prisma'
import { validateInitData, getTelegramUserId } from './telegram-auth'
import { scrapeSet, scrapeFolder } from './quizlet'

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
        quietEnd: user.quietEndHour,
        isActive: user.isActive,
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
        quietEndHour: body.quietEnd,
        isActive: body.isActive,
      },
    })
    return c.json({ success: true })
  } catch (error) {
    console.error(error)
    return c.json({ error: 'Failed to update settings' }, 500)
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
      } catch (error: any) {
        await stream.write(`[ERROR] ${error.message || 'Scraping failed'}\n\n`)
      }
    })
  }

  try {
    const result = await scrapeSet(url, dbUserId)
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
