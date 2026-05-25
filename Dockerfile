# ── Stage 1: Build frontend ───────────────────────────────────────────────────
FROM node:20-alpine AS frontend-builder
WORKDIR /build
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ── Stage 2: Build backend ────────────────────────────────────────────────────
FROM node:20-alpine AS backend-builder
# Native build tools required for better-sqlite3
RUN apk add --no-cache python3 make g++
WORKDIR /build
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build

# ── Stage 3: Runtime ──────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

# Backend: compiled JS + production node_modules (includes better-sqlite3 .node binary)
COPY --from=backend-builder /build/dist         ./backend/dist
COPY --from=backend-builder /build/node_modules ./backend/node_modules

# Frontend: compiled static files served by Express
COPY --from=frontend-builder /build/dist        ./frontend/dist

# SQLite data directory — mount a named volume here for persistence
RUN mkdir -p ./data

EXPOSE 3001
CMD ["node", "backend/dist/server.js"]
