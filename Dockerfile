FROM node:20-slim

# Install system dependencies (including chromium for ARM64)
RUN apt-get update && apt-get install -y \
    chromium \
    openssl \
    procps \
    xvfb \
    && rm -rf /var/lib/apt/lists/*

# Set Puppeteer environment variables to use installed chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/

RUN npm install

COPY . .

RUN npm run build
RUN npx prisma generate

CMD ["npm", "start"]
