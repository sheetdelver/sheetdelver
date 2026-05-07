/**
 * Admin account record stored in <DATA_DIR>/security/admin-auth.json
 * Never expose credentials or hashes outside the credential store module.
 */
export interface AdminAccount {
  adminId: string; // Unique identifier for the admin, e.g., UUID
  passwordHash: string; // Argon2id hash of the password
  saltPacked?: string; // For future salting strategies; argon2 embeds salt in hash
  createdAt: number; // Unix timestamp
  updatedAt: number; // Unix timestamp
  passwordChangedAt: number; // Unix timestamp of last password change
  failedLoginCount: number; // Counter for lockout logic
  lockedUntil?: number; // Unix timestamp when lock expires, if set
}

/**
 * Credentials as presented by a client logging in.
 */
export interface AdminLoginRequest {
  password: string;
}

/**
 * Admin session token claims.
 */
export interface AdminSessionClaims {
  principalType: 'app-admin'; // Explicit principal type for admin routes
  adminId: string;
  issuedAt: number; // Unix timestamp
  expiresAt: number; // Unix timestamp
  csrfToken?: string; // Per-session CSRF token for browser-origin admin mutations
}
