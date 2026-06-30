# Zero-dependency Node service — no npm install, no lockfile, nothing to audit.
# Runs as uid 1001 to MATCH host user yossef7875 (uid 1001), so it can enter the 700 workspace
# bind-mount and write tasks.md as its owner without loosening host permissions.
FROM node:22-alpine
WORKDIR /app
COPY server.mjs .
USER 1001:1001
ENV PORT=8088
EXPOSE 8088
CMD ["node","server.mjs"]
