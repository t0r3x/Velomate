#!/bin/sh
set -e

echo "📦 Pulling latest..."
git pull

echo "📁 Ensuring data directory exists..."
mkdir -p data

# Safety check: if the bind-mount db is missing but the old named volume exists, migrate it
if [ ! -f data/unbound.db ]; then
  if docker volume ls -q | grep -q "unbound_unbound-data"; then
    echo "⚠️  No data/unbound.db found — migrating from old named volume..."
    docker run --rm \
      -v unbound_unbound-data:/source \
      -v "$(pwd)/data":/dest \
      alpine cp /source/unbound.db /dest/unbound.db
    echo "✅ Migration done — data/unbound.db restored"
  fi
fi

echo "🔨 Building & restarting..."
docker compose up -d --build

echo "🧹 Cleaning up old images..."
docker image prune -f

echo "✅ Done"
docker compose ps
