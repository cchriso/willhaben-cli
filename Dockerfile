FROM oven/bun:1.3.10
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
ENV WILLHABEN_MCP_HOST=0.0.0.0 \
    WILLHABEN_MCP_PORT=3100 \
    WILLHABEN_CONFIG_DIR=/home/bun/.willhaben
USER bun
EXPOSE 3100
CMD ["bun", "run", "src/mcp/index.ts"]
