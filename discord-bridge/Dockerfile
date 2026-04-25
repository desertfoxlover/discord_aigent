# OpenClaw CLI(openclaw.mjs) + 게이트웨이 WebSocket 연동을 위해 공식 이미지 확장
FROM ghcr.io/openclaw/openclaw:latest

WORKDIR /bridge
COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

ENV HOME=/home/node

CMD ["node", "/bridge/src/index.js"]
