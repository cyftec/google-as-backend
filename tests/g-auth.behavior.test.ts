import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { getGoogleAuthSingleton } from "../src/google/g-auth.ts";
import {
  AUTH_SESSION_KEY,
  CLIENT_ID,
  createTestAuthInstance,
  CSRF_STATE_KEY,
  DRIVE_APPDATA_SCOPE,
  getTestAuth,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKENINFO_URL,
  installFetchRouter,
  installGoogleTokenFetchMock,
  installLocalStorageMock,
  installLocationMock,
  installSessionStorageMock,
  loadAuthSession,
  PKCE_VERIFIER_KEY,
  resetTestAuthState,
  seedAuthSession,
  setupOAuthCallback,
  type GoogleAuth as GoogleAuthType,
} from "./mocks/g-auth-harness.ts";

describe("GoogleAuth", () => {
  let restoreTokenFetch: () => void = () => {};
  let restoreFetchRouter: () => void = () => {};
  let localStorageMock: { storage: Map<string, string> };
  let sessionStorageMock: { storage: Map<string, string> };
  let auth: GoogleAuthType;
  let warnSpy: ReturnType<typeof spyOn<typeof console, "warn">>;

  beforeEach(() => {
    localStorageMock = installLocalStorageMock();
    sessionStorageMock = installSessionStorageMock();
    installLocationMock();
    auth = getTestAuth();
    restoreTokenFetch = installGoogleTokenFetchMock();
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    restoreFetchRouter();
    restoreTokenFetch();
  });

  describe("PKCE redirect", () => {
    it("stores verifier and CSRF state before redirect", async () => {
      const { location } = installLocationMock();
      resetTestAuthState(auth);

      await auth.authenticate();

      expect(location.href).toContain("accounts.google.com/o/oauth2/v2/auth");
      expect(sessionStorageMock.storage.has(PKCE_VERIFIER_KEY)).toBe(true);
      expect(sessionStorageMock.storage.has(CSRF_STATE_KEY)).toBe(true);
    });

    it("redirect URL includes PKCE and offline consent params", async () => {
      const { location } = installLocationMock();
      resetTestAuthState(auth);

      await auth.authenticate();

      const redirectUrl = new URL(location.href);
      expect(redirectUrl.searchParams.get("response_type")).toBe("code");
      expect(redirectUrl.searchParams.get("code_challenge_method")).toBe("S256");
      expect(redirectUrl.searchParams.get("code_challenge")).toBeTruthy();
      expect(redirectUrl.searchParams.get("access_type")).toBe("offline");
      expect(redirectUrl.searchParams.get("prompt")).toBe("consent");
      expect(redirectUrl.searchParams.get("redirect_uri")).toBe(
        "http://localhost/",
      );
      expect(redirectUrl.searchParams.get("client_id")).toBe("client-id");
    });

    it("uses custom redirectUri when configured", async () => {
      const customAuth = createTestAuthInstance({
        redirectUri: "https://app.example/callback",
      });
      const { location } = installLocationMock();
      resetTestAuthState(customAuth);

      await customAuth.authenticate();

      expect(new URL(location.href).searchParams.get("redirect_uri")).toBe(
        "https://app.example/callback",
      );
    });

    it("redirect includes configured scopes", async () => {
      const { location } = installLocationMock();
      resetTestAuthState(auth);

      await auth.authenticate();

      expect(location.href).toContain(
        encodeURIComponent(DRIVE_APPDATA_SCOPE),
      );
    });

    it("returns valid session without redirect", async () => {
      const { location } = installLocationMock();
      const session = seedAuthSession(localStorageMock.storage);
      loadAuthSession(auth, session);

      const result = await auth.authenticate();

      expect(result).toEqual(session);
      expect(location.href).toBe("http://localhost/");
    });

    it("silently refreshes expired session via refresh token", async () => {
      let refreshCount = 0;
      restoreTokenFetch();
      restoreTokenFetch = installGoogleTokenFetchMock({
        onRefresh: () => {
          refreshCount += 1;
        },
      });

      loadAuthSession(
        auth,
        seedAuthSession(localStorageMock.storage, {
          access_token: "expired-access",
          expiresAt: Date.now() - 1000,
        }),
      );

      await auth.authenticate();

      expect(refreshCount).toBe(1);
      expect(localStorageMock.storage.get(AUTH_SESSION_KEY)).toContain(
        "refreshed-access-token",
      );
    });

    it("redirects when refresh fails", async () => {
      restoreTokenFetch();
      restoreTokenFetch = installGoogleTokenFetchMock({ refreshFails: true });
      const { location } = installLocationMock();

      loadAuthSession(
        auth,
        seedAuthSession(localStorageMock.storage, {
          access_token: "expired-access",
          expiresAt: Date.now() - 1000,
        }),
      );

      await auth.authenticate();

      expect(location.href).toContain("accounts.google.com/o/oauth2/v2/auth");
    });
  });

  describe("OAuth callback", () => {
    it("exchanges code with PKCE verifier and persists session", async () => {
      const { location } = installLocationMock();
      resetTestAuthState(auth);
      let exchangedVerifier = "";
      let exchangedRedirectUri = "";

      restoreTokenFetch();
      restoreTokenFetch = installGoogleTokenFetchMock({
        onTokenExchange: (body) => {
          exchangedVerifier = body.get("code_verifier") ?? "";
          exchangedRedirectUri = body.get("redirect_uri") ?? "";
        },
      });

      setupOAuthCallback(location, {
        stateToken: "csrf-state-token",
        verifier: "test-verifier",
      });

      const result = await auth.authenticate();

      expect(exchangedVerifier).toBe("test-verifier");
      expect(exchangedRedirectUri).toBe("http://localhost/");
      expect(result).toMatchObject({ access_token: "test-access-token" });
      expect(localStorageMock.storage.get(AUTH_SESSION_KEY)).toContain(
        "test-access-token",
      );
      expect(sessionStorageMock.storage.has(PKCE_VERIFIER_KEY)).toBe(false);
      expect(sessionStorageMock.storage.has(CSRF_STATE_KEY)).toBe(false);
    });

    it("clears callback query params from the URL", async () => {
      const { location } = installLocationMock();
      resetTestAuthState(auth);

      setupOAuthCallback(location, {
        stateToken: "csrf-state-token",
        verifier: "test-verifier",
      });

      await auth.authenticate();

      expect(location.search).toBe("");
    });

    it("rejects callback error param and clears session", async () => {
      const { location } = installLocationMock();
      loadAuthSession(
        auth,
        seedAuthSession(localStorageMock.storage, {
          access_token: "existing-access",
        }),
      );
      location.search = "?error=access_denied";

      await expect(auth.authenticate()).rejects.toThrow(
        "Google OAuth Error: access_denied",
      );
      expect(localStorageMock.storage.has(AUTH_SESSION_KEY)).toBe(false);
    });

    it("rejects callback without state", async () => {
      const { location } = installLocationMock();
      resetTestAuthState(auth);
      location.search = "?code=auth-code";

      await expect(auth.authenticate()).rejects.toThrow(
        "CSRF Warning: Missing state parameter in callback URL.",
      );
      expect(localStorageMock.storage.has(AUTH_SESSION_KEY)).toBe(false);
    });

    it("rejects callback when session state is missing", async () => {
      const { location } = installLocationMock();
      resetTestAuthState(auth);
      location.search = "?code=auth-code&state=csrf-state-token";

      await expect(auth.authenticate()).rejects.toThrow(
        "CSRF Warning: No state session found. Request expired or unauthorized.",
      );
      expect(localStorageMock.storage.has(AUTH_SESSION_KEY)).toBe(false);
    });

    it("rejects malformed CSRF state storage", async () => {
      const { location } = installLocationMock();
      resetTestAuthState(auth);
      sessionStorage.setItem(CSRF_STATE_KEY, "not-json");
      location.search = "?code=auth-code&state=csrf-state-token";

      await expect(auth.authenticate()).rejects.toThrow(
        "CSRF Warning: Malformed local state storage.",
      );
      expect(localStorageMock.storage.has(AUTH_SESSION_KEY)).toBe(false);
    });

    it("rejects CSRF state mismatch", async () => {
      const { location } = installLocationMock();
      resetTestAuthState(auth);
      sessionStorage.setItem(
        CSRF_STATE_KEY,
        JSON.stringify({ stateToken: "saved-state" }),
      );
      location.search = "?code=auth-code&state=returned-state";

      await expect(auth.authenticate()).rejects.toThrow(
        "CSRF Warning: State mismatch detected.",
      );
      expect(localStorageMock.storage.has(AUTH_SESSION_KEY)).toBe(false);
    });

    it("rejects missing PKCE verifier on callback", async () => {
      const { location } = installLocationMock();
      resetTestAuthState(auth);
      setupOAuthCallback(location, {
        stateToken: "csrf-state-token",
        verifier: "test-verifier",
      });
      sessionStorage.removeItem(PKCE_VERIFIER_KEY);

      await expect(auth.authenticate()).rejects.toThrow(
        "PKCE missing code_verifier in sessionStorage.",
      );
    });

    it("rejects failed token exchange", async () => {
      const { location } = installLocationMock();
      resetTestAuthState(auth);
      restoreTokenFetch();
      restoreTokenFetch = installGoogleTokenFetchMock({ exchangeFails: true });

      setupOAuthCallback(location, {
        stateToken: "csrf-state-token",
        verifier: "test-verifier",
      });

      await expect(auth.authenticate()).rejects.toThrow("invalid_grant");
      expect(localStorageMock.storage.has(AUTH_SESSION_KEY)).toBe(false);
    });
  });

  describe("configuration", () => {
    it("exposes configured scopes", () => {
      expect(auth.getConfiguredScopes()).toBe(DRIVE_APPDATA_SCOPE);
    });
  });

  describe("isAuthenticated", () => {
    it("returns false when no session exists", async () => {
      resetTestAuthState(auth);
      expect(await auth.isAuthenticated()).toBe(false);
    });

    it("returns true for a valid local session", async () => {
      loadAuthSession(auth, seedAuthSession(localStorageMock.storage));
      expect(await auth.isAuthenticated()).toBe(true);
    });

    it("returns false for expired session without refresh token", async () => {
      loadAuthSession(
        auth,
        seedAuthSession(localStorageMock.storage, {
          expiresAt: Date.now() - 1000,
          refresh_token: "",
        }),
      );
      expect(await auth.isAuthenticated()).toBe(false);
    });

    it("refreshes expired session locally before returning true", async () => {
      let refreshCount = 0;
      restoreTokenFetch();
      restoreTokenFetch = installGoogleTokenFetchMock({
        onRefresh: () => {
          refreshCount += 1;
        },
      });

      loadAuthSession(
        auth,
        seedAuthSession(localStorageMock.storage, {
          expiresAt: Date.now() - 1000,
        }),
      );

      expect(await auth.isAuthenticated()).toBe(true);
      expect(refreshCount).toBe(1);
    });

    it("returns false when expired session refresh fails", async () => {
      restoreTokenFetch();
      restoreTokenFetch = installGoogleTokenFetchMock({ refreshFails: true });
      loadAuthSession(
        auth,
        seedAuthSession(localStorageMock.storage, {
          expiresAt: Date.now() - 1000,
        }),
      );

      expect(await auth.isAuthenticated()).toBe(false);
    });

    it("returns false when remote tokeninfo rejects the token", async () => {
      loadAuthSession(auth, seedAuthSession(localStorageMock.storage));
      restoreFetchRouter = installFetchRouter((url) => {
        if (url.startsWith(GOOGLE_TOKENINFO_URL)) {
          return new Response("invalid token", { status: 400 });
        }
        return null;
      });

      expect(await auth.isAuthenticated(true)).toBe(false);
    });

    it("returns true when remote tokeninfo accepts the token", async () => {
      loadAuthSession(auth, seedAuthSession(localStorageMock.storage));
      restoreFetchRouter = installFetchRouter((url) => {
        if (url.startsWith(GOOGLE_TOKENINFO_URL)) {
          return new Response(JSON.stringify({ aud: CLIENT_ID }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return null;
      });

      expect(await auth.isAuthenticated(true)).toBe(true);
    });

    it("returns false when remote token audience mismatches client id", async () => {
      loadAuthSession(auth, seedAuthSession(localStorageMock.storage));
      restoreFetchRouter = installFetchRouter((url) => {
        if (url.startsWith(GOOGLE_TOKENINFO_URL)) {
          return new Response(JSON.stringify({ aud: "other-client" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return null;
      });

      expect(await auth.isAuthenticated(true)).toBe(false);
    });

    it("returns false when remote verification fetch fails", async () => {
      loadAuthSession(auth, seedAuthSession(localStorageMock.storage));
      restoreFetchRouter = installFetchRouter((url) => {
        if (url.startsWith(GOOGLE_TOKENINFO_URL)) {
          throw new Error("network down");
        }
        return null;
      });

      expect(await auth.isAuthenticated(true)).toBe(false);
    });
  });

  describe("logout", () => {
    it("revokes refresh token remotely and clears persisted session and PKCE state", async () => {
      let revokedToken = "";
      loadAuthSession(auth, seedAuthSession(localStorageMock.storage));
      sessionStorage.setItem(PKCE_VERIFIER_KEY, "verifier");
      sessionStorage.setItem(CSRF_STATE_KEY, '{"stateToken":"x"}');

      restoreFetchRouter = installFetchRouter((url, init) => {
        if (url === GOOGLE_REVOKE_URL) {
          revokedToken = new URLSearchParams(String(init?.body ?? "")).get(
            "token",
          )!;
          return new Response(null, { status: 200 });
        }
        return null;
      });

      await auth.logout();

      expect(revokedToken).toBe("test-refresh-token");
      expect(localStorageMock.storage.has(AUTH_SESSION_KEY)).toBe(false);
      expect(sessionStorageMock.storage.has(PKCE_VERIFIER_KEY)).toBe(false);
      expect(sessionStorageMock.storage.has(CSRF_STATE_KEY)).toBe(false);
    });

    it("clears local state when no token is available", async () => {
      resetTestAuthState(auth);
      sessionStorage.setItem(PKCE_VERIFIER_KEY, "verifier");

      await auth.logout();

      expect(localStorageMock.storage.has(AUTH_SESSION_KEY)).toBe(false);
      expect(sessionStorageMock.storage.has(PKCE_VERIFIER_KEY)).toBe(false);
    });

    it("clears local state when remote revoke fails", async () => {
      loadAuthSession(auth, seedAuthSession(localStorageMock.storage));
      restoreFetchRouter = installFetchRouter((url) => {
        if (url === GOOGLE_REVOKE_URL) {
          throw new Error("network down");
        }
        return null;
      });

      await auth.logout();

      expect(localStorageMock.storage.has(AUTH_SESSION_KEY)).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        "Network error while revoking token on Google servers:",
        expect.any(Error),
      );
    });

    it("revokes access token when no refresh token is stored", async () => {
      let revokedToken = "";
      loadAuthSession(
        auth,
        seedAuthSession(localStorageMock.storage, {
          access_token: "access-only",
          refresh_token: "",
        }),
      );

      restoreFetchRouter = installFetchRouter((url, init) => {
        if (url === GOOGLE_REVOKE_URL) {
          revokedToken = new URLSearchParams(String(init?.body ?? "")).get(
            "token",
          )!;
          return new Response(null, { status: 200 });
        }
        return null;
      });

      await auth.logout();

      expect(revokedToken).toBe("access-only");
    });

    it("prefers refresh token over access token for revocation", async () => {
      let revokedToken = "";
      loadAuthSession(
        auth,
        seedAuthSession(localStorageMock.storage, {
          access_token: "access-only",
          refresh_token: "refresh-preferred",
        }),
      );

      restoreFetchRouter = installFetchRouter((url, init) => {
        if (url === GOOGLE_REVOKE_URL) {
          revokedToken = new URLSearchParams(String(init?.body ?? "")).get(
            "token",
          )!;
          return new Response(null, { status: 200 });
        }
        return null;
      });

      await auth.logout();

      expect(revokedToken).toBe("refresh-preferred");
    });
  });

  describe("fetch retry", () => {
    const API_URL = "https://api.test/resource";

    beforeEach(() => {
      loadAuthSession(auth, seedAuthSession(localStorageMock.storage));
    });

    it("passes through successful authorized responses", async () => {
      restoreFetchRouter = installFetchRouter((url) => {
        if (url === API_URL) {
          return new Response("ok", { status: 200 });
        }
        return null;
      });

      const response = await auth.fetch(API_URL);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok");
    });

    it("recovers from 401 by refreshing and retrying once", async () => {
      let refreshCount = 0;
      let apiAttempts = 0;

      restoreTokenFetch();
      restoreTokenFetch = installGoogleTokenFetchMock({
        onRefresh: () => {
          refreshCount += 1;
        },
      });
      restoreFetchRouter = installFetchRouter((url) => {
        if (url === API_URL) {
          apiAttempts += 1;
          if (apiAttempts === 1) {
            return new Response("unauthorized", { status: 401 });
          }
          return new Response("ok", { status: 200 });
        }
        return null;
      });

      const response = await auth.fetch(API_URL);

      expect(refreshCount).toBe(1);
      expect(apiAttempts).toBe(2);
      expect(response.status).toBe(200);
    });

    it("redirects to authenticate when 401 recovery fails", async () => {
      const { location } = installLocationMock();
      restoreTokenFetch();
      restoreTokenFetch = installGoogleTokenFetchMock({ refreshFails: true });
      restoreFetchRouter = installFetchRouter((url) => {
        if (url === API_URL) {
          return new Response("unauthorized", { status: 401 });
        }
        return null;
      });

      await expect(auth.fetch(API_URL)).rejects.toThrow(
        "Session invalidated mid-request. Redirecting to authenticate...",
      );
      expect(location.href).toContain("accounts.google.com/o/oauth2/v2/auth");
    });

    it("triggers re-consent for insufficientPermissions 403 responses", async () => {
      const { location } = installLocationMock();
      restoreFetchRouter = installFetchRouter((url) => {
        if (url === API_URL) {
          return new Response(
            JSON.stringify({
              error: {
                errors: [{ reason: "insufficientPermissions" }],
              },
            }),
            { status: 403 },
          );
        }
        return null;
      });

      await expect(auth.fetch(API_URL)).rejects.toThrow(
        "Insufficient OAuth permissions. Triggering re-consent...",
      );
      expect(location.href).toContain("accounts.google.com/o/oauth2/v2/auth");
      expect(localStorageMock.storage.has(AUTH_SESSION_KEY)).toBe(false);
    });

    it("recovers from generic 403 responses by refreshing and retrying once", async () => {
      let refreshCount = 0;
      let apiAttempts = 0;

      restoreTokenFetch();
      restoreTokenFetch = installGoogleTokenFetchMock({
        onRefresh: () => {
          refreshCount += 1;
        },
      });
      restoreFetchRouter = installFetchRouter((url) => {
        if (url === API_URL) {
          apiAttempts += 1;
          if (apiAttempts === 1) {
            return new Response("forbidden", { status: 403 });
          }
          return new Response("ok", { status: 200 });
        }
        return null;
      });

      const response = await auth.fetch(API_URL);

      expect(refreshCount).toBe(1);
      expect(apiAttempts).toBe(2);
      expect(response.status).toBe(200);
    });

    it("retries userRateLimitExceeded 403 responses with backoff", async () => {
      let apiAttempts = 0;
      restoreFetchRouter = installFetchRouter((url) => {
        if (url === API_URL) {
          apiAttempts += 1;
          if (apiAttempts === 1) {
            return new Response(
              JSON.stringify({
                error: {
                  errors: [{ reason: "userRateLimitExceeded" }],
                },
              }),
              { status: 403 },
            );
          }
          return new Response("ok", { status: 200 });
        }
        return null;
      });

      const response = await auth.fetch(API_URL);

      expect(apiAttempts).toBe(2);
      expect(response.status).toBe(200);
    });

    it("retries rate-limited 403 responses with backoff", async () => {
      let apiAttempts = 0;
      restoreFetchRouter = installFetchRouter((url) => {
        if (url === API_URL) {
          apiAttempts += 1;
          if (apiAttempts === 1) {
            return new Response(
              JSON.stringify({
                error: {
                  errors: [{ reason: "rateLimitExceeded" }],
                },
              }),
              { status: 403 },
            );
          }
          return new Response("ok", { status: 200 });
        }
        return null;
      });

      const response = await auth.fetch(API_URL);

      expect(apiAttempts).toBe(2);
      expect(response.status).toBe(200);
    });

    it("retries transient 5xx responses", async () => {
      let apiAttempts = 0;
      restoreFetchRouter = installFetchRouter((url) => {
        if (url === API_URL) {
          apiAttempts += 1;
          if (apiAttempts === 1) {
            return new Response("server error", { status: 503 });
          }
          return new Response("ok", { status: 200 });
        }
        return null;
      });

      const response = await auth.fetch(API_URL);

      expect(apiAttempts).toBe(2);
      expect(response.status).toBe(200);
    });

    it("throws when unauthenticated fetch cannot obtain a token", async () => {
      resetTestAuthState(auth);

      await expect(auth.fetch(API_URL)).rejects.toThrow(
        /Redirecting for re-authentication/i,
      );
    });

    it("refreshes expired access token before the first authorized request", async () => {
      let refreshCount = 0;
      restoreTokenFetch();
      restoreTokenFetch = installGoogleTokenFetchMock({
        onRefresh: () => {
          refreshCount += 1;
        },
      });
      loadAuthSession(
        auth,
        seedAuthSession(localStorageMock.storage, {
          access_token: "expired-access",
          expiresAt: Date.now() - 1000,
        }),
      );
      restoreFetchRouter = installFetchRouter((url) => {
        if (url === API_URL) {
          return new Response("ok", { status: 200 });
        }
        return null;
      });

      const response = await auth.fetch(API_URL);

      expect(refreshCount).toBe(1);
      expect(response.status).toBe(200);
    });

    it("returns rate-limited 403 when retry budget is exhausted", async () => {
      restoreFetchRouter = installFetchRouter((url) => {
        if (url === API_URL) {
          return new Response(
            JSON.stringify({
              error: {
                errors: [{ reason: "rateLimitExceeded" }],
              },
            }),
            { status: 403 },
          );
        }
        return null;
      });

      const response = await auth.fetch(API_URL);

      expect(response.status).toBe(403);
    });

    it("redirects when fetch starts with expired session and refresh fails", async () => {
      const { location } = installLocationMock();
      restoreTokenFetch();
      restoreTokenFetch = installGoogleTokenFetchMock({ refreshFails: true });
      loadAuthSession(
        auth,
        seedAuthSession(localStorageMock.storage, {
          access_token: "expired-access",
          expiresAt: Date.now() - 1000,
        }),
      );
      restoreFetchRouter = installFetchRouter((url) => {
        if (url === API_URL) {
          return new Response("ok", { status: 200 });
        }
        return null;
      });

      await expect(auth.fetch(API_URL)).rejects.toThrow(
        /Redirecting for re-authentication/i,
      );
      expect(location.href).toContain("accounts.google.com/o/oauth2/v2/auth");
    });

    it(
      "returns server error response when 5xx retry budget is exhausted",
      async () => {
        restoreFetchRouter = installFetchRouter((url) => {
          if (url === API_URL) {
            return new Response("server error", { status: 503 });
          }
          return null;
        });

        const response = await auth.fetch(API_URL);

        expect(response.status).toBe(503);
      },
      { timeout: 10_000 },
    );
  });

  describe("session loading", () => {
    it("ignores malformed persisted session JSON", async () => {
      localStorageMock.storage.set(AUTH_SESSION_KEY, "{not-json");
      const freshAuth = createTestAuthInstance();
      await expect(freshAuth.isAuthenticated()).resolves.toBe(false);
    });

    it("retains refresh token when token exchange omits it", async () => {
      const { location } = installLocationMock();
      resetTestAuthState(auth);
      loadAuthSession(
        auth,
        seedAuthSession(localStorageMock.storage, {
          access_token: "old-access",
          refresh_token: "existing-refresh",
          expiresAt: Date.now() + 3600_000,
        }),
      );

      restoreTokenFetch();
      restoreTokenFetch = installGoogleTokenFetchMock({
        omitRefreshTokenOnExchange: true,
      });

      setupOAuthCallback(location, {
        stateToken: "csrf-state-token",
        verifier: "test-verifier",
      });

      await auth.authenticate();

      const stored = JSON.parse(localStorageMock.storage.get(AUTH_SESSION_KEY)!);
      expect(stored.refresh_token).toBe("existing-refresh");
    });
  });

  describe("singleton", () => {
    it("allows only one auth singleton per page", () => {
      expect(() =>
        getGoogleAuthSingleton({
          googleApiClientId: "other-client",
          googleOAuthTokenScopes: DRIVE_APPDATA_SCOPE,
        }),
      ).toThrow(/one google-auth singleton per html page/i);
    });
  });
});
