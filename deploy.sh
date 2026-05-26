#!/bin/sh
set -e

echo "📦 Pulling latest..."
git pull

echo "📁 Ensuring data directory exists..."
mkdir -p data

# Safety check: if the bind-mount db is missing but the old named volume exists, try to migrate it
if [ ! -f data/unbound.db ]; then
  if docker volume ls -q | grep -q "unbound_unbound-data"; then
    echo "⚠️  No data/unbound.db found — attempting migration from old named volume..."
    if docker run --rm \
      -v unbound_unbound-data:/source \
      -v "$(pwd)/data":/dest \
      alpine sh -c "[ -f /source/unbound.db ] && cp /source/unbound.db /dest/unbound.db"; then
      echo "✅ Migration done — data/unbound.db restored"
    else
      echo "ℹ️  Old volume exists but contained no database — starting fresh"
    fi
  fi
fi

echo "🔨 Building & restarting..."
docker compose up -d --build

echo "🧹 Cleaning up old images..."
docker image prune -f

echo "✅ Done"
docker compose ps
