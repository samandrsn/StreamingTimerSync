FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=7374
COPY package.json ./
COPY src ./src
COPY public ./public
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 7374
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:7374/health || exit 1
USER node
CMD ["node", "src/index.js"]
