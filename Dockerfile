# Zero-dependency Node service — no npm install, no lockfile, nothing to audit.
# Runs as uid 1000 (node) so files it writes in the mounted workspace stay owned by yossef7875.
FROM node:22-alpine
WORKDIR /app
COPY server.mjs .
USER node
ENV PORT=8088
EXPOSE 8088
CMD ["node","server.mjs"]
