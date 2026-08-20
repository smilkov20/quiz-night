# Quiz Night

A live pub quiz app. The host drives the room in lockstep; teams answer on their
own phones; the projector shows the question and plays the clips.

One Node process serves the frontend *and* the WebSockets, so it deploys as a
single free service — no database, no credit card.

## Layout

```
packages/shared         types + wire protocol, imported by both ends
apps/server             Node + ws — the whole backend
apps/web                Vite + React — all three surfaces
alternatives/cloudflare-worker   Workers/Durable Objects backend (not in the workspace)
```

Three surfaces, three URLs, because they're three devices:

| URL | Surface | Device |
|---|---|---|
| `/` | Team join and play | Phones |
| `/host` | Editor, then the console | Host laptop |
| `/present/:code/:token` | Projector | TV — no password needed |

## Running locally

```bash
pnpm install
pnpm --filter @quiz/web build          # the server serves this
HOST_PASSWORD=secret pnpm start
```

Open `http://localhost:8787/host`, sign in, press **Open the room**. The
presenter URL is logged to the browser console.

For frontend hot reload while developing, `pnpm dev` runs Vite on `:5173`
against the server on `:8787` (set `VITE_API_URL=http://localhost:8787`).

Run the end-to-end suite — 22 checks covering lockstep, auto-lock,
late-submission refusal, privilege separation, reconnection and marking:

```bash
HOST_PASSWORD=test-password PORT=8899 pnpm --filter @quiz/server start &
pnpm test:e2e
```

## Deploying free, without a card

**Render** is the recommended target: connect the repo, no CLI, no card.

1. Push to GitHub.
2. Render → New → Blueprint, point it at this repo. `render.yaml` does the rest.
3. Set `HOST_PASSWORD` in the dashboard.

The catch is spin-down: a free service sleeps after 15 minutes without inbound
traffic and takes 30–60s to wake. WebSocket messages count as traffic, so a
running quiz keeps itself awake — **open the room a few minutes before guests
arrive** and you'll never notice it.

**Koyeb** is the backup if Render asks you for a card (reports differ). It
scales to zero after an hour rather than 15 minutes, but may ask for a card to
verify you're human. Use the `Dockerfile`.

Any host that runs a long-lived Node process works. Vercel and Netlify don't,
because a serverless function can't hold a socket open for a two-hour quiz.

## No database, on purpose

Quizzes live in the **host's browser** and travel to the server in the request
body when you open a room. Live sessions live in server memory and are discarded
afterwards — you didn't want history.

That removes the last thing needing a paid or card-gated tier. The trade is
real, so the editor has **Export** and **Import**: your quiz bank is one browser
profile, not a backup. Export after a big editing session.

If you later want a shared bank, Neon and Supabase both have card-free Postgres
free tiers, and the store is small enough to slot in behind two API routes.

## Design decisions worth knowing before you change things

**Every server message is a whole snapshot, never a diff.** A phone that drops
wifi or gets refreshed by a stray thumb reconnects, receives a snapshot, and is
correct again. First load and reconnect are the same code path, so there's no
replay logic to get wrong.

**The timer is derived, never ticked.** The server sends `questionStartedAt`
plus `serverNow`; each client computes its clock offset and counts down locally.
A laggy connection doesn't make the clock stutter, and a skewed device clock
can't award anyone extra seconds.

**The lock lags the clock by two seconds, deliberately.** Answers autosave on a
500ms debounce, so a team typing at the buzzer sends slightly after zero. The
server accepts for 2s past the deadline and locks then; the clients show "pens
down" at zero and flush any pending answer first. The room sees a clean stop
while the grace window quietly does its job.

**There is no submit button.** Nothing to forget under time pressure, nothing
lost to a refresh.

**Marking clusters answers by normalised text.** "Tungsten", "tungsten" and
"Tungston" collapse into one row, so one action marks everyone who wrote the
same thing. Consistency across teams is the entire point of that screen.

**Partial credit removed a field rather than adding one.** There's no
`isCorrect`; the grader awards `points` from 0 to max, and `null` means
unmarked. A 2-point "artist and title" question handles half marks natively.

**Media plays centrally.** Team devices never touch a media file. Music rounds
cover the video picture so a thumbnail can't give the answer away.

## The Cloudflare alternative

`alternatives/cloudflare-worker` is a complete Durable Objects backend, kept because
it's architecturally the better fit: one object per session gives the same
single-owner in-memory model with no server to keep awake, and it's free at this
scale. It needs a Cloudflare account, which is what pushed us to Node. Same wire
protocol, so the frontend works against either.

## Known gaps

- **YouTube clips can't be preloaded** — you stream at the moment you press
  play. Check every clip in the lobby: embedding gets disabled and videos get
  pulled without warning.
- **File upload isn't built.** `mediaSource: "file"` is in the model, no UI.
- **The tiebreak winner is picked by hand.** Fine for `exact`; a `closest`
  question could be scored automatically.
- **A server restart drops live rooms.** Sessions are in memory, so restarting
  mid-quiz means re-opening the room and teams rejoining.
- **Never scale this service past one instance.** Sessions live in memory and
  Render's load balancer assigns each WebSocket connection to a random instance,
  so a second instance would split the room. Free gives you one, so this only
  matters if you upgrade.
- **Not yet run with real phones in a real room.** Verified by an automated
  end-to-end suite, not by a live quiz.
