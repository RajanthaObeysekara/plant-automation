FROM node:20-alpine
WORKDIR /app
# See backend/Dockerfile's comment — same TZ env var, same fix needed.
RUN apk add --no-cache tzdata
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
CMD ["node", "src/index.js"]
