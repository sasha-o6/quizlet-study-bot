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

RUN npx prisma generate
RUN npm run build

CMD ["npm", "start"]
