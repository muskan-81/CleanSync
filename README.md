# Smart Waste Management System — Report. Collect. Clean.

Node.js + Express + SQLite backend with a vanilla JS frontend. Citizen, Admin and Collector log in from
different devices/browsers and share the same live data (auto-refresh every 8 seconds).

## Setup
```
npm install
npm start
```
Open http://localhost:3000  (needs Node.js 18+; SQLite file `waste.db` is created automatically)

## Folder structure
```
server.js        Express API + SQLite schema (users, sessions, complaints, assignments, pickup_requests, notifications)
package.json
public/
  index.html
  css/style.css  light/dark theme, responsive layout
  js/app.js      views, smart rules, API calls
```

## How the roles connect
1. Create one Admin, one Collector and one Citizen account (Login page -> choose role -> Create <Role> Account).
2. Citizen reports waste / requests pickup  -> Admin sees it instantly in the Priority Queue.
3. Admin assigns a Collector               -> Collector sees the task, Citizen gets a notification.
4. Collector marks In Progress + uploads after-cleanup photo -> Citizen gets "please verify".
5. Citizen verifies (YES = Resolved, NO = Reopened)          -> Admin is notified, stats update.

## API summary
POST /api/register, /api/login, /api/logout | GET /api/state, /api/public
POST /api/complaints | PATCH /api/complaints/:id {action: assign|status|done|verify}
POST /api/pickups, /api/pickups/:id/advance, /api/notifications/read

## Access from other devices
Run the server on one laptop and open http://<laptop-ip>:3000 from other devices on the same Wi-Fi.
Note: browsers only allow camera/location on https or localhost, so use Upload / type the area on those devices,
or expose the server over https (e.g. with ngrok).

## Notes
- Passwords are salted + hashed (scrypt); logins use random session tokens.
- Anyone can create an Admin account (fine for a college demo; add an admin invite code for real use).
- Waste detection is a simulation based on the selected waste type (`classify()` in app.js).
- Location uses OpenStreetMap Nominatim; atmosphere uses Open-Meteo; charts use Chart.js CDN (internet needed).

## Open on your phone (responsive)
1. Laptop and phone must be on the same Wi-Fi.
2. Run `npm start`. The console prints `Phone (same Wi-Fi): http://192.168.x.x:3000` - open that address in the phone browser.
3. If it does not open, allow Node.js through the laptop firewall (Windows: "Allow an app through Windows Firewall").
4. On phones the sidebar becomes a bottom navigation bar. Over plain http the live camera/location are blocked by the browser:
   "Open Camera" then opens the phone camera directly, and you can type the area. For full camera/location use an https link (deploy on Render, or ngrok).

## If Citizen and Admin do not see each other
- Everyone must open the SAME address printed by `npm start` (e.g. http://localhost:3000 or http://192.168.x.x:3000).
  Do NOT open index.html by double-click or via VS Code Live Server unless you set the server address (login page -> "change").
- The login page shows `🟢 Server: ...`. If it shows 🔴, the browser cannot reach the backend.
- Top-right pill shows `🟢 Live` when real-time sync is working.
- Updates arrive instantly (server push) with a 4-second polling fallback.
- To test roles on ONE computer, use two different tabs/windows (each tab keeps its own login).

## Accounts
Accounts are stored in SQLite (`waste.db`). Register once, then log in with the same email (or ID) and password from any device.
Login no longer needs the role - the app opens the dashboard of the account's role. Sessions stay in the tab until Logout.
To keep data on a hosting service use a persistent disk and set `DB_PATH` (e.g. /data/waste.db).

## Single-file frontend
`smart-waste-app.html` is the whole frontend in one responsive file. Open it on any device, tap "change" on the login page
(or answer the prompt) and enter your server address, e.g. http://192.168.1.5:3000
