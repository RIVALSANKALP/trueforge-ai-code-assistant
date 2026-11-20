import { TrueForge } from '@truefoundry/trueforge-sdk';
import { HealthProbe, HealthCheckResult } from './HealthProbe.js';

export interface TrueForgeConnectionConfig {
  baseUrl?: string;
  timeoutInSeconds?: number;
  maxRetries?: number;
  onLog?: (message: string) => void;
}

export interface AgentInfo {
  id: string;
  name: string;
  description?: string;
  modelName?: string;
  instructions?: string;
}

export class TrueForgeConnection {
  private readonly baseUrl: string;
  private readonly client: TrueForge;
  private readonly healthProbe: HealthProbe;
  private readonly onLog: (message: string) => void;

  public static readonly DEFAULT_BASE_URL = 'http://localhost:8790';
  public static readonly DEFAULT_AGENT_NAME = 'forgeagent';
  public static readonly DEFAULT_AGENT_ID = '01m7t1cn7kxveffccxp2exv0me';

  constructor(config?: TrueForgeConnectionConfig) {
    this.baseUrl = config?.baseUrl ?? TrueForgeConnection.DEFAULT_BASE_URL;
    this.onLog = config?.onLog ?? (() => {});

    this.client = new TrueForge({
      baseUrl: this.baseUrl,
      timeoutInSeconds: config?.timeoutInSeconds ?? 60,
      maxRetries: config?.maxRetries ?? 2
    });

    this.healthProbe = new HealthProbe(this.client, this.baseUrl);
    this.log(`TrueForgeConnection initialized targeting ${this.baseUrl}`);
  }

  public getClient(): TrueForge {
    return this.client;
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  public async checkHealth(): Promise<HealthCheckResult> {
    const result = await this.healthProbe.checkHealth();
    if (result.ok) {
      this.log(`TrueForge server health check succeeded at ${result.baseUrl}`);
    } else {
      this.log(`TrueForge server health check failed: ${result.error}`);
    }
    return result;
  }

  /**
   * Retrieves agent metadata by name (defaults to forgeagent).
   */
  public async getAgent(agentName = TrueForgeConnection.DEFAULT_AGENT_NAME): Promise<AgentInfo | undefined> {
    try {
      const response = await this.client.agents.list();
      const agents = response.data ?? response;
      const target = (agents as any[]).find((a: any) => a.name === agentName || a.id === agentName);
      if (!target) {
        return undefined;
      }
      return {
        id: target.id,
        name: target.name,
        description: target.description,
        modelName: target.manifest?.model?.name,
        instructions: target.manifest?.instructions
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.log(`Failed to retrieve agent "${agentName}": ${errorMsg}`);
      throw err;
    }
  }

  /**
   * Creates a new conversational session bound to the specified agent.
   */
  public async createSession(agentName = TrueForgeConnection.DEFAULT_AGENT_NAME): Promise<string> {
    try {
      this.log(`Creating session for agent "${agentName}"...`);
      const session = await this.client.sessions.create({
        agent: { name: agentName }
      });
      const sessionId = session.data.id;
      this.log(`Session created successfully: ${sessionId}`);
      return sessionId;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.log(`Session creation failed: ${errorMsg}`);
      throw err;
    }
  }

  /**
   * Executes a turn on the specified session with real-time streaming output.
   */
  public async executeTurnStream(
    sessionId: string,
    prompt: string,
    onDelta: (chunk: string) => void,
    onEvent?: (event: any) => void
  ): Promise<string> {
    try {
      this.log(`Submitting turn on session ${sessionId}...`);
      const stream = await this.client.sessions.createTurnStream(sessionId, {
        input: [
          {
            type: 'user.message',
            content: prompt
          }
        ]
      });

      let fullResponse = '';
      for await (const event of stream) {
        if (onEvent) {
          onEvent(event);
        }

        const rawEvent = event as any;
        if (rawEvent.type === 'model.message.delta' && rawEvent.content) {
          fullResponse += rawEvent.content;
          onDelta(rawEvent.content);
        } else if (rawEvent.type === 'turn.done' && rawEvent.state?.output?.content) {
          // If deltas were missed or empty, fallback to turn.done output
          if (!fullResponse) {
            fullResponse = rawEvent.state.output.content;
            onDelta(fullResponse);
          }
        }
      }

      this.log(`Turn on session ${sessionId} completed. Received ${fullResponse.length} chars.`);
      return fullResponse;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.log(`Turn execution failed on session ${sessionId}: ${errorMsg}`);
      throw err;
    }
  }

  /**
   * Cancels the active turn on a session.
   */
  public async cancelTurn(sessionId: string): Promise<void> {
    try {
      this.log(`Canceling active turn on session ${sessionId}...`);
      await this.client.sessions.cancel(sessionId);
      this.log(`Cancel request sent for session ${sessionId}.`);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.log(`Cancel failed for session ${sessionId}: ${errorMsg}`);
      throw err;
    }
  }

  /**
   * Deletes a session and releases associated server resources.
   */
  public async deleteSession(sessionId: string): Promise<void> {
    try {
      this.log(`Deleting session ${sessionId}...`);
      await this.client.sessions.delete(sessionId);
      this.log(`Session ${sessionId} deleted.`);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.log(`Delete session ${sessionId} failed: ${errorMsg}`);
    }
  }

  private log(message: string): void {
    this.onLog(`[${new Date().toISOString()}] ${message}`);
  }
}
