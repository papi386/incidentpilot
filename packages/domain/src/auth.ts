export type OAuthFlowPurpose = "LOGIN" | "INSTALL";

export interface ExternalIdentity {
  provider: "github";
  externalUserId: string;
  username: string;
  displayName?: string;
  avatarUrl?: string;
}

export interface AppUser {
  id: string;
  identityProvider: "github";
  externalUserId: string;
  username: string;
  displayName?: string;
  avatarUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OAuthFlow {
  stateHash: string;
  browserBindingHash: string;
  purpose: OAuthFlowPurpose;
  userId?: string;
  createdAt: string;
  expiresAt: string;
}

export interface IntegrationInstallation {
  provider: "github";
  externalInstallationId: string;
  accountExternalId: string;
  accountLogin: string;
  accountType: string;
  repositorySelection: string;
  permissions: Record<string, string>;
  suspendedAt?: string;
}

export interface IdentityAuthorizationResult {
  accessToken: string;
  identity: ExternalIdentity;
}

export interface IdentityProvider {
  authorizationUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<IdentityAuthorizationResult>;
  listInstallations(accessToken: string): Promise<IntegrationInstallation[]>;
}

export interface AuthStore {
  upsertUser(identity: ExternalIdentity): Promise<AppUser>;
  getUserById(id: string): Promise<AppUser | null>;

  createSession(input: {
    id: string;
    tokenHash: string;
    userId: string;
    createdAt: string;
    expiresAt: string;
  }): Promise<void>;
  getUserBySessionTokenHash(tokenHash: string, now: string): Promise<AppUser | null>;
  revokeSession(tokenHash: string): Promise<void>;

  createOAuthFlow(flow: OAuthFlow): Promise<void>;
  consumeOAuthFlow(
    stateHash: string,
    browserBindingHash: string,
    now: string
  ): Promise<OAuthFlow | null>;

  beginInstallationRefresh?(userId: string, now?: string): Promise<number>;
  replaceUserInstallations(
    userId: string,
    installations: IntegrationInstallation[],
    now: string,
    generation?: number
  ): Promise<void>;
  listUserInstallations(userId: string): Promise<IntegrationInstallation[]>;
}
