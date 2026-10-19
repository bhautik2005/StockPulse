FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --omit=optional

COPY src/ ./src/

ENV NODE_ENV=production
EXPOSE 5000

CMD ["node", "src/index.js"]
