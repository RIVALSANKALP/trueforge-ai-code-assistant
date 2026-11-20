import { TrueForge } from '@truefoundry/trueforge-sdk';

export interface HealthCheckResult {
  ok: boolean;
  baseUrl: string;
  timestamp: string;
  capabilities?: unknown;
  error?: string;
  statusCode?: number;
}

export class HealthProbe {
  private readonly client: TrueForge;
  private readonly baseUrl: string;

  constructor(client: TrueForge, baseUrl: string) {
    this.client = client;
    this.baseUrl = baseUrl;
  }

  /**
   * Probes the TrueForge server capabilities endpoint (/api/v1/capabilities)
   * to determine connectivity and runtime health.
   */
  public async checkHealth(): Promise<HealthCheckResult> {
    const timestamp = new Date().toISOString();

    try {
      const response = await this.client.server.getCapabilities();
      return {
        ok: true,
        baseUrl: this.baseUrl,
        timestamp,
        capabilities: response.data
      };
    } catch (err: unknown) {
      let errorMessage = 'Unknown connection error';
      let statusCode: number | undefined;

      if (err instanceof Error) {
        errorMessage = err.message;
        // Check for Fern/TrueForge HTTP error properties
        if ('statusCode' in err && typeof (err as { statusCode: unknown }).statusCode === 'number') {
          statusCode = (err as { statusCode: number }).statusCode;
        }
      } else {
        errorMessage = String(err);
      }

      return {
        ok: false,
        baseUrl: this.baseUrl,
        timestamp,
        error: errorMessage,
        statusCode
      };
    }
  }
}
