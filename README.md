# Mono Chat

A professional black-and-white multi-user chat application built with **Express**, **MongoDB/Mongoose**, **Socket.IO**, and vanilla HTML/CSS/JavaScript.

## Included

- User registration and sign-in
- Secure password hashing with bcrypt
- HTTP-only JWT authentication cookie
- Multiple user accounts
- Real-time 1-to-1 messaging with Socket.IO
- Messages persisted in MongoDB
- Conversation previews and ordering by recent activity
- Online/offline presence
- Last seen timestamps
- Read / seen state
- Typing indicator
- Message notification sound using the Web Audio API
- Responsive black-and-white interface
- Search users with `Ctrl/Cmd + K`
- Docker Compose MongoDB setup
- Security headers with Helmet

## Run with Docker Compose

The included `docker-compose.yml` runs both MongoDB and the chat server.

```bash
docker compose up --build
```

Open **http://localhost:3000**. Before a public deployment, replace the sample `JWT_SECRET` in `docker-compose.yml`.

## Run locally

### 1. Install dependencies

```bash
npm install
```

### 2. Start MongoDB

With Docker:

```bash
docker compose up -d mongo
```

Or use your existing MongoDB installation.

### 3. Configure environment

Copy `.env.example` to `.env` and set a long random `JWT_SECRET`.

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

### 4. Start the app

```bash
npm start
```

For development with auto-reload:

```bash
npm run dev
```

Open **http://localhost:3000**.

## Important note about notification sound

Browsers can block audio before the page has received a user interaction. The app therefore exposes a sound toggle in the top-right of the sidebar; turn it on once after signing in to allow the browser's audio context to run. Incoming messages received while you are in a different conversation trigger the notification beep.

## Production notes

Before deploying, set `NODE_ENV=production`, use HTTPS, replace the development JWT secret with a strong random secret, and use a managed/secured MongoDB instance. For a larger deployment, add rate limiting, structured logging, validation libraries, CSRF strategy appropriate to your auth architecture, and object storage if attachments are added.
