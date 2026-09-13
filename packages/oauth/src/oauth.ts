/// <reference path="./gis.d.ts" />

import { GisAuth, type GoogleOAuthConfig } from "./gis-auth";

export type GoogleOAuth = ReturnType<typeof getOAuthSingleton>;

export const getOAuthSingleton = (function () {
  let oauthSingleton: GisAuth;

  return function (config: GoogleOAuthConfig) {
    if (oauthSingleton)
      throw new Error(
        `Tried to instantiate a new oauth instance. One oauth singleton per html page is sufficient.`,
      );
    oauthSingleton = new GisAuth(config);
    return oauthSingleton;
  };
})();
