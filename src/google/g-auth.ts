export interface GoogleAuthConfig {
  googleApiClientId: string;
  googleOAuthTokenScopes: string | string[];
  redirectUri?: string;
}

export interface AuthSession {
  access_token: string;
  refresh_token: string;
  expiresAt: number; // Unix timestamp in milliseconds
  id_token?: string;
  scope?: string;
}

interface StoredState {
  stateToken: string;
}

export class GoogleAuth {
  private readonly clientId: string;
  private readonly scopes: string;
  private readonly redirectUri: string;

  private readonly AUTH_SESSION_KEY = "google_auth_session";
  private readonly VERIFIER_KEY = "pkce_code_verifier";
  private readonly STATE_KEY = "google_auth_csrf_state";

  private session: AuthSession | null = null;

  constructor(config: GoogleAuthConfig) {
    this.clientId = config.googleApiClientId;

    // Support string array or single space-separated string for scopes
    this.scopes = Array.isArray(config.googleOAuthTokenScopes)
      ? config.googleOAuthTokenScopes.join(" ")
      : config.googleOAuthTokenScopes;

    this.redirectUri =
      config.redirectUri || window.location.origin + window.location.pathname;

    // Load persisted session on instance creation
    this.loadSession();
  }

  getConfiguredScopes(): string {
    return this.scopes;
  }

  /**
   * Checks whether the user is currently authenticated with a valid session.
   *
   * @param checkRemote - If true, performs a lightweight network call to Google's
   *                      `tokeninfo` endpoint to verify the token hasn't been revoked server-side.
   *                      If false (default), performs a local state and expiration check.
   */
  public async isAuthenticated(checkRemote = false): Promise<boolean> {
    // 1. Basic local state check
    if (!this.session || !this.session.access_token) {
      return false;
    }

    // 2. Local token expiration check
    if (this.isTokenExpired(this.session)) {
      // If expired locally but we have a refresh token, try a silent refresh first
      if (this.session.refresh_token) {
        try {
          await this.refreshAccessToken();
        } catch {
          return false;
        }
      } else {
        return false;
      }
    }

    // 3. Optional remote verification against Google's tokeninfo endpoint
    if (checkRemote) {
      try {
        const response = await fetch(
          `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(
            this.session.access_token,
          )}`,
        );

        if (!response.ok) {
          // Token was revoked or invalidated on Google's servers
          return false;
        }

        const info = await response.json();

        // Optional check: Ensure token was issued for this specific client ID
        if (info.aud && info.aud !== this.clientId) {
          console.warn(
            "Token audience mismatch detected in isAuthenticated check.",
          );
          return false;
        }

        return true;
      } catch {
        // Network failure or fetch error during verification
        return false;
      }
    }

    return true;
  }

  /**
   * Primary Auth Entry Point.
   * Handles both:
   * 1. Callback processing (if URL contains OAuth query params ?code=...).
   * 2. Triggering interactive Google authentication redirect if unauthenticated.
   */
  public async authenticate(): Promise<AuthSession | void> {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get("code");
    const returnedState = urlParams.get("state");
    const error = urlParams.get("error");

    if (error) {
      this.clearSession();
      throw new Error(`Google OAuth Error: ${error}`);
    }

    // Phase A: Processing return from Google OAuth redirect
    if (code) {
      if (!returnedState) {
        this.clearSession();
        throw new Error(
          "CSRF Warning: Missing state parameter in callback URL.",
        );
      }

      // 1. Retrieve and clear state parameter from session storage
      const savedStateRaw = sessionStorage.getItem(this.STATE_KEY);
      sessionStorage.removeItem(this.STATE_KEY);

      if (!savedStateRaw) {
        this.clearSession();
        throw new Error(
          "CSRF Warning: No state session found. Request expired or unauthorized.",
        );
      }

      let parsedState: StoredState;
      try {
        parsedState = JSON.parse(savedStateRaw) as StoredState;
      } catch {
        this.clearSession();
        throw new Error("CSRF Warning: Malformed local state storage.");
      }

      // 2. Validate state token equality
      if (returnedState !== parsedState.stateToken) {
        this.clearSession();
        throw new Error("CSRF Warning: State mismatch detected.");
      }

      // 3. Exchange OAuth code for tokens
      const rawTokens = await this.exchangeCodeForTokens(code);
      this.saveSession(rawTokens);

      // Clean ?code=...&state=... parameters from address bar without page refresh
      const cleanUrl = window.location.origin + window.location.pathname;
      window.history.replaceState({}, document.title, cleanUrl);

      return this.session!;
    }

    // Phase B: Checking current session state
    if (
      this.session &&
      !this.isTokenExpired(this.session) &&
      (await this.isAuthenticated(true))
    ) {
      return this.session;
    }

    // Try silent renewal if token is expired but refresh_token exists
    if (this.session?.refresh_token) {
      try {
        await this.refreshAccessToken();
        return this.session!;
      } catch (err) {
        console.warn(
          "Silent refresh failed. Proceeding to interactive authentication.",
          err,
        );
      }
    }

    // Phase C: Initiating full interactive Google authentication redirect
    await this.redirectToGoogle();
  }

  /**
   * Authorized fetch wrapper with mid-call 401/403 recovery and 500-series retry logic.
   */
  public async fetch(
    input: RequestInfo | URL,
    init: RequestInit = {},
    retryCount = 0,
  ): Promise<Response> {
    const maxRetries = 2;
    let token = await this.getValidAccessToken();

    const headers = new Headers(init.headers || {});
    headers.set("Authorization", `Bearer ${token}`);

    const response = await fetch(input, { ...init, headers });

    // 1. Handle 401 (Unauthorized) OR 403 (Auth Error / Token issues)
    if (
      (response.status === 401 || response.status === 403) &&
      retryCount < 1
    ) {
      // Clone response to read body without consuming the main stream
      const errorBody = await response
        .clone()
        .text()
        .catch(() => "");

      // If 403 is due to missing OAuth scopes/permissions, do NOT loop silently; prompt authenticate or surface error
      if (
        response.status === 403 &&
        errorBody.includes("insufficientPermissions")
      ) {
        console.warn(
          "403 Insufficient Scopes: User permissions are missing for this resource.",
        );
        this.clearSession();
        await this.authenticate();
        throw new Error(
          "Insufficient OAuth permissions. Triggering re-consent...",
        );
      }

      // Handle Rate-Limit / Quota 403s with exponential backoff retry
      if (
        response.status === 403 &&
        (errorBody.includes("rateLimitExceeded") ||
          errorBody.includes("userRateLimitExceeded"))
      ) {
        const delay = Math.pow(2, retryCount + 1) * 1000;
        console.warn(`Google Rate Limit 403. Retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.fetch(input, init, retryCount + 1);
      }

      // Default 401 / generic 403 token recovery flow
      console.warn(
        `Received ${response.status} from Google. Attempting silent token recovery...`,
      );
      if (this.session?.refresh_token) {
        try {
          await this.refreshAccessToken();
          return this.fetch(input, init, retryCount + 1);
        } catch (err) {
          console.warn(
            "Refresh token failed. Prompting interactive authentication.",
          );
        }
      }

      await this.authenticate();
      throw new Error(
        "Session invalidated mid-request. Redirecting to authenticate...",
      );
    }

    // 2. Handle Transient Google Server Errors (500, 502, 503, 504)
    if (
      response.status >= 500 &&
      response.status < 600 &&
      retryCount < maxRetries
    ) {
      const delay = Math.pow(2, retryCount + 1) * 1000;
      console.warn(
        `Google server error (${response.status}). Retrying in ${delay}ms...`,
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
      return this.fetch(input, init, retryCount + 1);
    }

    return response;
  }

  /**
   * Log out the user.
   * Revokes the access token (and associated refresh token) on Google's servers
   * and clears all local storage state.
   */
  public async logout(): Promise<void> {
    const tokenToRevoke =
      this.session?.refresh_token || this.session?.access_token;

    if (tokenToRevoke) {
      try {
        // Google's OAuth 2.0 Revocation Endpoint
        await fetch("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ token: tokenToRevoke }),
        });
      } catch (error) {
        // Log network error, but ensure local cleanup completes regardless
        console.warn(
          "Network error while revoking token on Google servers:",
          error,
        );
      }
    }

    // Clear local and session storage memory
    this.clearSession();
  }

  // =========================================================================
  // INTERNAL / ENCAPSULATED PRIVATE METHODS
  // =========================================================================

  private async getValidAccessToken(): Promise<string> {
    // 1. If active session is valid, return token immediately
    if (this.session && !this.isTokenExpired(this.session)) {
      return this.session.access_token;
    }

    // 2. Attempt silent token refresh via stored refresh token
    if (this.session?.refresh_token) {
      try {
        return await this.refreshAccessToken();
      } catch (err) {
        console.warn(
          "Silent refresh failed during fetch. Triggering interactive authentication.",
          err,
        );
      }
    }

    // 3. If silent renewal is impossible, trigger interactive authentication redirect
    await this.authenticate();
    throw new Error("Redirecting for re-authentication...");
  }

  private async refreshAccessToken(): Promise<string> {
    if (!this.session?.refresh_token) {
      throw new Error("No refresh token available.");
    }

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.clientId,
        grant_type: "refresh_token",
        refresh_token: this.session.refresh_token,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      this.clearSession();
      throw new Error(data.error_description || "Failed to refresh token.");
    }

    // Retain original refresh_token if Google doesn't send a new one in rotation
    const updatedSession: AuthSession = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || this.session.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
      id_token: data.id_token || this.session.id_token,
      scope: data.scope || this.session.scope,
    };

    this.saveSessionRaw(updatedSession);
    return updatedSession.access_token;
  }

  private async redirectToGoogle(): Promise<void> {
    const verifier = this.generateRandomString(64);
    const challenge = await this.generateCodeChallenge(verifier);
    const stateToken = this.generateRandomString(32);

    sessionStorage.setItem(this.VERIFIER_KEY, verifier);
    sessionStorage.setItem(this.STATE_KEY, JSON.stringify({ stateToken }));

    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", this.clientId);
    authUrl.searchParams.set("redirect_uri", this.redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", this.scopes);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", stateToken);
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent");

    window.location.href = authUrl.toString();
  }

  private async exchangeCodeForTokens(code: string): Promise<any> {
    const codeVerifier = sessionStorage.getItem(this.VERIFIER_KEY);

    if (!codeVerifier) {
      throw new Error("PKCE missing code_verifier in sessionStorage.");
    }

    sessionStorage.removeItem(this.VERIFIER_KEY);

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.clientId,
        grant_type: "authorization_code",
        code: code,
        redirect_uri: this.redirectUri,
        code_verifier: codeVerifier,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error_description || "Token exchange failed.");
    }

    return data;
  }

  private isTokenExpired(session: AuthSession): boolean {
    // 60-second safety buffer before true expiry
    return Date.now() >= session.expiresAt - 60000;
  }

  private saveSession(rawTokens: any): void {
    const session: AuthSession = {
      access_token: rawTokens.access_token,
      refresh_token:
        rawTokens.refresh_token || this.session?.refresh_token || "",
      expiresAt: Date.now() + rawTokens.expires_in * 1000,
      id_token: rawTokens.id_token,
      scope: rawTokens.scope,
    };

    this.saveSessionRaw(session);
  }

  private saveSessionRaw(session: AuthSession): void {
    this.session = session;
    localStorage.setItem(this.AUTH_SESSION_KEY, JSON.stringify(session));
  }

  private loadSession(): void {
    const raw = localStorage.getItem(this.AUTH_SESSION_KEY);
    if (raw) {
      try {
        this.session = JSON.parse(raw) as AuthSession;
      } catch {
        this.session = null;
      }
    }
  }

  private clearSession(): void {
    this.session = null;
    localStorage.removeItem(this.AUTH_SESSION_KEY);
    sessionStorage.removeItem(this.VERIFIER_KEY);
    sessionStorage.removeItem(this.STATE_KEY);
  }

  private generateRandomString(length = 64): string {
    const possible =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    const randomValues = new Uint8Array(length);
    window.crypto.getRandomValues(randomValues);
    return Array.from(randomValues)
      .map((x) => possible[x % possible.length])
      .join("");
  }

  private async generateCodeChallenge(verifier: string): Promise<string> {
    const data = new TextEncoder().encode(verifier);
    const digest = await window.crypto.subtle.digest("SHA-256", data);
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
  }
}

export const getGoogleAuthSingleton = (function () {
  let googleAuthSingleton: GoogleAuth;

  return function (config: GoogleAuthConfig) {
    if (googleAuthSingleton)
      throw new Error(
        `Tried to instantiate a new google-auth instance. One google-auth singleton per html page is sufficient.`,
      );
    googleAuthSingleton = new GoogleAuth(config);
    return googleAuthSingleton;
  };
})();
