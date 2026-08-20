# Cloudflare Workers + Durable Objects backend

An alternative to `apps/server`, speaking the identical wire protocol — the
frontend works against either without changes.

Architecturally it's the better fit: one Durable Object per session gives the
same single-owner in-memory model with no server to keep awake, and no spin-down.
It needs a Cloudflare account, which is why the Node server is the default.

Deliberately outside the pnpm workspace so that deploying the Node server never
installs wrangler. To work on it:

    cd alternatives/cloudflare-worker
    npm install
    npx wrangler secret put HOST_PASSWORD
    npx wrangler deploy

Note it keeps quizzes server-side in a `QuizLibrary` object, whereas the Node
server keeps them in the host's browser. The editor currently expects the Node
server's behaviour.
