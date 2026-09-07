import {
  getGoogleAuthSingleton,
  GoogleAuth,
  type AuthSession,
  type GoogleAuthConfig,
} from "../../src/google/g-auth.ts";

export type { GoogleAuth };

export const CLIENT_ID = "client-id";
export const DRIVE_APPDATA_SCOPE =
  "https://www.googleapis.com/auth/drive.appdata";
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const AUTH_SESSION_KEY = "google_auth_session";
export const PKCE_VERIFIER_KEY = "pkce_code_verifier";
export const CSRF_STATE_KEY = "google_auth_csrf_state";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

let authSingleton: GoogleAuth | null = null;

export function createMockAuth(scopes: string | string[]): GoogleAuth {
  const scopeStr = Array.isArray(scopes) ? scopes.join(" ") : scopes;
  return {
    getConfiguredScopes: () => scopeStr,
    authenticate: async () => {},
    isAuthenticated: async () => true,
    logout: async () => {},
    fetch: (url, init) => fetch(url, init),
  } as GoogleAuth;
}

export function createTestAuthInstance(
  overrides: Partial<GoogleAuthConfig> = {},
): GoogleAuth {
  return new GoogleAuth({
    googleApiClientId: CLIENT_ID,
    googleOAuthTokenScopes: DRIVE_APPDATA_SCOPE,
    ...overrides,
  });
}

export function seedAuthSession(
  storage: Map<string, string>,
  overrides: Partial<AuthSession> = {},
): AuthSession {
  const session: AuthSession = {
    access_token: "test-access-token",
    refresh_token: "test-refresh-token",
    expiresAt: Date.now() + 3600_000,
    ...overrides,
  };
  storage.set(AUTH_SESSION_KEY, JSON.stringify(session));
  return session;
}

export function loadAuthSession(auth: GoogleAuth, session: AuthSession): void {
  (
    auth as unknown as {
      session: AuthSession | null;
    }
  ).session = session;
}

export function getTestAuth(): GoogleAuth {
  if (!authSingleton) {
    authSingleton = getGoogleAuthSingleton({
      googleApiClientId: CLIENT_ID,
      googleOAuthTokenScopes: DRIVE_APPDATA_SCOPE,
    });
    return authSingleton;
  }

  resetTestAuthState(authSingleton);
  return authSingleton;
}

export function resetTestAuthState(auth: GoogleAuth): void {
  (
    auth as unknown as {
      session: AuthSession | null;
    }
  ).session = null;
  localStorage.removeItem(AUTH_SESSION_KEY);
  sessionStorage.removeItem(PKCE_VERIFIER_KEY);
  sessionStorage.removeItem(CSRF_STATE_KEY);
}

export function installLocalStorageMock(): { storage: Map<string, string> } {
  const storage = new Map<string, string>();
  const mock = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
    key: (_index: number) => null,
    length: 0,
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: mock,
    configurable: true,
  });
  return { storage };
}

export function installSessionStorageMock(): { storage: Map<string, string> } {
  const storage = new Map<string, string>();
  const mock = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
    key: (_index: number) => null,
    length: 0,
  };
  Object.defineProperty(globalThis, "sessionStorage", {
    value: mock,
    configurable: true,
  });
  return { storage };
}

export function installLocationMock(): {
  location: {
    href: string;
    origin: string;
    pathname: string;
    search: string;
  };
} {
  const location = {
    href: "http://localhost/",
    origin: "http://localhost",
    pathname: "/",
    search: "",
  };
  const history = {
    replaceState: (_state: unknown, _title: string, url?: string) => {
      if (!url) {
        location.search = "";
        location.href = location.origin + location.pathname;
        return;
      }

      const parsed = new URL(url, location.origin);
      location.href = parsed.href;
      location.pathname = parsed.pathname;
      location.search = parsed.search;
    },
  };
  Object.defineProperty(globalThis, "location", {
    value: location,
    configurable: true,
  });
  Object.defineProperty(globalThis, "window", {
    value: {
      location,
      crypto: globalThis.crypto,
      history,
    },
    configurable: true,
  });
  Object.defineProperty(globalThis, "history", {
    value: history,
    configurable: true,
  });
  Object.defineProperty(globalThis, "document", {
    value: { title: "test" },
    configurable: true,
  });
  return { location };
}

export function installFetchRouter(
  route: (
    url: string,
    init: RequestInit | undefined,
  ) => Response | Promise<Response> | null | undefined,
): () => void {
  const underlyingFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = (async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const routed = await route(url, init);
    if (routed !== null && routed !== undefined) {
      return routed;
    }
    return underlyingFetch(input, init);
  }) as typeof fetch;

  return () => {
    globalThis.fetch = underlyingFetch;
  };
}

export function installGoogleTokenFetchMock(options?: {
  onRefresh?: () => void;
  onTokenExchange?: (body: URLSearchParams) => void;
  refreshFails?: boolean;
  exchangeFails?: boolean;
  omitRefreshTokenOnExchange?: boolean;
  expiresIn?: number;
}): () => void {
  const underlyingFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = (async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    if (url.startsWith(GOOGLE_TOKEN_URL)) {
      const body = new URLSearchParams(String(init?.body ?? ""));
      const grantType = body.get("grant_type");

      if (grantType === "authorization_code") {
        options?.onTokenExchange?.(body);
      }

      if (grantType === "refresh_token") {
        options?.onRefresh?.();
      }

      if (options?.exchangeFails && grantType === "authorization_code") {
        return new Response(
          JSON.stringify({ error_description: "invalid_grant" }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      if (options?.refreshFails && grantType === "refresh_token") {
        return new Response(
          JSON.stringify({ error_description: "invalid_grant" }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      return new Response(
        JSON.stringify({
          access_token:
            grantType === "refresh_token"
              ? "refreshed-access-token"
              : "test-access-token",
          expires_in: options?.expiresIn ?? 3600,
          ...(grantType === "authorization_code" &&
          !options?.omitRefreshTokenOnExchange
            ? { refresh_token: "test-refresh-token" }
            : {}),
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    return underlyingFetch(input, init);
  }) as typeof fetch;

  return () => {
    globalThis.fetch = underlyingFetch;
  };
}

export function setupOAuthCallback(
  location: { search: string },
  options: {
    code?: string;
    stateToken: string;
    verifier?: string;
  },
): void {
  sessionStorage.setItem(
    CSRF_STATE_KEY,
    JSON.stringify({ stateToken: options.stateToken }),
  );
  if (options.verifier !== undefined) {
    sessionStorage.setItem(PKCE_VERIFIER_KEY, options.verifier);
  }
  const code = options.code ?? "auth-code";
  location.search = `?code=${code}&state=${options.stateToken}`;
}
