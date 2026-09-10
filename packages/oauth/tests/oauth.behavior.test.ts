import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { NotAuthenticatedError, getOAuthSingleton } from "../src/index.ts";
import {
  clearGoogleOAuthMock,
  installGoogleOAuthMock,
} from "./mocks/google.ts";
import {
  DRIVE_APPDATA_SCOPE,
  TOKEN_KEY,
  getTestOAuth,
  installLocalStorageMock,
  type GoogleOAuth,
} from "./mocks/oauth-harness.ts";

describe("GoogleOAuth", () => {
  let localStorageMock: { storage: Map<string, string> };
  let oauth: GoogleOAuth;

  beforeEach(() => {
    localStorageMock = installLocalStorageMock();
    installGoogleOAuthMock();
    oauth = getTestOAuth();
  });

  afterEach(() => {
    clearGoogleOAuthMock();
  });

  it("silently renews expired tokens on authenticate via GIS", async () => {
    let silentRequestCount = 0;
    clearGoogleOAuthMock();
    installGoogleOAuthMock({
      onTokenRequest: (config) => {
        if (config?.prompt === "") silentRequestCount += 1;
      },
    });

    localStorageMock.storage.set(
      TOKEN_KEY,
      JSON.stringify({
        accessToken: "expired-access",
        expiresAt: Date.now() - 1000,
      }),
    );

    await oauth.authenticate();

    expect(silentRequestCount).toBeGreaterThan(0);
  });

  it("authenticate rejects when silent and login both fail", async () => {
    clearGoogleOAuthMock();
    installGoogleOAuthMock({ silentFails: true, loginFails: true });

    await expect(oauth.authenticate()).rejects.toBeInstanceOf(
      NotAuthenticatedError,
    );
  });

  it("authenticate uses token client with configured scopes", async () => {
    let capturedScope = "";
    clearGoogleOAuthMock();
    installGoogleOAuthMock({
      onTokenInit: (config) => {
        capturedScope = config.scope;
      },
    });

    await oauth.authenticate();

    expect(capturedScope).toBe(DRIVE_APPDATA_SCOPE);
  });

  it("allows only one oauth singleton per page", () => {
    expect(() =>
      getOAuthSingleton({
        googleApiClientId: "other-client",
        googleOAuthTokenScopes: [DRIVE_APPDATA_SCOPE],
      }),
    ).toThrow(/one oauth singleton per html page/i);
  });

  it("persists tokens to localStorage after authenticate", async () => {
    await oauth.authenticate();

    const raw = localStorageMock.storage.get(TOKEN_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).accessToken).toBe("test-access-token");
  });
});
