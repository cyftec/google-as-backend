import type { GoogleOAuth } from "@cyftec/google-oauth";

export const DRIVE_APPDATA_SCOPE =
  "https://www.googleapis.com/auth/drive.appdata";
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

export function createMockOAuth(scopes: readonly string[]): GoogleOAuth {
  const googleOAuthTokenScopes = scopes.join(" ");
  return {
    getConfiguredScopes: () => googleOAuthTokenScopes,
    authenticate: async () => {},
    authorizedFetch: (url, init) => fetch(url, init),
  } as GoogleOAuth;
}
