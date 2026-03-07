import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { prisma } from './prisma'

type TVariables = {
  userId: bigint
}

const app = new Hono<{ Variables: TVariables }>()

app.use(
  '*',
  cors({
    origin: '*', // In production, restrict to your TMA URL
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['POST', 'GET', 'OPTIONS', 'PATCH'],
  })
)

// Middleware for Telegram WebApp validation (Simplified for now)
app.use('/api/*', async (c, next) => {
  // TODO: Validate Telegram initData properly using BOT_TOKEN
  // For MVP development, we assume user ID is passed in headers or body
  // DO NOT deploy this to production without HMAC validation!
  const authHeader = c.req.header('Authorization')
  if (!authHeader) {
    // For local dev, let's fallback to a default test user if it exists
    const firstUser = await prisma.user.findFirst()
    if (firstUser) {
      c.set('userId', firstUser.telegramId)
      return await next()
    }
    return c.json({ error: 'Unauthorized' }, 401)
  }

  // Example Auth: "Bearer <telegram_user_id>"
  const token = authHeader.split(' ')[1]
  if (!token) return c.json({ error: 'Unauthorized' }, 401)

  c.set('userId', BigInt(token))
  await next()
})

app.get('/api/user', async (c) => {
  const telegramId = c.get('userId')

  try {
    const user = await prisma.user.findUnique({
      where: { telegramId },
      include: {
        sets: { include: { _count: { select: { words: true } } } },
        savedSets: { include: { _count: { select: { words: true } } } }
      }
    })

    if (!user) return c.json({ error: 'User not found' }, 404)

    const allUserSets = [...user.sets, ...user.savedSets]
    const uniqueSetsMap = new Map()
    allUserSets.forEach(s => uniqueSetsMap.set(s.id, s))
    const userSets = Array.from(uniqueSetsMap.values())

    const totalWords = userSets.reduce((acc: number, s: any) => acc + s._count.words, 0)
    const learnedWords = await prisma.wordReview.count({
      where: { userId: user.id, isLearned: true }
    })

    return c.json({
      totalWords,
      learnedWords,
      settings: {
        interval: user.notificationInterval,
        batch: user.wordsPerBatch,
        quietStart: user.quietStartHour,
        quietEnd: user.quietEndHour,
        isActive: user.isActive
      }
    })
  } catch (error) {
    console.error(error)
    return c.json({ error: 'Internal Server Error' }, 500)
  }
})

app.patch('/api/user/settings', async (c) => {
  const telegramId = c.get('userId')
  const body = await c.req.json()

  try {
    const updatedUser = await prisma.user.update({
      where: { telegramId },
      data: {
        notificationInterval: body.interval,
        wordsPerBatch: body.batch,
        quietStartHour: body.quietStart,
        quietEndHour: body.quietEnd,
        isActive: body.isActive
      }
    })
    return c.json({ success: true })
  } catch (error) {
    console.error(error)
    return c.json({ error: 'Failed to update settings' }, 500)
  }
})

const port = parseInt(process.env.PORT || '3000', 10)
console.log(`Server running on port ${port}`)

export default {
  port,
  fetch: app.fetch,
}
