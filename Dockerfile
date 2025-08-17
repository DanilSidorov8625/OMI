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

# Create a non-root user and switch to it
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

# Expose the port
EXPOSE 8080

# Set the production environment
ENV NODE_ENV=production

# Run the app
CMD ["node", "server.js"]
