FROM node:22-alpine
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data
VOLUME /app/data
EXPOSE 3000

# Seed demo data on first run only, then start the server.
CMD ["sh", "-c", "[ -f \"$DATA_DIR/users.json\" ] || node scripts/seed.js; node server.js"]
