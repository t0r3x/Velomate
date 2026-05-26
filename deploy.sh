#!/bin/sh
set -e

echo "📦 Pulling latest..."
git pull

echo "📁 Ensuring data directory exists..."
mkdir -p data

echo "🔨 Building & restarting..."
docker compose up -d --build

echo "🧹 Cleaning up old images..."
docker image prune -f

echo "✅ Done"
docker compose ps
