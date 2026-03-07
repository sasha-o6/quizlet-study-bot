import { PrismaClient } from '@prisma/client'

// Use a singleton pattern to avoid too many connections
// during hot-reloading or concurrency in Bun
export const prisma = new PrismaClient()
