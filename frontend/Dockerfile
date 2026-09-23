FROM node:24-alpine AS build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
COPY LICENSE /app/LICENSE
COPY assets/resource-manifest.json assets/verify-resources.mjs /app/assets/
COPY assets/local /app/assets/local
COPY assets/preferences /app/assets/preferences
COPY assets/preferences-manifest.json assets/npc-manifest.json /app/assets/
COPY data/preferences /app/data/preferences
COPY scripts/verify-preferences-assets.mjs /app/scripts/verify-preferences-assets.mjs
# 测试在构建阶段读取随库资料，运行镜像只复制最终网站输出。
COPY scripts/game-ui-fixture.mjs /app/scripts/game-ui-fixture.mjs
COPY data/npc/graph.json data/npc/evidence.json /app/data/npc/
COPY data/source/people/ /app/data/source/people/
RUN npm run build && npm run test:game && npm run test:atlas

FROM caddy:2-alpine
COPY --from=build /app/frontend/build /srv/web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
