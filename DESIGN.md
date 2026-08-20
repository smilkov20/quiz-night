# Pub Quiz App — Design Plan

## 1. Decisions locked in

| Question | Decision |
|---|---|
| Pacing | Host controls, all teams in lockstep |
| Media playback | Centrally, on host's screen/speakers |
| Media source | YouTube embed with a clip range, file upload as fallback |
| Media timing | Answer timer starts after the clip finishes |
| Grading | Auto for yes/no, manual for text |
| Grading cadence | Host decides in the moment |
| Partial credit | Any whole number, 0 to max |
| Round review | Correct answers only, host-triggered |
| Tiebreaker | Extra open questions, only for a tie at 1st |
| Scale | Under 15 teams, usually under 10 |
| Hosting | Cloud; teams on mobile data or venue wifi |
| Points | Configurable per question |
| Admin auth | Single shared password |
| History | Not retained |
| Stack | TypeScript — Node + React |

## 2. Architecture

Small scale means small architecture. One Node process holds live session state in memory and writes through to Postgres. No Redis, no pub/sub layer, no horizontal scaling. Fifteen WebSocket clients is a rounding error.

Three client surfaces:

- **Host console** — laptop. Runs the session, grades answers, controls everything.
- **Presenter view** — projector/TV. Question text, big countdown, plays media. Read-only.
- **Team view** — phone/tablet. Question text, answer input, timer.

REST for admin CRUD (building quizzes). WebSockets for everything during a live session.

### Round types, decomposed

Rather than five hardcoded types, three independent axes:

- **Answer format**: `yes_no` | `text`
- **Media presentation**: `none` | `audio` | `video` | `image`
- **Media source**: `youtube` (id + clip range) | `file` (uploaded)
- **Points**: max per question, with a round-level default

Source and presentation are independent, which is what makes a music round
work: a YouTube *video* played as `audio` means the room hears it while the
player sits behind your own artwork.

So a music round is `text + audio`, a video round is `text + video`, a hard round is `text + none` with higher max points. Picture rounds come free. New types become configuration, not code.

## 3. Data model

The key split: **Quiz** is reusable content, **Session** is one night's run of it. Teams and answers belong to the session, so you can run the same quiz twice without mutating your question bank.

```
Quiz          id, title, created_at
Round         id, quiz_id, order, title,
              answer_format, media_type,
              time_limit_seconds, default_max_points
Question      id, round_id, order, prompt,
              media_source, media_url, youtube_id,
              clip_start, clip_end,
              correct_answer, accepted_answers[], max_points
Tiebreaker    id, quiz_id, order, prompt, correct_answer,
              mode, time_limit_seconds

Session       id, quiz_id, join_code, presenter_token, state,
              current_round_id, current_question_id,
              question_started_at, created_at, finished_at
Team          id, session_id, name, token, last_seen
Answer        id, session_id, team_id, question_id,
              value, submitted_at, points_awarded
```

`Question.max_points` is nullable and falls back to `Round.default_max_points` — set it once per round, override individual questions.

**Partial credit removes a field rather than adding one.** There is no `is_correct`; the grader awards `points_awarded` anywhere from 0 to max, and `null` means ungraded. This handles the common "2 points — artist and title" case natively, where a team gets one for the artist alone. Auto-graded yes/no just writes 0 or max. Integers only, no decimals.

`Tiebreaker.mode` is `exact` or `closest`. See §5.

## 4. Session state machine

**Session states:** `lobby → in_round → round_review → leaderboard → tiebreaker → finished`

`round_review` and `leaderboard` are both reachable from the end of a round, in either order, at the host's discretion.

**Question phases** (while `in_round`): `idle → revealed → playing_media → answering → locked`

Text and yes/no questions skip `playing_media` entirely.

**Host actions:** reveal question · play media · replay media · start timer · extend +30s · lock now · reopen question · next question · next round · reveal round answers · open grading · reveal leaderboard · run tiebreaker · finish session

Grading is an **overlay** available in any state, not a phase of its own.

### Natural running order for a round

Reveal answers → grade during the noise → reveal leaderboard. Correct answers are authored content, so the review needs no grading first — you can put them up the instant the round locks, while the room is still animated, and mark at your own pace afterwards.

### Media question flow

1. Host reveals — prompt appears on phones and big screen ("Q3 — name the artist and the track"). No timer yet.
2. Host plays the clip. Presenter view only.
3. Clip ends → timer auto-starts. Host can override and hit **replay** instead; timer starts on the final play.

The replay button matters. You will use it every single music round.

### Tiebreaker flow

Enabled only when the final standings show a tie at rank 1. Whichever teams are tied take part — usually two, but don't hardcode two, a three-way tie is possible.

- Tied teams get the answer input; everyone else gets a spectator screen naming the contenders, not a dead page.
- Questions run in order until one team leads.
- **Make the last tiebreaker `closest` mode.** Two `exact` questions can both come back tied — both right or both wrong — and then you're improvising in front of a room. A numeric closest-wins question ("how many steps in the Eiffel Tower") can't tie in practice, so it guarantees resolution.

## 5. The tricky bits

**Timer sync.** Never push ticks. Send `question_started_at` + `time_limit` + `server_now` with every state message. Client computes `offset = server_now - client_now` and counts down locally, re-syncing the offset on each message. Smooth, and resilient to a laggy connection.

**Late submissions.** Server accepts up to `started_at + limit + 2s` to absorb network latency. Client hard-disables input at 0 so nobody feels cheated.

**Reconnection.** Highest-risk area, given cloud hosting and venue wifi. Two distinct cases, both required:

*Dropped connection* — page state survives, Socket.IO reconnects, client re-syncs. Mostly free.

*Refresh or accidental close* — all JS state is gone. Team token lives in localStorage; on load it sends the token and receives a full snapshot: current phase, question, **remaining** time (not elapsed), and its own current answer. Every state message is a complete snapshot, never a diff, so recovery is the same code path as first load.

The thing refresh breaks that a dropped socket doesn't is **unsubmitted typing**. Solution: autosave the answer to the server on a 500ms debounce and treat every save as the submission. No draft/submitted distinction to lose, and no submit button for a team to forget under time pressure. Restoring after refresh is then just reading the answer off the snapshot.

Two consequences:

- **Allow multiple sockets per team.** Two people on two phones is legitimate. Broadcast answer updates to all of a team's sockets so they see each other's edits rather than silently clobbering them.
- **Provide a re-link path.** Cleared browser or a switched device means the token is unrecoverable. Host console gets a "re-link team" action issuing a fresh token for an existing team, so their score survives.

Invalid or expired tokens (session finished, team removed) should render a clear message, not a half-broken screen.

**Media reliability — the one real trade.** YouTube embeds cannot be preloaded or cached. You stream from YouTube at the instant you press play, over venue wifi, which is exactly the risk that uploaded files were meant to remove. Both sources are therefore supported per question:

- **YouTube** — paste a link, set `clip_start` and `clip_end`. The IFrame API's `loadVideoById({videoId, startSeconds, endSeconds})` plays the segment and fires `ENDED` at your out point, which is the hook that starts the answer timer. Replay is `seekTo(clip_start)`. A pasted `?t=` timestamp should prefill the start second.
- **Uploaded file** — preloaded and cached as a blob URL by the presenter when the session opens, with a progress indicator. Slower to author, immune to the network.

**Pre-flight every clip in the lobby.** Two failure modes only surface when you press play in front of the room: rights holders disable embedding on a lot of music videos, and videos get pulled between authoring night and quiz night. The API's `onError` distinguishes them — 101/150 embedding disabled, 100 removed or private, 2 bad link. Cue each clip in the lobby and confirm it plays before guests arrive; anything that fails should be swappable to an uploaded file on the spot.

**Belt and braces on the timer.** If `ENDED` never fires, the answer timer never starts. Run a fallback timeout of `clip_end - clip_start` seconds alongside the event, whichever lands first.

**Grading UI.** One question at a time, all teams' answers listed together. Normalize (lowercase, trim, strip punctuation) and cluster identical answers so one action marks all of them. Pre-mark anything matching `accepted_answers[]` as a suggestion the host confirms. With max points usually 1–2, render a row of `max + 1` buttons per answer — awarding partial credit is then a single tap, not a number entry.

Consistency across teams is the whole point. Nobody should get a point for "Beetles" while another team loses one.

**Provisional leaderboard.** Before revealing standings, the console warns "7 answers ungraded," and ungraded rounds show as provisional rather than silently scoring zero. This applies to the leaderboard only — the round review shows authored answers and is always safe to reveal.

**Team names.** Reject case-insensitive duplicates within a session. Host can rename or remove a team from the lobby — someone will pick something unprintable.

**Join code + QR.** 5 characters, excluding ambiguous glyphs (0/O, 1/I/L). Put a QR code on the presenter view; on phones it removes all typing friction.

**Presenter access.** The presenter view uses its own unguessable URL token (`/present/:presenter_token`), not the admin password. You'll want to open it on a TV browser or second laptop, and typing your admin password on a screen facing the room is a bad time.

**Retention.** No history is kept, but don't purge the moment the host presses finish — disputes surface five minutes later. Purge on an explicit "clear session," with an auto-expiry after ~7 days as a backstop. Quizzes themselves persist regardless; only teams and answers are disposable.

## 6. Stack

- **Backend** — Node 22, TypeScript, Fastify, Socket.IO (reconnection and rooms come free, which matters here)
- **DB** — Postgres, Drizzle ORM
- **Frontend** — React + Vite + TypeScript + Tailwind
- **Shared** — pnpm workspace with `packages/shared` holding Zod schemas for every socket event. One source of truth for wire types across all three surfaces; the main reason to run TS on both ends.
- **Media** — object storage (Cloudflare R2 or S3), signed upload URLs from the admin panel
- **Auth** — single password hashed in an env var, signed session cookie
- **Deploy** — see below. Frontend anywhere; the socket server needs a long-lived process

## 6a. Deployment, and why not all of it on Vercel

Vercel added native WebSocket support in June 2026, and Socket.IO works on it — so the honest answer is "partly." Two properties of the function model collide with this specific app:

- **Connections pin to the instance that accepted them, and later connections aren't guaranteed to land on the same one.** Ten teams joining over ten minutes can end up spread across instances with no shared memory. The host's "reveal question" then reaches only the teams that happen to share an instance, which breaks lockstep — the single property the whole design rests on.
- **A connection lives no longer than the function's max duration.** A pub quiz runs 90 minutes to two hours.

Vercel's own guidance is to put durable cross-connection state in Redis. That works, and the snapshot-on-reconnect design already absorbs forced reconnects gracefully. But it means adding Redis pub/sub for fan-out and moving session state out of memory — reintroducing exactly the distributed-systems overhead §2 avoided on purpose, to serve ten people in a pub.

**Free options, best first:**

**1. Cloudflare Workers + Durable Objects — recommended.** One DO per session is the §2 design (single instance, state in memory, trivial broadcast) made serverless. Every team addresses the same object by session id, so the cross-instance fan-out problem that rules out Vercel simply doesn't arise.

- Free plan: 100k requests/day, 13,000 GB-s/day. A 2-hour quiz at 128 MB costs ~900 GB-s — about 7% of a day, even without hibernation. Incoming WS messages bill at 20:1, so traffic is negligible.
- SQLite-backed DOs include 5 GB free, which replaces Postgres for this app entirely.
- Trade: Workers runtime, so no Fastify/Socket.IO — raw WebSocket API instead. The snapshot design never depended on Socket.IO.
- **Use DO Alarms, not setTimeout, for the auto-lock.** Any setTimeout/setInterval disables hibernation.

**2. Render free web service — zero rewrite.** Keeps the Node/Socket.IO plan as written. Free services sleep after 15 min without inbound traffic, but WebSocket messages from live connections count as traffic, so an active quiz stays awake. Cost is a 30–60s cold start on first connect: open the room a few minutes early. 512 MB / 0.1 CPU, 750 instance-hours a month.

**3. Database (only if not on Durable Objects).** Not Render's — free Postgres there expires at 30 days, then is deleted after a 14-day grace period. Neon (0.5 GB/project, scale-to-zero) or Supabase (500 MB plus auth and storage) are the durable free tiers.

**Frontend** is free anywhere — Cloudflare Pages, Vercel, Netlify. Pages keeps everything on one platform if you take option 1.

## 7. Build order

1. **Foundations** — schema, admin auth, quiz/round/question CRUD
2. **Session core** — create session, join code, lobby, team join, socket plumbing, snapshot sync
3. **Question loop** — reveal → timer → autosave answer → lock, for yes/no and text
4. **Grading + leaderboard** — grading overlay, auto-grade yes/no, partial credit, standings
5. **Media rounds** — upload, presenter playback, preload/cache, replay, timer-on-end
6. **Round review + tiebreaker** — answer reveal screen, tie detection, spectator view
7. **Hardening** — reconnection edge cases, host recovery controls, QR, reveal animation

Playable end-to-end after step 4. Steps 5–7 are what make it good.

## 8. Deliberately out of scope

Session history and past-results browsing · multiple admin accounts · team self-service scorecards · question bank search and reuse across quizzes · offline/local-network mode.

Worth revisiting the last one if venue wifi turns out to be a recurring problem.
