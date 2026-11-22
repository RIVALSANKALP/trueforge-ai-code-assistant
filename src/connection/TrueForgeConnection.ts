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

export interface StoredModelToolCall {
  id: string;
  name: string;
  arguments: any;
  sourceEventId: string;
  threadId: string;
}

export interface ToolExecutionResult {
  success: boolean;
  output: string;
  data?: any;
  error?: string;
}

export interface ExecuteTurnStreamOptions {
  onDelta?: (chunk: string) => void;
  onEvent?: (event: any) => void;
  toolExecutor?: (name: string, args: any) => Promise<ToolExecutionResult>;
  onToolCall?: (toolCall: { id: string; tool: string; arguments: any }) => void;
  onToolResult?: (result: { toolName: string; success: boolean; output: string }) => void;
  abortSignal?: AbortSignal;
}

/**
 * Robustly checks if an error represents an abort or user cancellation.
 */
export function isCancellationError(err: unknown): boolean {
  if (!err) {
    return false;
  }
  if (typeof err === 'object' && ((err as any).name === 'AbortError' || (err as any).name === 'CanceledError')) {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  return lower.includes('cancelled') || lower.includes('canceled') || lower.includes('abort');
}

/**
 * Robustly extracts text from string, array of content parts, or refusal.
 */
export function extractTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== 'object') {
          return '';
        }
        if ('text' in part && typeof (part as any).text === 'string') {
          return (part as any).text;
        }
        if ('refusal' in part && typeof (part as any).refusal === 'string') {
          return (part as any).refusal;
        }
        return '';
      })
      .join('');
  }
  if (content && typeof content === 'object') {
    if ('text' in content && typeof (content as any).text === 'string') {
      return (content as any).text;
    }
    if ('refusal' in content && typeof (content as any).refusal === 'string') {
      return (content as any).refusal;
    }
  }
  return '';
}

export class TrueForgeConnection {
  private readonly baseUrl: string;
  private readonly client: TrueForge;
  private readonly healthProbe: HealthProbe;
  private readonly onLog: (message: string) => void;
  private lastTurnId?: string;

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

  public getLastTurnId(): string | undefined {
    return this.lastTurnId;
  }

  /**
   * Submits user turn events (such as tool responses) to an active turn.
   */
  public async createTurnEvents(
    sessionId: string,
    turnId: string,
    request: { events: Array<{ type: string; threadId: string; toolCallId: string; content: string }> }
  ): Promise<any> {
    try {
      this.log(`Submitting ${request.events.length} turn event(s) on session ${sessionId}, turn ${turnId}...`);
      const response = await (this.client.sessions as any).createTurnEvents(sessionId, turnId, request);
      return response;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.log(`Failed to create turn events on session ${sessionId}, turn ${turnId}: ${errorMsg}`);
      throw err;
    }
  }

  /**
   * Subscribes to an existing turn's event stream from a specific event cursor.
   */
  public async subscribeToTurn(
    sessionId: string,
    turnId: string,
    request?: { afterEventId?: string; fromEventId?: string }
  ): Promise<any> {
    try {
      this.log(`Subscribing to turn ${turnId} on session ${sessionId} (afterEventId: ${request?.afterEventId ?? 'none'})...`);
      const stream = await (this.client.sessions as any).subscribeToTurn(sessionId, turnId, request);
      return stream;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.log(`Failed to subscribe to turn ${turnId} on session ${sessionId}: ${errorMsg}`);
      throw err;
    }
  }

  /**
   * Executes a turn on the specified session with real-time streaming output
   * and native TrueForge tool-calling lifecycle support.
   */
  public async executeTurnStream(
    sessionId: string,
    prompt: string,
    onDeltaOrOptions?: ((chunk: string) => void) | ExecuteTurnStreamOptions,
    onEvent?: (event: any) => void
  ): Promise<string> {
    let onAbort: (() => void) | undefined;
    let abortSignal: AbortSignal | undefined;
    try {
      this.log(`Submitting turn on session ${sessionId}...`);
      this.lastTurnId = undefined;

      let onDelta: (chunk: string) => void = () => {};
      let onEventCallback: ((event: any) => void) | undefined = onEvent;
      let toolExecutor: ((name: string, args: any) => Promise<ToolExecutionResult>) | undefined;
      let onToolCall: ((toolCall: { id: string; tool: string; arguments: any }) => void) | undefined;
      let onToolResult: ((result: { toolName: string; success: boolean; output: string }) => void) | undefined;

      if (typeof onDeltaOrOptions === 'function') {
        onDelta = onDeltaOrOptions;
      } else if (onDeltaOrOptions && typeof onDeltaOrOptions === 'object') {
        if (typeof onDeltaOrOptions.onDelta === 'function') {
          onDelta = onDeltaOrOptions.onDelta;
        }
        if (typeof onDeltaOrOptions.onEvent === 'function') {
          onEventCallback = onDeltaOrOptions.onEvent;
        }
        toolExecutor = onDeltaOrOptions.toolExecutor;
        onToolCall = onDeltaOrOptions.onToolCall;
        onToolResult = onDeltaOrOptions.onToolResult;
        abortSignal = onDeltaOrOptions.abortSignal;
      }

      if (abortSignal?.aborted) {
        this.log(`executeTurnStream aborted before starting on session ${sessionId}.`);
        const cancelErr = new Error('Turn was cancelled.');
        cancelErr.name = 'AbortError';
        throw cancelErr;
      }

      onAbort = () => {
        this.log(`AbortSignal triggered for session ${sessionId}. Canceling turn on server...`);
        this.cancelTurn(sessionId).catch(() => {});
      };
      if (abortSignal) {
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      let currentTurnId: string | undefined;
      let lastEventId: string | undefined;
      const storedModelToolCalls = new Map<string, StoredModelToolCall>();

      let fullResponse = '';
      let seenAnyDelta = false;
      const seenDeltaMessageIds = new Set<string>();
      const seenFullMessageIds = new Set<string>();
      let terminalStatus: 'done' | 'error' | 'cancelled' | 'paused' | undefined;
      let terminalErrorMessage: string | undefined;
      let turnUpdatePaused = false;
      let hasNativeToolCall = false;
      let nativeToolCallsText = '';

      const requestOptions = abortSignal ? { abortSignal } : undefined;
      let currentStream: AsyncIterable<any> = await (this.client.sessions as any).createTurnStream(
        sessionId,
        {
          input: [
            {
              type: 'user.message',
              content: prompt
            }
          ]
        },
        requestOptions
      );

      let isTurnComplete = false;
      let toolCycleCount = 0;
      const MAX_TOOL_CYCLES = 15;

      while (!isTurnComplete) {
        if (abortSignal?.aborted) {
          const cancelErr = new Error('Turn was cancelled.');
          cancelErr.name = 'AbortError';
          throw cancelErr;
        }

        let pendingToolResponseRequired: any = null;

        for await (const event of currentStream) {
          if (abortSignal?.aborted) {
            const cancelErr = new Error('Turn was cancelled.');
            cancelErr.name = 'AbortError';
            throw cancelErr;
          }
          if (onEventCallback) {
            onEventCallback(event);
          }

          const rawEvent = event as any;
          if (!rawEvent || typeof rawEvent !== 'object') {
            continue;
          }

          if (rawEvent.id) {
            lastEventId = rawEvent.id;
          }

          if (rawEvent.turnId) {
            currentTurnId = rawEvent.turnId;
            this.lastTurnId = currentTurnId;
          } else if (rawEvent.type === 'turn.created' && rawEvent.turnId) {
            currentTurnId = rawEvent.turnId;
            this.lastTurnId = currentTurnId;
          }

          if (rawEvent.type === 'model.message.delta') {
            seenAnyDelta = true;
            if (rawEvent.id) {
              seenDeltaMessageIds.add(rawEvent.id);
            }
            const chunk =
              extractTextContent(rawEvent.content) ||
              (typeof rawEvent.refusal === 'string' ? rawEvent.refusal : '');
            if (chunk) {
              fullResponse += chunk;
              onDelta(chunk);
            }
          } else if (rawEvent.type === 'model.message') {
            const sourceEventId = rawEvent.id;
            const threadId = rawEvent.threadId || 'main';

            const hasId = typeof sourceEventId === 'string' && sourceEventId.length > 0;
            const alreadyStreamed = hasId
              ? seenDeltaMessageIds.has(sourceEventId)
              : (seenAnyDelta && fullResponse.length > 0);

            if (!alreadyStreamed) {
              if (hasId) {
                if (!seenFullMessageIds.has(sourceEventId)) {
                  seenFullMessageIds.add(sourceEventId);
                  const msgText =
                    extractTextContent(rawEvent.content) ||
                    (typeof rawEvent.refusal === 'string' ? rawEvent.refusal : '');
                  if (msgText) {
                    fullResponse += msgText;
                    onDelta(msgText);
                  }
                }
              } else {
                const msgText =
                  extractTextContent(rawEvent.content) ||
                  (typeof rawEvent.refusal === 'string' ? rawEvent.refusal : '');
                if (msgText) {
                  fullResponse += msgText;
                  onDelta(msgText);
                }
              }
            }

            // Inspect and preserve structured model toolCalls
            if (Array.isArray(rawEvent.toolCalls) && rawEvent.toolCalls.length > 0) {
              hasNativeToolCall = true;
              for (const tc of rawEvent.toolCalls) {
                const callId = tc.id;
                const fnName = tc.function?.name || tc.name;
                const fnArgs = tc.function?.arguments ?? tc.arguments;
                if (callId && fnName) {
                  const key = `${sourceEventId}:${callId}`;
                  storedModelToolCalls.set(key, {
                    id: callId,
                    name: fnName,
                    arguments: fnArgs,
                    sourceEventId,
                    threadId
                  });
                }

                // If no native toolExecutor, synthesize text protocol
                if (!toolExecutor && fnName) {
                  let parsedArgs = fnArgs;
                  if (typeof parsedArgs === 'string') {
                    try {
                      parsedArgs = JSON.parse(parsedArgs);
                    } catch {}
                  }
                  if (!parsedArgs || typeof parsedArgs !== 'object') {
                    parsedArgs = {};
                  }
                  nativeToolCallsText += `\nTOOL_CALL:\n\`\`\`json\n${JSON.stringify({ tool: fnName, arguments: parsedArgs }, null, 2)}\n\`\`\`\n`;
                }
              }
            }
          } else if (rawEvent.type === 'tool.response_required') {
            hasNativeToolCall = true;
            pendingToolResponseRequired = rawEvent;

            if (!toolExecutor && Array.isArray(rawEvent.toolCalls)) {
              for (const tc of rawEvent.toolCalls) {
                const fnName = tc.function?.name || tc.name;
                let fnArgs = tc.function?.arguments ?? tc.arguments;
                if (fnName) {
                  if (typeof fnArgs === 'string') {
                    try {
                      fnArgs = JSON.parse(fnArgs);
                    } catch {}
                  }
                  if (!fnArgs || typeof fnArgs !== 'object') {
                    fnArgs = {};
                  }
                  nativeToolCallsText += `\nTOOL_CALL:\n\`\`\`json\n${JSON.stringify({ tool: fnName, arguments: fnArgs }, null, 2)}\n\`\`\`\n`;
                }
              }
            }
          } else if (rawEvent.type === 'turn.update' && rawEvent.state) {
            if (rawEvent.state.status === 'paused') {
              turnUpdatePaused = true;
              terminalErrorMessage = 'Turn paused: waiting for tool response or user input.';
            } else if (rawEvent.state.status === 'running') {
              turnUpdatePaused = false;
            }
          } else if (rawEvent.type === 'turn.done') {
            const status = rawEvent.state?.status;
            if (status === 'error') {
              terminalStatus = 'error';
              terminalErrorMessage = rawEvent.state?.message || 'TrueForge turn ended with error status.';
            } else if (status === 'cancelled') {
              terminalStatus = 'cancelled';
              const reason = rawEvent.state?.reason ? `: ${rawEvent.state.reason}` : '';
              terminalErrorMessage = `Turn was cancelled${reason}.`;
            } else if (status === 'done') {
              terminalStatus = 'done';
              // If deltas and model.message were not received or yielded empty response, fallback to turn.done output
              if (!fullResponse && rawEvent.state?.output) {
                const fallbackText =
                  extractTextContent(rawEvent.state.output.content) ||
                  (typeof rawEvent.state.output.refusal === 'string' ? rawEvent.state.output.refusal : '');
                if (fallbackText) {
                  fullResponse = fallbackText;
                  onDelta(fallbackText);
                }
              }
            } else if (status === 'paused') {
              terminalStatus = 'paused';
              terminalErrorMessage = 'Turn paused: waiting for tool response or user input.';
            }
          }
        }

        // Check if we should execute tool calls natively
        if (pendingToolResponseRequired && toolExecutor && currentTurnId) {
          toolCycleCount++;
          if (toolCycleCount > MAX_TOOL_CYCLES) {
            throw new Error(`Exceeded maximum tool execution cycles (${MAX_TOOL_CYCLES}) on turn ${currentTurnId}.`);
          }

          const refs: Array<{ id: string; sourceEventId: string }> = Array.isArray(pendingToolResponseRequired.toolCalls)
            ? pendingToolResponseRequired.toolCalls
            : [];
          const threadId = pendingToolResponseRequired.threadId || 'main';
          const toolEventsToSend: any[] = [];

          for (const ref of refs) {
            const key = `${ref.sourceEventId}:${ref.id}`;
            const matched = storedModelToolCalls.get(key);

            if (!matched) {
              // Return clear error for unmatched tool-call references; never guess
              const errorContent = JSON.stringify({
                success: false,
                error: 'UNMATCHED_TOOL_CALL',
                message: `Unmatched tool-call reference: id=${ref.id}, sourceEventId=${ref.sourceEventId}. Call arguments could not be verified.`
              });
              toolEventsToSend.push({
                type: 'user.tool_response',
                threadId,
                toolCallId: ref.id,
                content: errorContent
              });
              continue;
            }

            // Parse arguments
            let parsedArgs: any = matched.arguments;
            let argParseError: string | null = null;
            if (typeof parsedArgs === 'string') {
              try {
                parsedArgs = JSON.parse(parsedArgs);
              } catch (err: unknown) {
                const errMsg = err instanceof Error ? err.message : String(err);
                argParseError = `Malformed JSON arguments for tool "${matched.name}": ${errMsg}`;
              }
            }

            if (!argParseError && (parsedArgs === undefined || parsedArgs === null)) {
              parsedArgs = {};
            }

            if (argParseError) {
              toolEventsToSend.push({
                type: 'user.tool_response',
                threadId: matched.threadId || threadId,
                toolCallId: ref.id,
                content: JSON.stringify({
                  success: false,
                  error: 'MALFORMED_ARGUMENTS',
                  message: argParseError
                })
              });
              continue;
            }

            if (onToolCall) {
              onToolCall({ id: ref.id, tool: matched.name, arguments: parsedArgs });
            }

            // Execute tool safely
            let toolResult: ToolExecutionResult;
            try {
              toolResult = await toolExecutor(matched.name, parsedArgs);
            } catch (err: unknown) {
              const errMsg = err instanceof Error ? err.message : String(err);
              toolResult = {
                success: false,
                error: 'TOOL_EXECUTION_ERROR',
                output: `Tool execution error for "${matched.name}": ${errMsg}`
              };
            }

            if (onToolResult) {
              onToolResult({
                toolName: matched.name,
                success: Boolean(toolResult?.success),
                output: toolResult?.output || ''
              });
            }

            let content = '';
            if (typeof toolResult?.output === 'string') {
              content = toolResult.output;
            } else if (toolResult?.data !== undefined) {
              content = typeof toolResult.data === 'string' ? toolResult.data : JSON.stringify(toolResult.data);
            } else {
              content = JSON.stringify(toolResult || {});
            }

            toolEventsToSend.push({
              type: 'user.tool_response',
              threadId: matched.threadId || threadId,
              toolCallId: ref.id,
              content
            });
          }

          if (toolEventsToSend.length > 0) {
            this.log(`Submitting ${toolEventsToSend.length} tool response event(s) on session ${sessionId}, turn ${currentTurnId}...`);
            await this.createTurnEvents(sessionId, currentTurnId, { events: toolEventsToSend });

            this.log(`Resuming turn ${currentTurnId} after event cursor ${lastEventId}...`);
            currentStream = await this.subscribeToTurn(sessionId, currentTurnId, {
              afterEventId: lastEventId
            });

            terminalStatus = undefined;
            turnUpdatePaused = false;
            continue;
          }
        }

        // If tool response was required but turnId was missing, fallback to synthesized text
        if (pendingToolResponseRequired && !currentTurnId) {
          this.log(`tool.response_required received without turnId; falling back to text protocol.`);
          if (Array.isArray(pendingToolResponseRequired.toolCalls)) {
            for (const ref of pendingToolResponseRequired.toolCalls) {
              const key = `${ref.sourceEventId}:${ref.id}`;
              const matched = storedModelToolCalls.get(key);
              const fnName = matched?.name || (ref as any).function?.name || (ref as any).name;
              let fnArgs = matched?.arguments ?? (ref as any).function?.arguments ?? (ref as any).arguments;
              if (fnName) {
                if (typeof fnArgs === 'string') {
                  try {
                    fnArgs = JSON.parse(fnArgs);
                  } catch {}
                }
                if (!fnArgs || typeof fnArgs !== 'object') {
                  fnArgs = {};
                }
                nativeToolCallsText += `\nTOOL_CALL:\n\`\`\`json\n${JSON.stringify({ tool: fnName, arguments: fnArgs }, null, 2)}\n\`\`\`\n`;
              }
            }
          }
        }

        isTurnComplete = true;
      }

      // If native tool calls were received and not already part of fullResponse text, append them
      if (nativeToolCallsText && !fullResponse.includes('TOOL_CALL:')) {
        fullResponse = (fullResponse ? fullResponse + '\n' : '') + nativeToolCallsText.trim();
        onDelta(fullResponse);
      }

      if (terminalStatus === 'error') {
        throw new Error(terminalErrorMessage || 'Turn execution failed on TrueForge server.');
      }
      if (terminalStatus === 'cancelled') {
        throw new Error(terminalErrorMessage || 'Turn was cancelled.');
      }

      const isPaused = terminalStatus === 'paused' || (!terminalStatus && turnUpdatePaused);
      if (isPaused) {
        // If the turn produced content or requested tool actions, do not throw; return content so coordinator continues
        if (fullResponse.trim().length > 0 || hasNativeToolCall) {
          this.log(`Turn on session ${sessionId} paused with active content (${fullResponse.length} chars). Continuing execution.`);
          return fullResponse;
        }

        // Genuine user-input pause (0 characters and no tool calls)
        throw new Error(terminalErrorMessage || 'Turn paused: waiting for tool response or user input.');
      }

      this.log(`Turn on session ${sessionId} completed. Received ${fullResponse.length} chars.`);
      return fullResponse;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.log(`Turn execution failed on session ${sessionId}: ${errorMsg}`);
      throw err;
    } finally {
      if (abortSignal && onAbort) {
        try {
          abortSignal.removeEventListener('abort', onAbort);
        } catch {}
      }
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
