FROM node:20-alpine
WORKDIR /app
# Alpine ships without IANA tzdata by default, so a TZ env var (see
# docker-compose.yml) silently does nothing without this — Node's Date
# "local" methods would keep running in UTC regardless.
RUN apk add --no-cache tzdata
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
EXPOSE 4000
CMD ["node", "src/index.js"]
