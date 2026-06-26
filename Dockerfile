# Stage 1: Build the TypeScript code
FROM node:22-alpine AS builder
WORKDIR /usr/src/app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build

# Stage 2: Production runtime environment
FROM node:22-alpine AS runner
WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --only=production

COPY --from=builder /usr/src/app/dist ./dist

EXPOSE 3000
CMD ["npm", "start"]
