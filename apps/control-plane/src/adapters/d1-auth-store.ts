import type {
  AppUser,
  AuthStore,
  ExternalIdentity,
  IntegrationInstallation,
  OAuthFlow
} from "@incidentpilot/domain";

interface UserRow {
  id: string;
  identity_provider: "github";
  external_user_id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

interface OAuthFlowRow {
  state_hash: string;
  browser_binding_hash: string;
  purpose: OAuthFlow["purpose"];
  user_id: string | null;
  created_at: string;
  expires_at: string;
}

interface InstallationRow {
  external_id: string;
  account_external_id: string;
  account_login: string;
  account_type: string;
  repository_selection: string;
  permissions_json: string;
  suspended_at: string | null;
}

function mapUser(row: UserRow): AppUser {
  return {
    id: row.id,
    identityProvider: row.identity_provider,
    externalUserId: row.external_user_id,
    username: row.username,
    ...(row.display_name ? { displayName: row.display_name } : {}),
    ...(row.avatar_url ? { avatarUrl: row.avatar_url } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapOAuthFlow(row: OAuthFlowRow): OAuthFlow {
  return {
    stateHash: row.state_hash,
    browserBindingHash: row.browser_binding_hash,
    purpose: row.purpose,
    ...(row.user_id ? { userId: row.user_id } : {}),
    createdAt: row.created_at,
    expiresAt: row.expires_at
  };
}

function parsePermissions(json: string): Record<string, string> {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string"
      )
    );
  } catch {
    return {};
  }
}

export class D1AuthStore implements AuthStore {
  constructor(private readonly db: D1Database) {}

  async upsertUser(identity: ExternalIdentity): Promise<AppUser> {
    const now = new Date().toISOString();
    const candidateId = crypto.randomUUID();

    await this.db.prepare(`
      INSERT INTO users (
        id, identity_provider, external_user_id, username,
        display_name, avatar_url, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(identity_provider, external_user_id) DO UPDATE SET
        username = excluded.username,
        display_name = excluded.display_name,
        avatar_url = excluded.avatar_url,
        updated_at = excluded.updated_at
    `).bind(
      candidateId,
      identity.provider,
      identity.externalUserId,
      identity.username,
      identity.displayName ?? null,
      identity.avatarUrl ?? null,
      now,
      now
    ).run();

    const row = await this.db.prepare(`
      SELECT id, identity_provider, external_user_id, username,
             display_name, avatar_url, created_at, updated_at
      FROM users
      WHERE identity_provider = ? AND external_user_id = ?
    `).bind(identity.provider, identity.externalUserId).first<UserRow>();

    if (!row) throw new Error("User upsert/read invariant failed");
    return mapUser(row);
  }

  async getUserById(id: string): Promise<AppUser | null> {
    const row = await this.db.prepare(`
      SELECT id, identity_provider, external_user_id, username,
             display_name, avatar_url, created_at, updated_at
      FROM users WHERE id = ?
    `).bind(id).first<UserRow>();

    return row ? mapUser(row) : null;
  }

  async createSession(input: {
    id: string;
    tokenHash: string;
    userId: string;
    createdAt: string;
    expiresAt: string;
  }): Promise<void> {
    await this.db.prepare(`
      INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      input.id,
      input.tokenHash,
      input.userId,
      input.createdAt,
      input.expiresAt
    ).run();
  }

  async getUserBySessionTokenHash(tokenHash: string, now: string): Promise<AppUser | null> {
    const row = await this.db.prepare(`
      SELECT u.id, u.identity_provider, u.external_user_id, u.username,
             u.display_name, u.avatar_url, u.created_at, u.updated_at
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?
    `).bind(tokenHash, now).first<UserRow>();

    return row ? mapUser(row) : null;
  }

  async revokeSession(tokenHash: string): Promise<void> {
    await this.db.prepare("DELETE FROM sessions WHERE token_hash = ?")
      .bind(tokenHash)
      .run();
  }


  async createOAuthFlowWithinCapacity(
    flow: OAuthFlow,
    now: string,
    maxActive = 500,
    cleanupBatch = 25
  ): Promise<boolean> {
    // Cleanup is bounded and index-supported. The capacity check and insert are
    // a single SQL statement so concurrent requests cannot all observe the same
    // spare slot and exceed the configured cap.
    await this.db.prepare(`
      DELETE FROM oauth_flows
      WHERE state_hash IN (
        SELECT state_hash FROM oauth_flows
        WHERE consumed_at IS NOT NULL OR expires_at <= ?
        ORDER BY expires_at ASC
        LIMIT ?
      )
    `).bind(now, cleanupBatch).run();

    const inserted = await this.db.prepare(`
      INSERT INTO oauth_flows (
        state_hash, browser_binding_hash, purpose, user_id, created_at, expires_at, consumed_at
      )
      SELECT ?, ?, ?, ?, ?, ?, NULL
      WHERE (
        SELECT COUNT(*)
        FROM oauth_flows
        WHERE consumed_at IS NULL AND expires_at > ?
      ) < ?
      RETURNING state_hash
    `).bind(
      flow.stateHash,
      flow.browserBindingHash,
      flow.purpose,
      flow.userId ?? null,
      flow.createdAt,
      flow.expiresAt,
      now,
      maxActive
    ).first<{ state_hash: string }>();

    return inserted?.state_hash === flow.stateHash;
  }

  async createOAuthFlow(flow: OAuthFlow): Promise<void> {
    await this.db.prepare(`
      INSERT INTO oauth_flows (
        state_hash, browser_binding_hash, purpose, user_id, created_at, expires_at, consumed_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL)
    `).bind(
      flow.stateHash,
      flow.browserBindingHash,
      flow.purpose,
      flow.userId ?? null,
      flow.createdAt,
      flow.expiresAt
    ).run();
  }

  async consumeOAuthFlow(
    stateHash: string,
    browserBindingHash: string,
    now: string
  ): Promise<OAuthFlow | null> {
    // UPDATE ... RETURNING makes consumption and retrieval one atomic statement.
    // A concurrent bounded cleanup cannot delete the row between those phases.
    const row = await this.db.prepare(`
      UPDATE oauth_flows
      SET consumed_at = ?
      WHERE state_hash = ?
        AND browser_binding_hash = ?
        AND consumed_at IS NULL
        AND expires_at > ?
      RETURNING state_hash, browser_binding_hash, purpose, user_id, created_at, expires_at
    `).bind(now, stateHash, browserBindingHash, now).first<OAuthFlowRow>();

    return row ? mapOAuthFlow(row) : null;
  }

  async beginInstallationRefresh(userId: string, now = new Date().toISOString()): Promise<number> {
    await this.db.prepare(`
      INSERT INTO github_installation_sync_state (user_id, generation, updated_at)
      VALUES (?, 0, ?)
      ON CONFLICT(user_id) DO NOTHING
    `).bind(userId, now).run();

    const result = await this.db.prepare(`
      UPDATE github_installation_sync_state
      SET generation = generation + 1, updated_at = ?
      WHERE user_id = ?
      RETURNING generation
    `).bind(now, userId).first<{ generation: number }>();
    if (!result) throw new Error("Installation refresh generation invariant failed");
    return Number(result.generation);
  }

  async replaceUserInstallations(
    userId: string,
    installations: IntegrationInstallation[],
    now: string,
    generation?: number
  ): Promise<void> {
    const syncGeneration = generation ?? await this.beginInstallationRefresh(userId, now);
    const statements: D1PreparedStatement[] = [];

    for (const installation of installations) {
      statements.push(
        this.db.prepare(`
          INSERT INTO github_installations (
            external_id, account_external_id, account_login, account_type,
            repository_selection, permissions_json, suspended_at, updated_at
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?
          WHERE (SELECT generation FROM github_installation_sync_state WHERE user_id = ?) = ?
          ON CONFLICT(external_id) DO UPDATE SET
            account_external_id = excluded.account_external_id,
            account_login = excluded.account_login,
            account_type = excluded.account_type,
            repository_selection = excluded.repository_selection,
            permissions_json = excluded.permissions_json,
            suspended_at = excluded.suspended_at,
            updated_at = excluded.updated_at
        `).bind(
          installation.externalInstallationId, installation.accountExternalId, installation.accountLogin,
          installation.accountType, installation.repositorySelection, JSON.stringify(installation.permissions),
          installation.suspendedAt ?? null, now, userId, syncGeneration
        )
      );

      statements.push(
        this.db.prepare(`
          INSERT INTO user_github_installations (
            user_id, installation_external_id, first_seen_at, last_seen_at, sync_generation
          )
          SELECT ?, ?, ?, ?, ?
          WHERE (SELECT generation FROM github_installation_sync_state WHERE user_id = ?) = ?
          ON CONFLICT(user_id, installation_external_id) DO UPDATE SET
            last_seen_at = CASE
              WHEN excluded.sync_generation >= user_github_installations.sync_generation
                THEN excluded.last_seen_at ELSE user_github_installations.last_seen_at END,
            sync_generation = MAX(user_github_installations.sync_generation, excluded.sync_generation)
        `).bind(userId, installation.externalInstallationId, now, now, syncGeneration, userId, syncGeneration)
      );
    }

    for (let index = 0; index < statements.length; index += 100) {
      await this.db.batch(statements.slice(index, index + 100));
    }

    // Cleanup only if this generation is still the newest refresh. A stale
    // request therefore cannot delete associations produced by a newer one.
    await this.db.prepare(`
      DELETE FROM user_github_installations
      WHERE user_id = ?
        AND sync_generation < ?
        AND (SELECT generation FROM github_installation_sync_state WHERE user_id = ?) = ?
    `).bind(userId, syncGeneration, userId, syncGeneration).run();
  }

  async listUserInstallations(userId: string): Promise<IntegrationInstallation[]> {
    const result = await this.db.prepare(`
      SELECT gi.external_id, gi.account_external_id, gi.account_login,
             gi.account_type, gi.repository_selection, gi.permissions_json,
             gi.suspended_at
      FROM user_github_installations ugi
      JOIN github_installations gi
        ON gi.external_id = ugi.installation_external_id
      WHERE ugi.user_id = ?
      ORDER BY gi.account_login COLLATE NOCASE
    `).bind(userId).all<InstallationRow>();

    return result.results.map((row) => ({
      provider: "github" as const,
      externalInstallationId: row.external_id,
      accountExternalId: row.account_external_id,
      accountLogin: row.account_login,
      accountType: row.account_type,
      repositorySelection: row.repository_selection,
      permissions: parsePermissions(row.permissions_json),
      ...(row.suspended_at ? { suspendedAt: row.suspended_at } : {})
    }));
  }
}
