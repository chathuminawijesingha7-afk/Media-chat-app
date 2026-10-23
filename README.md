# Mono Chat — Firebase Firestore

The existing black-and-white frontend, Express API, and Socket.IO realtime chats now use **Firebase Cloud Firestore** instead of MongoDB.

## Firebase setup

1. Visit https://console.firebase.google.com and create a Firebase project.
2. Choose **Build → Firestore Database → Create database**, then use Firestore Native mode.
3. Open **Project settings → Service accounts → Generate new private key**. Keep the JSON file private; **never commit it**.
4. Copy `.env.example` to `.env`. Set `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY` using the service account credentials. Use literal `\n` characters for newlines in the private key.
5. Generate a new JWT secret: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and set `JWT_SECRET`.
6. Run `npm install`, then `npm start`. Open http://localhost:3000.

## Render deployment

Create a Node web service linked to this repository with build command `npm install` and start command `npm start`. Configure Render environment variables `NODE_ENV=production`, `JWT_SECRET`, `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`. Render provides `PORT`. HTTPS is required for secure auth cookies. The backend needs a persistent Socket.IO-compatible Node host; static Firebase Hosting by itself cannot run Express.

## Features

Multi-user accounts, hashed passwords, HttpOnly JWT cookies, one-to-one messaging, persisted chat history, conversation previews, online presence, typing indicators, read receipts, last seen, search, and sound notifications are retained. The existing UI is unchanged.

## Data and security notes

**The old MongoDB users and messages are not automatically migrated**. Existing account holders must register again unless you run a separate one-off data migration.

**Important:** A previous public revision contained MongoDB connection credentials and a JWT secret. Immediately rotate/revoke both. Removing them from the latest commit does not remove them from Git history. Never publish Firebase service-account private keys.

The Firestore Admin SDK runs on the server only. Each message is saved in the chat and both participants' feeds. Initial conversation scanning is limited to 1,000 feed entries. Read-receipt batches scan 300 latest feed entries and update up to 100 unread messages per request. Extend this for very large conversations. Firestore quotas and billing can apply.

The app does not use Firebase Authentication; it keeps the previous username/password and JWT flow, with credentials stored in Firestore. For internet deployment, add rate limits and abuse protection to auth and socket events.
