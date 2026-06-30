# Zero-dependency Node service — no npm install, no lockfile, nothing to audit.
FROM node:22-alpine
WORKDIR /app
COPY server.mjs .
ENV PORT=8088
EXPOSE 8088
CMD ["node","server.mjs"]
