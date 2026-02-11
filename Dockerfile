FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    openssl \
    procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/

RUN npm install

COPY . .

RUN npm run build
RUN npx prisma generate

CMD ["npm", "start"]
