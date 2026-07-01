# SoloForge Deployment Guide (single-host / desktop)

> Designed for SoloForge running as a desktop or local-server app. If you are
> deploying SoloForge to a remote multi-user server, see PRODUCTION-CLOUD.md
> (TODO: future doc). The security model is the same; the operational details
> below favor ergonomics over cluster concerns.

## What is an API token, in plain words?

SoloForge's backend exposes HTTP routes (e.g. "list agents", "dispatch
decision"). Without a token, anyone on the network can call them. A token is
a long random string your front-end sends on every request as
`Authorization: Bearer <token>`. SoloForge only accepts requests that
present a valid token (unless they come from 127.0.0.1 — your own machine).

You never have to invent a token. The system creates one for you on first
start and stores it in the OS keychain. Your front-end picks it up
automatically.

## Default flow (zero configuration)

1. First `npm start`:
   - No `SOLOFORGE_API_TOKENS` env var set.
   - API server calls `loadApiTokensAsync()` -> checks env -> checks vault
     -> falls back to **auto-generation** (only happens if
     `SOLOFORGE_REQUIRE_TOKENS=0`, the desktop-friendly default).
   - A 64-character hex token is generated via `crypto.randomBytes(32)` and
     saved to the OS keychain via `apiKeyVault`.

2. Your same-machine front-end (Electron, Tauri, browser at `localhost`)
   calls `GET /api/auth/bootstrap` once at startup. The route is hard-gated
   to loopback IPs, so only processes on your own computer can hit it.
   It returns:
   ```json
   { "token": "<64-char hex>", "count": 1, "source": "vault" }
   ```
   The front-end stores this in memory and uses it for subsequent calls.

3. Subsequent `npm start`: token is read from the OS keychain. Nothing to do.

## Token management (CLI)

```bash
npm run token:show     # show status (env / vault) without revealing the token
npm run token:list     # same as show; pass --reveal to print the raw token
npm run token:init     # generate a fresh token (refuses if one exists)
npm run token:init -- --force   # overwrite
npm run token:rotate   # add a new token alongside the old one (for client migration)
npm run token:revoke   # interactive: pick a token to remove
npm run token:clear    # wipe all tokens (you must `init` again afterwards)
```

## Why a vault and not just an env var?

- Env vars are visible to every child process and to anyone with `/proc`
  access. The OS keychain is encrypted at rest and isolated per-user.
- The vault is the same `apiKeyVault` that already holds your LLM API keys
  in `src/security/apiKeyVault.ts`. Using it for auth tokens is consistent.
- In a desktop app, the user does not have to set environment variables.
  The install just works.

## Loopback trust (why front-end does not need a token at all on the same machine)

The auth layer treats requests from `127.0.0.1` (and `::1`) as
already-authenticated admin by default. This is intentional: the same
machine running SoloForge is implicitly trusted. To turn this off (e.g. if
you run a hardened setup where the front-end is in a different sandbox),
set `SOLOFORGE_TRUST_LOOPBACK=0`. In that case both your front-end and
curl/Postman need to present a Bearer token.

## What you do NOT need to do

- You do not need to generate tokens by hand. The system does it.
- You do not need to set `SOLOFORGE_API_TOKENS` in development.
- You do not need to put tokens in `.env` or any file.
- You do not need to ship a token with the application. Each installation
  creates its own.

## When you DO need to manage tokens manually

- **Leak suspected**: `npm run token:rotate` adds a new token; update the
  front-end; `npm run token:revoke` removes the old one.
- **Multiple installations on different machines**: each machine's vault is
  local, so each has its own token. Nothing to share.
- **Hardened production on a server**: set `SOLOFORGE_API_TOKENS` env var
  to two comma-separated tokens (one for rotation) AND set
  `SOLOFORGE_REQUIRE_TOKENS=1` AND `SOLOFORGE_TRUST_LOOPBACK=0`. See the
  `setRequiredEnv` section below for CI / containerized deploys.

## What is currently NOT in scope

- Multi-user access control (only one shared token; revoke via
  `SOLOFORGE_REVOKED_TOKENS` env var list).
- Per-route fine-grained roles (the auth layer supports a 4-level role
  ladder: public / agent / operator / admin, but UI currently uses just
  admin).
- Hardware-key / OAuth login. The token is the entire auth surface.

## API quick reference

```bash
# Get the current token (loopback only)
curl http://127.0.0.1:<port>/api/auth/bootstrap

# Use the token
curl -H "Authorization: Bearer <token>" http://127.0.0.1:<port>/api/vault/keys

# WebSocket example (browsers cannot set headers on EventSource; use ?token=)
curl "http://127.0.0.1:<port>/api/events/stream?token=<token>"
```