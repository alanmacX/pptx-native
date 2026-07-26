# LangBot + Doubao single-container bundle

This image runs LangBot, its plugin runtime, and the patched Doubao web proxy in one container.

- LangBot Web UI: container port `5300`
- QQ OneBot v11 reverse WebSocket: container port `2280`, path `/ws`
- Doubao proxy: internal port `8000`
- Runtime data and credentials remain in the container writable layer.
- LangBot Box is disabled and the host Docker socket is not mounted.

Before removing the bot, archive it with `docker export langbot-doubao | gzip > langbot-doubao.tar.gz`.
