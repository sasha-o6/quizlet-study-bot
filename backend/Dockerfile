FROM oven/bun:1 as base

WORKDIR /app

# Copy package files from backend
COPY backend/package.json ./
RUN bun install

# Copy source
COPY backend/src src

# Copy root prisma manually to generate client
COPY prisma ./prisma
# Provide dummy DB URL for Prisma codegen (not used at runtime)
# TODO: change this to real DB URL
ENV DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy"
RUN bunx prisma generate

# Production config
ENV NODE_ENV=production
EXPOSE 3000

CMD ["bun", "src/index.ts"]
