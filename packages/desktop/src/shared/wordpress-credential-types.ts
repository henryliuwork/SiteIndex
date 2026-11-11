export interface WordPressCredentialInput {
  siteUrl: string;
  username: string;
  applicationPassword: string;
}

export interface WordPressCredential {
  username: string;
  applicationPassword: string;
}

export type WordPressCredentialStatus =
  { state: "configured" } | { state: "not_configured" } | { state: "needs_reentry" } | { state: "unavailable" };
