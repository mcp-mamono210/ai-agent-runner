FROM node:24.19.0-alpine3.24

WORKDIR /opt/phase50-proxy
COPY scripts/phase50/proxy/proxy.mjs ./proxy.mjs
USER node
EXPOSE 3128
CMD ["node", "proxy.mjs"]
