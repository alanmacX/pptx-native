FROM node:22-bookworm-slim AS doubao-build

WORKDIR /src/doubao
COPY doubao/package.json doubao/package-lock.json ./
RUN npm ci
COPY doubao/ ./
RUN npm run build && npm prune --omit=dev

FROM rockchin/langbot@sha256:459ab3d8ba0972396065aa328481c4c4929cf9fda87e38750b1a11a588142b72

USER root
WORKDIR /app

COPY --from=doubao-build /src/doubao/dist /opt/doubao/dist
COPY --from=doubao-build /src/doubao/node_modules /opt/doubao/node_modules
COPY --from=doubao-build /src/doubao/package.json /opt/doubao/package.json
COPY entrypoint.sh bootstrap.mjs /opt/bundle/

RUN chmod 0755 /opt/bundle/entrypoint.sh \
    && install -d -m 0700 /opt/bundle/secure /opt/bundle/status

ENV TZ=Asia/Shanghai \
    BOX__ENABLED=false \
    SPACE__DISABLE_TELEMETRY=true \
    PLUGIN__RUNTIME_WS_URL=ws://127.0.0.1:5400/control/ws

EXPOSE 5300 2280 8000

ENTRYPOINT ["/opt/bundle/entrypoint.sh"]
