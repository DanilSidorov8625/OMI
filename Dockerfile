
# ---- Base ----
FROM node:18-alpine AS base
WORKDIR /usr/src/app
COPY package*.json ./

# ---- Dependencies ----
FROM base AS dependencies
RUN npm ci

# ---- Build ----
FROM dependencies AS build
COPY . .
# If you had a build step, it would go here
# RUN npm run build

# ---- Production ----
FROM node:18-alpine AS production
WORKDIR /usr/src/app

# Copy dependencies from the 'dependencies' stage
COPY --from=dependencies /usr/src/app/node_modules ./node_modules
# Copy application code
COPY . .

# Create directories that will be mounted as volumes
RUN mkdir -p /usr/src/app/instance /usr/src/app/logs /usr/src/app/zippedLogs

# Expose the port
EXPOSE 8080

# Set the production environment
ENV NODE_ENV=production

# Run as root (no USER directive)
CMD ["node", "server.js"]