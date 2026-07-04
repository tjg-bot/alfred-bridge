# Alfred WhatsApp Bridge

Standalone Node service that connects Alfred (Fraction Kings) to a WhatsApp group. Uses Baileys to log into WhatsApp Web as a linked device, listens to the founding-kings group, forwards messages to the FK Alfred API, and posts Alfred's replies back to the group.

Do NOT publicize this service. Baileys is an unofficial reverse-engineered WhatsApp client and running it in the open invites bans.

## Prerequisites

- Node 20+ LTS
- A dedicated WhatsApp phone number for Alfred (the number's phone must be online at least during the initial pairing)
- Railway account (or any host that supports Docker + a persistent volume)

## Local setup

```bash
cd /Users/tylerjames/projects/alfred-bridge
npm install
cp .env.example .env
# edit .env: set ALFRED_API_URL, ALFRED_BRIDGE_SECRET, KING_* phones. Leave ALFRED_GROUP_JID empty for now.
npm run dev
```

On the first run the terminal prints a QR code. On the Alfred phone, open WhatsApp then Settings then Linked Devices then Link a Device, and scan the QR. Session state is persisted under `./auth-state` so future starts skip the QR.

## Finding the group JID

1. From another phone (yours), add Alfred's number to the founding-kings WhatsApp group.
2. Any founding king sends any message to that group.
3. The bridge logs the incoming message with `groupJid: "<GROUP_ID>@g.us"`. Copy that value.
4. Set `ALFRED_GROUP_JID=<value>` in `.env` and restart with `npm run dev`.

Alternative: to enumerate all groups you can drop into a REPL from the running socket and call `sock.groupFetchAllParticipating()`. Simpler to just send a test message.

## HTTP endpoints

- `GET /health` returns `{ ok, connected, groupJid }`
- `POST /broadcast` with `Authorization: Bearer $ALFRED_BRIDGE_SECRET` and body `{ "text": "..." }` posts a text message into the configured group. Used by FK Vercel to push daily digests, event alerts, etc.

## Style rules (inherited from Fraction Kings)

Alfred replies never contain em dashes, en dashes, exclamation marks, or emojis. The FK Alfred API enforces this on its side. The bridge is a dumb pipe and passes text through verbatim.

## Deploy to Railway

```bash
npm install -g @railway/cli
railway login
cd /Users/tylerjames/projects/alfred-bridge
railway init          # create a new project
railway link          # or link into an existing one

# Set env vars (one line each)
railway variables set ALFRED_API_URL=https://fractionkings.com
railway variables set ALFRED_BRIDGE_SECRET=<paste the same secret set on Vercel>
railway variables set ALFRED_GROUP_JID=<group>@g.us
railway variables set KING_TYLER=1555xxxxxxx
railway variables set KING_ANTONIOS=1555xxxxxxx
railway variables set KING_MORGAN=1555xxxxxxx
railway variables set KING_ANDREW=1555xxxxxxx
railway variables set BRIDGE_LOG_LEVEL=info
railway variables set BRIDGE_AUTH_PATH=/data/auth-state

railway up            # first deploy
```

### CRITICAL: mount a volume for `auth-state`

Railway containers are ephemeral. Without a mounted volume the Baileys session is wiped on every deploy and you have to re-scan the QR. In the Railway UI:

1. Open the service, then Volumes, then New Volume.
2. Name it `alfred-auth`, mount path `/data`.
3. Set `BRIDGE_AUTH_PATH=/data/auth-state` (already shown above).

Redeploy after mounting.

### First deploy pairing

The container starts, runs the bridge, and prints a QR code to the log. Open Railway logs, screenshot the QR, and scan from the Alfred phone. After pairing succeeds the volume caches the session and future deploys reconnect silently.

## Docker (fallback)

```bash
docker build -t alfred-bridge .
docker run --env-file .env -v $PWD/auth-state:/app/auth-state -p 8080:8080 alfred-bridge
```

## Troubleshooting

- **QR keeps refreshing forever**: the phone is offline, or you have not opened Linked Devices. Try again with the phone unlocked.
- **`connection.close` with statusCode 401**: session invalidated on WhatsApp's side. Delete `auth-state` and re-pair.
- **Bridge reconnects in a loop**: usually a stale session. Same fix as above.
- **Alfred is silent**: check `/health`. If `connected: false`, WhatsApp is not paired. If `connected: true` but nothing lands, verify `ALFRED_GROUP_JID` matches the value in bridge logs when a message arrives.
