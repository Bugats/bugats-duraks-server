# Cloud Test Guide

This repo hosts the Beyblade arena and the TikTok Live bridge.

## Prerequisites
- Node.js 18+
- `npm install`

## Environment Variables
- `TIKTOK_USERNAME=bugats`
- `BEYBLADE_EVENT_URL=https://beyblade.thezone.lv/api/beyblade/events`
- Optional: `BEYBLADE_INGEST_SECRET=<secret>`
- Optional: `TIKTOK_SESSION_ID=<tiktok session id>`
- Optional gift tuning:
  - `BEYBLADE_GIFT_TIER_BOOST=10`
  - `BEYBLADE_GIFT_TIER_SHIELD=50`
  - `BEYBLADE_GIFT_TIER_SHOCK=150`
  - `BEYBLADE_GIFT_TIER_ULT=300`
  - `BEYBLADE_GIFT_REVIVE=200`
  - `BEYBLADE_REVIVE_MAX_PER_ROUND=2`

## Manual Test Steps
1. Start the server:
   - `npm run start:dev`
2. Open the arena:
   - `https://beyblade.thezone.lv/beyblade`
3. Verify local control:
   - Use the on-page controls or type `!join` and `!boost` in the command input.
4. Verify round flow:
   - Spawn 2+ blades and confirm countdown, shrink at ~30s, and winner banner.
5. Verify gift ult effect (manual):
   - POST a gift event to `/api/beyblade/events` (see example below).

## Manual Event Example (Gift)
Use any HTTP client to send:
`POST https://beyblade.thezone.lv/api/beyblade/events`
Body:
`{"type":"gift","userId":"test-user","userName":"Tester","name":"Rose","repeat":1,"value":100}`

If `BEYBLADE_INGEST_SECRET` is set, include header:
`x-beyblade-secret: <secret>`
