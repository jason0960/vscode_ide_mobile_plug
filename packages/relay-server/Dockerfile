FROM node:18-alpine

WORKDIR /app
COPY packages/relay-server/dist/index.js ./index.js

ENV PORT=4800
ENV ROOM_TTL_MS=14400000
ENV MAX_ROOMS=1000

EXPOSE 4800

CMD ["node", "index.js"]
