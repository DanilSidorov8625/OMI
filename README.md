# One Million Images

This project is a collaborative canvas where users can upload images to a large grid. It is built with Node.js, Express, Socket.io, and S3-compatible storage for the backend, and vanilla JavaScript with a canvas for the frontend.

## Project Structure

- `server.js`: The main entry point for the backend server.
- `app.js`: The main entry point for the frontend application.
- `public/`: Contains the static assets for the frontend.
- `instance/`: Contains the SQLite database file.
- `logs/`: Contains the application and client logs.
- `zippedLogs/`: Contains rotated and zipped logs.
- `__test__/`: Contains the tests.
- `Dockerfile`: Defines the Docker image for the application.
- `docker-compose.yaml`: Defines the services for running the application with Docker Compose.

## Getting Started

### Prerequisites

- Node.js (v18 or higher)
- Docker
- Docker Compose

### Environment Variables

Create a `.env` file in the root of the project with the following variables:

```
# Server
PORT=8080

# Redis (optional)
REDIS_ON=true
REDIS_URL=your_redis_url
REDIS_PORT=your_redis_port
REDIS_PASSWORD=your_redis_password

# R2 (or S3-compatible storage)
R2_ACCOUNT_ID=your_r2_account_id
R2_ACCESS_KEY_ID=your_r2_access_key_id
R2_SECRET_ACCESS_KEY=your_r2_secret_access_key
R2_BUCKET=your_r2_bucket
R2_CUSTOM_DOMAIN=your_r2_custom_domain
R2_PUBLIC_BASE=your_r2_public_base

# Sentry
SENTRY_DSN=your_sentry_dsn

# Watchtower (for private Docker Hub images)
REPO_USER=your_docker_hub_username
REPO_PASS=your_docker_hub_password_or_access_token
```

### Development

To run the application in development mode, run:

```
npm install
npm run dev
```

### Testing

To run the tests, run:

```
npm test
```

### Production

To run the application in production with Docker Compose, run:

```
docker-compose up -d
```
