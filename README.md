# Warden

Encrypted, locally-hosted personal document vault - MERN stack (MongoDB, Express, React/Vite).

## Running the dev servers

From the project root, once:

```
npm install
```

Then, any time you want to work on Warden:

```
npm run dev
```

This starts both the backend (`server/`, `nodemon server.js`) and the frontend (`client/`, `vite --host` so it's also reachable from a phone on the same LAN) together in one terminal, with output labeled `[server]` / `[client]` so it's clear which log line came from which process. `Ctrl+C` stops both cleanly.

This root `package.json` is only a coordinating layer, built with [`concurrently`](https://www.npmjs.com/package/concurrently) - it doesn't change anything inside `server/package.json` or `client/package.json`. Running them separately in two terminals still works exactly as before, if you'd rather do that:

```
cd server && npm run dev
```

```
cd client && npm run dev
```

The `dev` script also passes `-k` (`--kill-others`) to `concurrently`, so if either side crashes (e.g. the backend exits because MongoDB isn't running), the other is stopped too instead of being left running by itself.

**If a stop ever seems to leave something behind** (e.g. `http://localhost:5000` still responds after you've stopped `npm run dev`): this is a known rough edge with `npm`/Windows console process trees in some setups, not specific to this project. A `predev` script now runs `npx kill-port 5000 5173` automatically before every `npm run dev`, so this now happens automatically - but you can still run `npx kill-port 5000 5173` manually if needed, or check Task Manager for a leftover `node.exe` and end it.
