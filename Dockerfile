FROM node:22-slim
ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    PORT=3000
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
RUN mkdir -p /app/data
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
