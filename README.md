# @cyftec/drive-socket

Google Drive `appDataFolder` messaging for static PWAs — push immutable file messages, receive them over a polling socket, and prune old messages on push. TypeScript source is published as-is (no build step).

## Requirements

- Browser environment (OAuth 2.0 PKCE redirect flow)
- Google Cloud OAuth 2.0 client ID (Web application)
- Authorized redirect URI matching your PWA origin (defaults to `origin + pathname`)
- OAuth scope: `https://www.googleapis.com/auth/drive.appdata` (single-tenant) or `https://www.googleapis.com/auth/drive.file` (multi-tenant)
- TypeScript ^5 (package ships `.ts` sources)

## Install

```bash
npm install @cyftec/drive-socket
```

## Setup

1. Create a Google Cloud project and OAuth **Web client** credentials.
2. Add your PWA origin to **Authorized JavaScript origins**.
3. Add your redirect URI (typically `https://your-app.example/`) to **Authorized redirect URIs**.
4. Create a `GoogleAuth` instance, call `authenticate()`, then pass it to `DriveSocket.connect`.

## Usage

```typescript
import { DriveSocket, getGoogleAuthSingleton } from "@cyftec/drive-socket";

const auth = getGoogleAuthSingleton({
  googleApiClientId: "YOUR_CLIENT_ID.apps.googleusercontent.com",
  googleOAuthTokenScopes: "https://www.googleapis.com/auth/drive.appdata",
});

// First visit: redirects to Google sign-in (PKCE). Callback URL is cleaned automatically.
await auth.authenticate();

if (!(await auth.isAuthenticated())) {
  throw new Error("Authentication required.");
}

const socket = await DriveSocket.connect(
  {
    clientType: "single-tenant",
    rootPath: "my-app/messages",
    pollIntervalInMs: 5000,
    maxFiles: 20,
  },
  auth,
);

// Push a JSON message with a user-provided filename
const fileBlob = new Blob([JSON.stringify({ hello: "world" })], {
  type: "application/json",
});

await socket.push({
  fileBlob,
  mimeType: "application/json",
  fileName: "hello.json",
});

// Receive all folder files each poll cycle (downloaded, newest first)
socket.onReceive(async (messages) => {
  for (const message of messages) {
    const text = await message.fileBlob.text();
    console.log(message.name, text);
  }
});

await socket.disconnect();
await auth.logout();
```

On `authenticate()`, `GoogleAuth` processes OAuth callback query params when present, restores a valid session from `localStorage` (`google_auth_session`), silently refreshes expired access tokens via the stored refresh token, or redirects to Google for interactive consent. `isAuthenticated()` checks local session validity and can optionally verify the access token remotely. `DriveSocket.connect()` verifies authentication before resolving the folder. `auth.fetch()` attaches the bearer token and recovers from mid-request 401/403 auth failures and transient 5xx responses. `logout()` revokes the refresh token (or access token) at Google and clears all local auth state.

Sign-in uses the authorization-code + PKCE model (no backend `client_secret` required). After the user approves access once, refresh tokens enable silent renewal across page reloads.

## API

| Method | Description |
|--------|-------------|
| `getGoogleAuthSingleton(config)` | One `GoogleAuth` instance per page |
| `GoogleAuth.authenticate()` | Handle OAuth callback, restore/refresh session, or redirect to Google |
| `GoogleAuth.isAuthenticated(checkRemote?)` | Return whether a valid session exists; optionally verify remotely |
| `GoogleAuth.logout()` | Revoke tokens on Google and clear persisted session and in-flight PKCE state |
| `GoogleAuth.fetch(url, init?)` | Authorized `fetch` with token refresh and retry logic |
| `DriveSocket.connect(config, auth)` | Verify auth, resolve `rootPath` in Drive, and return a connected socket |
| `disconnect()` | Stop polling and mark the socket inactive |
| `push(payload)` | Upload immutable message; returns saved `DriveMessage` while prune runs in the background |
| `onReceive(callback)` | Poll on `pollIntervalInMs`; download and emit all folder files each cycle |

### `onReceive` poll cycle

Each cycle:

1. List all files in the configured folder
2. Download every file
3. Invoke the callback once with all `DriveMessage` values, sorted newest-first
4. Wait the full `pollIntervalInMs`, then start the next cycle

If a cycle is still running when `pollIntervalInMs` would elapse, the timer is held until that cycle finishes. The next cycle always starts after a full `pollIntervalInMs` wait from completion — elapsed work time is not subtracted from the interval.

### Config

| Property | Description |
|----------|-------------|
| `clientType` | `"single-tenant"` (`appDataFolder` / `drive.appdata`) or `"multi-tenant"` (`drive` / `drive.file`) |
| `rootPath` | Folder path under the space (created if missing) |
| `pollIntervalInMs` | Poll cycle length in milliseconds |
| `maxFiles` | Maximum files kept in folder (oldest pruned in the background after each `push`) |

### `GoogleAuthConfig`

| Property | Description |
|----------|-------------|
| `googleApiClientId` | OAuth Web client ID |
| `googleOAuthTokenScopes` | Space-separated scope string or array of scopes |
| `redirectUri` | Optional override; defaults to `window.location.origin + window.location.pathname` |

### `NewMessagePayload`

| Property | Description |
|----------|-------------|
| `fileBlob` | File contents to upload |
| `mimeType` | Google-supported MIME type |
| `fileName` | Destination file name in the folder |

### `DriveMessage`

Saved message returned from `push` and `onReceive`. Extends `DriveFileEntry`.

| Property | Description |
|----------|-------------|
| `id` | Google Drive file ID |
| `name` | File name in the folder |
| `createdTime` | Drive file creation timestamp |
| `mimeType` | File MIME type |
| `fileBlob` | Downloaded file contents |
| `isError` | `true` when a polled file could not be downloaded |

## MIME types

Only Google-supported MIME types in the package allowlist are accepted on `push`. The filename extension must match the MIME type. HTML, CSS, and JavaScript MIME types are excluded. See exported `MIME_TO_EXTENSION` and `SupportedMimeType`.

## License

MIT
