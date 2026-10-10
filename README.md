# Warden

Encrypted, locally-hosted personal document vault - MERN stack (MongoDB, Express, React/Vite).

**Deploying:** see [DEPLOY.md](DEPLOY.md) for the Vercel + MongoDB Atlas runbook.

## Running the dev servers

From the project root, once:

```
npm install
```

Then, any time you want to work on Warden:

```
npm run dev
```

This starts both the backend (`server/`, `nodemon server.js`) and the frontend (`client/`, `vite --host`) together in one terminal, with output labeled `[server]` / `[client]` so it's clear which log line came from which process. `Ctrl+C` stops both cleanly.

This root `package.json` is only a coordinating layer, built with [`concurrently`](https://www.npmjs.com/package/concurrently) - it doesn't change anything inside `server/package.json` or `client/package.json`. Running them separately in two terminals still works exactly as before, if you'd rather do that:

```
cd server && npm run dev
```

```
cd client && npm run dev
```

The `dev` script also passes `-k` (`--kill-others`) to `concurrently`, so if either side crashes (e.g. the backend exits because MongoDB isn't running), the other is stopped too instead of being left running by itself.

**If a stop ever seems to leave something behind** (e.g. `http://localhost:5000` still responds after you've stopped `npm run dev`): this is a known rough edge with `npm`/Windows console process trees in some setups, not specific to this project. A `predev` script now runs `npx kill-port 5000 5173` automatically before every `npm run dev`, so this now happens automatically - but you can still run `npx kill-port 5000 5173` manually if needed, or check Task Manager for a leftover `node.exe` and end it.

## Tests

`cd server && npm test` and `cd client && npm test` (Node's built-in runner, no extra packages).

Most server tests use in-memory fakes. A few need a real MongoDB, because they test what fakes cannot (parallel requests against one counter, and the whole app answering real HTTP requests as two different accounts): the login lockout, parallel sign-ups, the activity-log limits and `cross-user.test.js` (every owner route called as another account). They use a **local throwaway MongoDB only**: `mongodb://127.0.0.1:27099/` as a replica set by default, or the address in `WARDEN_TEST_MONGO` (it must be 127.0.0.1 or localhost; anything else is refused). Each test file creates and drops its own database, mail is captured instead of sent, and no `.env` file is read. When no local MongoDB answers, those tests are **skipped with the reason**, not failed.

