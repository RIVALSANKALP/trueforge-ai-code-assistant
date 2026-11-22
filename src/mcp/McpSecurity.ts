import * as crypto from 'crypto';

/**
 * Security and authentication utility for the local loopback MCP bridge.
 * Enforces per-instance cryptographic isolation, constant-time bearer token
 * verification, loopback host validation, and token redaction in logs.
 */
export class McpSecurity {
  public static readonly DEFAULT_MCP_PORT = 8799;
  public static readonly MIN_PORT = 1;
  public static readonly MAX_PORT = 65535;

  /**
   * Validates an MCP port number.
   * Returns defaultPort (8799) if value is missing, not an integer, or outside [1, 65535]
   * (or [0, 65535] if allowZero is true).
   */
  public static validatePort(value: unknown, defaultPort = McpSecurity.DEFAULT_MCP_PORT, allowZero = true): number {
    if (typeof value === 'number' && Number.isInteger(value)) {
      if (allowZero && value === 0) {
        return 0;
      }
      if (value >= McpSecurity.MIN_PORT && value <= McpSecurity.MAX_PORT) {
        return value;
      }
    }
    return defaultPort;
  }

  /**
   * Generates a high-entropy per-instance identifier.
   * Minted as 16 cryptographically random bytes (32 hex characters).
   */
  public static generateInstanceId(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  /**
   * Generates an ephemeral cryptographic bearer authentication token.
   * Minted as 32 cryptographically random bytes (64 hex characters).
   */
  public static generateAuthToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Verifies the Authorization header using constant-time comparison.
   * Rejects missing, malformed, or mismatching bearer tokens.
   */
  public static verifyAuthToken(authHeader: string | undefined, expectedToken: string): boolean {
    if (!authHeader || typeof authHeader !== 'string') {
      return false;
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      return false;
    }

    const presentedToken = parts[1].trim();
    const presentedBuf = Buffer.from(presentedToken, 'utf-8');
    const expectedBuf = Buffer.from(expectedToken, 'utf-8');

    if (presentedBuf.length !== expectedBuf.length) {
      return false;
    }

    return crypto.timingSafeEqual(presentedBuf, expectedBuf);
  }

  /**
   * Validates that the Host header matches the expected loopback interface and port.
   * Protects against DNS rebinding and cross-origin header manipulation.
   */
  public static validateHostHeader(hostHeader: string | undefined, port: number): boolean {
    if (!hostHeader) {
      return false;
    }

    const normalized = hostHeader.toLowerCase().trim();
    const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
    return allowed.includes(normalized);
  }

  /**
   * Masks any sensitive bearer tokens in logs or diagnostic strings.
   */
  public static maskToken(input: string, token?: string): string {
    if (!input) {
      return '';
    }

    let sanitized = input;
    if (token && token.length > 0) {
      sanitized = sanitized.split(token).join('[REDACTED_AUTH_TOKEN]');
    }

    // Mask any Bearer tokens matching 32+ hex or alphanumeric patterns
    sanitized = sanitized.replace(/Bearer\s+([A-Fa-f0-9]{32,}|[A-Za-z0-9_\-]{32,})/g, 'Bearer [REDACTED_AUTH_TOKEN]');
    return sanitized;
  }
}
