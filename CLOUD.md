# Cloud Test Guide

This repo hosts the Beyblade arena and the TikTok Live bridge.

## Prerequisites
- Node.js 18+
- `npm install`

## Environment Variables
- `TIKTOK_USERNAME=bugats`
- `BEYBLADE_EVENT_URL=https://beyblade.thezone.lv/api/beyblade/events`
- Optional arena tuning:
  - `BEYBLADE_MAX_BLADES=7`
  - `BEYBLADE_ROUND_SHRINK_START_MS=120000`
  - `BEYBLADE_ROUND_SHRINK_END_MS=240000`
- Optional: `BEYBLADE_INGEST_SECRET=<secret>`
- Optional: `TIKTOK_SESSION_ID=<tiktok session id>`
- Optional gift tuning:
  - `BEYBLADE_GIFT_TIER_BOOST=10`
  - `BEYBLADE_GIFT_TIER_SHIELD=50`
  - `BEYBLADE_GIFT_TIER_SHOCK=150`
  - `BEYBLADE_GIFT_TIER_ULT=300`
  - `BEYBLADE_GIFT_REVIVE=200`
  - `BEYBLADE_REVIVE_MAX_PER_ROUND=2`
- Optional health tuning:
  - `BEYBLADE_HP_MAX=6`
  - `BEYBLADE_DAMAGE_WALL=1`
  - `BEYBLADE_DAMAGE_COLLISION=1`
  - `BEYBLADE_HIT_COOLDOWN_MS=1200`
  - `BEYBLADE_WALL_SPEED_THRESHOLD=0.03`
  - `BEYBLADE_COLLISION_SPEED_THRESHOLD=0.028`
  - `BEYBLADE_RING_OUT_BUFFER=0.04`
  - `BEYBLADE_RING_OUT_SPEED=0.035`
  - `BEYBLADE_IDLE_DAMAGE_DELAY_MS=60000`
  - `BEYBLADE_IDLE_DAMAGE_INTERVAL_MS=2000`
  - `BEYBLADE_IDLE_SPEED_THRESHOLD=0.004`
  - `BEYBLADE_IDLE_DAMAGE=1`
- Optional combo tuning:
  - `BEYBLADE_COMBO_WINDOW_MS=2000`
  - `BEYBLADE_COMBO_MOMENTUM_BONUS=10`
  - `BEYBLADE_COMBO_DAMAGE_BONUS=1`
- Optional stamina + shield tuning:
  - `BEYBLADE_STAMINA_MAX=100`
  - `BEYBLADE_STAMINA_REGEN_PER_SEC=6`
  - `BEYBLADE_STAMINA_BOOST_COST=28`
  - `BEYBLADE_STAMINA_DASH_COST=22`
  - `BEYBLADE_STAMINA_SHIELD_COST=30`
  - `BEYBLADE_SHIELD_DURATION_MS=2500`
  - `BEYBLADE_SHIELD_SLOW_MULT=0.7`
- Optional momentum tuning:
  - `BEYBLADE_MOMENTUM_DECAY_PER_SEC=8`
  - `BEYBLADE_MOMENTUM_BOOST_GAIN=14`
  - `BEYBLADE_MOMENTUM_DASH_GAIN=12`
  - `BEYBLADE_MOMENTUM_SHIELD_GAIN=8`
  - `BEYBLADE_MOMENTUM_COLLISION_FAST=10`
  - `BEYBLADE_MOMENTUM_COLLISION_SLOW=6`

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
