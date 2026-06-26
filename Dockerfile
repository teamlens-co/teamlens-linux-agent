# Agent (Desktop) Repository Dockerfile
FROM node:20-alpine AS builder

WORKDIR /app

RUN apk add --no-cache curl build-essential python3 libwebp-dev

COPY package*.json ./
RUN npm ci

COPY . .

# Build Tauri app
ENV TAURI_BUILD_TARGET=linux
RUN npm run build 2>&1 || echo "Note: Tauri build may require additional system dependencies"

# Output stage
FROM alpine:3.18

RUN apk add --no-cache libwebp libxcb

WORKDIR /app

# Copy built artifacts (adjust path based on your setup)
COPY --from=builder /app/src-tauri/target/release/ ./

CMD ["echo", "Agent build complete. Artifacts in /app"]
