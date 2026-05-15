FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY watchdog.js ./
RUN mkdir -p /flags /logs
CMD ["node", "watchdog.js"]
