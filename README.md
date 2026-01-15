# WhatsApp Linker

Minimal MVP using Node.js (latest), Express and @whiskeysockets/baileys.

## Structure

- src/
  - server.js (Express app entry)
  - whatsapp.js (all WhatsApp logic)
- public/
  - index.html (minimal frontend)
- sessions/ (auto-created, persistent Baileys auth)
- package.json
- .nvmrc (uses latest Node)

## Usage

- Install: `npm install`
- Start: `npm start`
- App exposes:
  - POST /api/session -> create session
  - GET /api/session/:id/qr -> QR image (base64 PNG)
  - GET /api/session/:id/status -> connection status
  - GET /api/session/:id/id -> unique id

Sessions persisted to `/sessions/{sessionId}/` using useMultiFileAuthState.
Designed to run as a single Render web service with persistent disk.

## Node Version

- Uses latest Node (see `.nvmrc`)
- For Render, set Node version to latest or use `.nvmrc` support
