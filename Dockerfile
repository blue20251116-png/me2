FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev \
    && npm install --no-save playwright@1.62.0 \
    && npx playwright install --with-deps --only-shell chromium

COPY . .

ENV NODE_ENV=production

CMD ["npm", "start"]
