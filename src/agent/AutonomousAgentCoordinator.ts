import * as vscode from 'vscode';
import { TrueForgeConnection } from '../connection/TrueForgeConnection.js';
import { WorkspaceTools, ProposeEditResult } from './WorkspaceTools.js';
import { InlineEditManager } from '../diff/InlineEditManager.js';

export const DEFAULT_MAX_ITERATIONS = 15;
export const MIN_MAX_ITERATIONS = 1;
export const MAX_MAX_ITERATIONS = 30;

export interface PlanStep {
  id: number;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
}

export interface TaskPlan {
  task: string;
  steps: PlanStep[];
}

export type AgentEventType =
  | 'plan_created'
  | 'step_update'
  | 'thought'
  | 'tool_call'
  | 'tool_result'
  | 'diff_ready'
  | 'task_completed'
  | 'task_cancelled'
  | 'task_error';

export interface AgentTaskEvent {
  type: AgentEventType;
  payload: any;
  timestamp: string;
}

export interface AgentTaskResult {
  success: boolean;
  summary: string;
  plan?: TaskPlan;
  modifiedFiles: string[];
  error?: string;
  cancelled?: boolean;
  pausedForInput?: boolean;
  proposedEdit?: ProposeEditResult;
  proposedEdits?: ProposeEditResult[];
}

export class AutonomousAgentCoordinator {
  public static readonly DEFAULT_MAX_ITERATIONS = DEFAULT_MAX_ITERATIONS;
  public static readonly MIN_MAX_ITERATIONS = MIN_MAX_ITERATIONS;
  public static readonly MAX_MAX_ITERATIONS = MAX_MAX_ITERATIONS;

  private readonly connection: TrueForgeConnection;
  private readonly tools: WorkspaceTools;
  private readonly inlineEditManager: InlineEditManager;
  private currentSessionId: string | null = null;
  private isCancelled = false;
  private activeAbortController?: AbortController;
  private readonly injectedMaxIterations?: number;
  private maxIterations: number;

  constructor(
    connection: TrueForgeConnection,
    tools: WorkspaceTools,
    inlineEditManager: InlineEditManager,
    maxIterations?: number
  ) {
    this.connection = connection;
    this.tools = tools;
    this.inlineEditManager = inlineEditManager;
    this.injectedMaxIterations = maxIterations;
    this.maxIterations = AutonomousAgentCoordinator.resolveMaxIterations(maxIterations);
  }

  public getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  public getMaxIterations(): number {
    return this.injectedMaxIterations !== undefined
      ? this.maxIterations
      : AutonomousAgentCoordinator.resolveMaxIterations();
  }

  /**
   * Validates an iteration limit value.
   * Must be an integer between MIN_MAX_ITERATIONS (1) and MAX_MAX_ITERATIONS (30).
   * Invalid, missing, or out-of-range values safely fall back to DEFAULT_MAX_ITERATIONS (15).
   */
  public static validateIterations(value: unknown): number {
    if (
      typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= AutonomousAgentCoordinator.MIN_MAX_ITERATIONS &&
      value <= AutonomousAgentCoordinator.MAX_MAX_ITERATIONS
    ) {
      return value;
    }
    return AutonomousAgentCoordinator.DEFAULT_MAX_ITERATIONS;
  }

  /**
   * Resolves the maximum autonomous execution iterations.
   * If injectedValue is provided, it is validated and used.
   * Otherwise, the setting is read from vscode.workspace.getConfiguration("trueforge").
   * Missing, invalid, or out-of-range values safely fall back to DEFAULT_MAX_ITERATIONS (15).
   */
  public static resolveMaxIterations(injectedValue?: number): number {
    if (injectedValue !== undefined) {
      return AutonomousAgentCoordinator.validateIterations(injectedValue);
    }

    try {
      if (typeof vscode !== 'undefined' && vscode.workspace && typeof vscode.workspace.getConfiguration === 'function') {
        const config = vscode.workspace.getConfiguration('trueforge');
        const configured = config.get<number>('maxAutonomousIterations');
        if (configured !== undefined && configured !== null) {
          return AutonomousAgentCoordinator.validateIterations(configured);
        }
      }
    } catch {
      // Safely fall through to default on any configuration read error
    }

    return AutonomousAgentCoordinator.DEFAULT_MAX_ITERATIONS;
  }

  /**
   * Executes an autonomous coding task workflow end-to-end.
   */
  public async executeTask(
    userTask: string,
    onEvent?: (event: AgentTaskEvent) => void
  ): Promise<AgentTaskResult> {
    const emit = (type: AgentEventType, payload: any) => {
      if (onEvent) {
        onEvent({
          type,
          payload,
          timestamp: new Date().toLocaleTimeString()
        });
      }
    };

    if (this.isCancelled) {
      emit('task_cancelled', { reason: 'Cancelled by user.' });
      this.isCancelled = false;
      return { success: false, summary: 'Task was cancelled by user.', modifiedFiles: [], cancelled: true };
    }

    this.isCancelled = false;
    let plan: TaskPlan | undefined;
    const modifiedFiles: string[] = [];
    const stagedProposals = new Map<string, ProposeEditResult>();
    let isResumablePause = false;
    let loopDetectedError: string | null = null;

    // Tool call history for loop detection
    const toolHistory: Array<{ tool: string; argsKey: string }> = [];
    const checkLoop = (tool: string, rawArgs: any): { isLoop: boolean; count: number } => {
      const argsKey = JSON.stringify(rawArgs || {});
      let count = 0;
      for (let i = toolHistory.length - 1; i >= 0; i--) {
        if (toolHistory[i].tool === tool && toolHistory[i].argsKey === argsKey) {
          count++;
        } else {
          break;
        }
      }
      toolHistory.push({ tool, argsKey });
      return { isLoop: count >= 3, count: count + 1 };
    };

    const effectiveMaxIterations = this.getMaxIterations();
    this.maxIterations = effectiveMaxIterations;

    try {
      emit('thought', `Initializing autonomous task: "${userTask}"...`);

      // 1. Create a dedicated TrueForge session
      this.currentSessionId = await this.connection.createSession();
      emit('thought', `Connected to TrueForge session ${this.currentSessionId}. Generating execution plan...`);

      // 2. Initial Turn: Planning & Initial Action
      let currentTurnPrompt = this.buildInitialPrompt(userTask);
      let iteration = 0;

      while (iteration < effectiveMaxIterations) {
        if (this.isCancelled) {
          emit('task_cancelled', { reason: 'Cancelled by user.' });
          return { success: false, summary: 'Task was cancelled by user.', modifiedFiles, cancelled: true };
        }

        iteration++;
        emit('thought', `[Iteration ${iteration}/${effectiveMaxIterations}] Evaluating step...`);

        let response = '';
        let rateLimitRetries = 0;
        const maxRateLimitRetries = 2;

        while (true) {
          try {
            this.activeAbortController = new AbortController();
            response = await this.connection.executeTurnStream(
              this.currentSessionId,
              currentTurnPrompt,
              {
                onDelta: (delta) => {
                  response += delta;
                },
                onToolCall: (tc) => {
                  emit('tool_call', { toolName: tc.tool, args: tc.arguments });
                  if (plan && plan.steps.length > 0) {
                    const activeStep =
                      plan.steps.find((s) => s.status === 'in_progress') ||
                      plan.steps.find((s) => s.status === 'pending');
                    if (activeStep) {
                      activeStep.status = 'in_progress';
                      emit('step_update', activeStep);
                    }
                  }
                },
                onToolResult: (tr) => {
                  emit('tool_result', { toolName: tr.toolName, success: tr.success, output: tr.output });
                  if (plan && plan.steps.length > 0) {
                    const currentStep = plan.steps.find((s) => s.status === 'in_progress');
                    if (currentStep) {
                      currentStep.status = tr.success ? 'completed' : 'failed';
                      emit('step_update', currentStep);

                      if (tr.success) {
                        const nextStep = plan.steps.find((s) => s.status === 'pending');
                        if (nextStep) {
                          nextStep.status = 'in_progress';
                          emit('step_update', nextStep);
                        }
                      }
                    }
                  }
                },
                toolExecutor: async (name, args) => {
                  if (this.isCancelled) {
                    throw new Error('Task was cancelled by user.');
                  }

                  // Loop detection
                  const loopInfo = checkLoop(name, args);
                  if (loopInfo.isLoop) {
                    const loopMsg = `[LOOP_DETECTED]: Repetitive tool invocation loop detected. Tool "${name}" was called with identical arguments ${loopInfo.count} times consecutively. Task halted.`;
                    emit('task_error', { error: loopMsg });
                    loopDetectedError = loopMsg;
                    this.activeAbortController?.abort();
                    throw new Error(loopMsg);
                  }

                  const toolResult = await this.tools.executeTool(name, args);

                  if (name === 'propose_edit' && toolResult.success && toolResult.data) {
                    const prop = toolResult.data as ProposeEditResult;
                    stagedProposals.set(prop.relativePath, prop);
                    if (!modifiedFiles.includes(prop.relativePath)) {
                      modifiedFiles.push(prop.relativePath);
                    }

                    if (plan && plan.steps.length > 0) {
                      const currentStep = plan.steps.find((s) => s.status === 'in_progress');
                      if (currentStep) {
                        currentStep.status = 'completed';
                        emit('step_update', currentStep);
                        const nextStep = plan.steps.find((s) => s.status === 'pending');
                        if (nextStep) {
                          nextStep.status = 'in_progress';
                          emit('step_update', nextStep);
                        }
                      }
                    }

                    emit('diff_ready', {
                      file: prop.relativePath,
                      explanation: prop.explanation,
                      totalStaged: stagedProposals.size
                    });

                    await this.openDiffReview(prop, { allowQueue: true });

                    toolResult.output = `Proposed modifications staged for "${prop.relativePath}" (${stagedProposals.size} file(s) currently staged for review). User review is required before changes are applied. You may continue with your plan to inspect and modify additional files, run verification, or provide your final COMPLETION summary.`;
                  }

                  return toolResult;
                },
                abortSignal: this.activeAbortController.signal
              }
            );
            this.activeAbortController = undefined;
            break;
          } catch (turnErr: unknown) {
            this.activeAbortController = undefined;
            const errMsg = turnErr instanceof Error ? turnErr.message : String(turnErr);
            const isRateLimit = errMsg.includes('429') || errMsg.toLowerCase().includes('quota') || errMsg.toLowerCase().includes('rate limit');
            if (isRateLimit && !this.isCancelled && rateLimitRetries < maxRateLimitRetries) {
              rateLimitRetries++;
              let delayMs = 35000;
              const match = errMsg.match(/retry in\s+([\d.]+)\s*s/i);
              if (match && match[1]) {
                delayMs = Math.ceil(parseFloat(match[1]) * 1000) + 2000;
              }
              emit('thought', `Model rate limit (429) encountered. Retrying in ${Math.round(delayMs / 1000)}s (backoff ${rateLimitRetries}/${maxRateLimitRetries})...`);
              await new Promise((res) => setTimeout(res, delayMs));
              continue;
            }
            throw turnErr;
          }
        }

        if (this.isCancelled) {
          emit('task_cancelled', { reason: 'Cancelled by user.' });
          return { success: false, summary: 'Task was cancelled by user.', modifiedFiles, cancelled: true };
        }

        // 3. Extract and parse plan if present
        if (!plan) {
          const parsedPlan = this.parsePlan(response, userTask);
          if (parsedPlan && parsedPlan.steps.length > 0) {
            plan = parsedPlan;
            emit('plan_created', plan);
          }
        }

        // Check if agent completed its plan or task during native execution
        const completionSummary = this.extractCompletion(response);
        const hasPendingSteps = plan && plan.steps.length > 0 && plan.steps.some((s) => s.status === 'pending');

        if (stagedProposals.size > 0 && (completionSummary || !hasPendingSteps)) {
          const summary = completionSummary ||
            `Autonomous task generated proposed edits for ${stagedProposals.size} file(s): ${Array.from(stagedProposals.keys()).join(', ')}. Ready for user diff review.`;
          emit('task_completed', { summary, modifiedFiles });
          return {
            success: true,
            summary,
            plan,
            modifiedFiles,
            proposedEdit: Array.from(stagedProposals.values())[stagedProposals.size - 1],
            proposedEdits: Array.from(stagedProposals.values())
          };
        }

        // 4. Check for tool invocation in text stream fallback
        const toolCall = this.extractToolCall(response);
        if (toolCall) {
          emit('tool_call', { toolName: toolCall.tool, args: toolCall.arguments });

          // Loop detection
          const loopInfo = checkLoop(toolCall.tool, toolCall.arguments);
          if (loopInfo.isLoop) {
            emit('task_error', {
              error: `Repetitive tool invocation loop detected: tool "${toolCall.tool}" was called with identical arguments ${loopInfo.count} times consecutively.`
            });
            return {
              success: false,
              summary: `Autonomous execution terminated: repetitive tool call loop detected for "${toolCall.tool}".`,
              error: 'LOOP_DETECTED',
              plan,
              modifiedFiles,
              proposedEdits: Array.from(stagedProposals.values())
            };
          }

          // Update active plan step
          if (plan && plan.steps.length > 0) {
            const activeStep = plan.steps.find((s) => s.status === 'in_progress') || plan.steps.find((s) => s.status === 'pending');
            if (activeStep) {
              activeStep.status = 'in_progress';
              emit('step_update', activeStep);
            }
          }

          // Execute tool safely
          const toolResult = await this.tools.executeTool(toolCall.tool, toolCall.arguments);
          emit('tool_result', { toolName: toolCall.tool, success: toolResult.success, output: toolResult.output });

          // Update step completion
          if (plan && plan.steps.length > 0) {
            const currentStep = plan.steps.find((s) => s.status === 'in_progress');
            if (currentStep) {
              currentStep.status = toolResult.success ? 'completed' : 'failed';
              emit('step_update', currentStep);

              if (toolResult.success) {
                const nextStep = plan.steps.find((s) => s.status === 'pending');
                if (nextStep) {
                  nextStep.status = 'in_progress';
                  emit('step_update', nextStep);
                }
              }
            }
          }

          // If tool was propose_edit: handle safe diff review
          if (toolCall.tool === 'propose_edit' && toolResult.success && toolResult.data) {
            const prop = toolResult.data as ProposeEditResult;
            stagedProposals.set(prop.relativePath, prop);
            if (!modifiedFiles.includes(prop.relativePath)) {
              modifiedFiles.push(prop.relativePath);
            }

            emit('diff_ready', {
              file: prop.relativePath,
              explanation: prop.explanation,
              totalStaged: stagedProposals.size
            });

            await this.openDiffReview(prop, { allowQueue: true });

            const hasPending = plan && plan.steps.length > 0 && plan.steps.some((s) => s.status === 'pending');
            const comp = this.extractCompletion(response);

            if (!hasPending || comp) {
              const summary = comp ||
                `Proposed modifications generated for "${prop.relativePath}". Ready for user diff review.`;
              emit('task_completed', { summary, modifiedFiles });
              return {
                success: true,
                summary,
                plan,
                modifiedFiles,
                proposedEdit: prop,
                proposedEdits: Array.from(stagedProposals.values())
              };
            }

            // Continue the multi-file loop!
            currentTurnPrompt = `[TOOL RESULT for propose_edit]:\nProposed modifications staged for "${prop.relativePath}" (${stagedProposals.size} file(s) staged for review). User review is required before changes are applied. Continue with your execution plan to inspect and modify remaining files or provide your final COMPLETION summary.`;
          } else {
            // Non-edit tool feedback
            currentTurnPrompt = `[TOOL RESULT for ${toolCall.tool}]:\n${toolResult.output}\n\nContinue to the next step of your plan. If ready to propose modifications, invoke propose_edit.`;
          }
        } else {
          // No tool call: agent completed its thoughts or provided answer
          const summary = this.extractCompletion(response) || response;
          if (plan) {
            plan.steps.forEach((s) => (s.status = 'completed'));
            emit('plan_created', plan);
          }

          const finalSummary = stagedProposals.size > 0
            ? `${summary}\nStaged ${stagedProposals.size} proposed edit(s) for review: ${Array.from(stagedProposals.keys()).join(', ')}.`
            : summary;

          emit('task_completed', { summary: finalSummary, modifiedFiles });
          return {
            success: true,
            summary: finalSummary,
            plan,
            modifiedFiles,
            proposedEdit: Array.from(stagedProposals.values())[stagedProposals.size - 1],
            proposedEdits: Array.from(stagedProposals.values())
          };
        }
      }

      // Reached iteration limit
      const limitSummary = stagedProposals.size > 0
        ? `Reached maximum autonomous execution steps (${effectiveMaxIterations}). Staged ${stagedProposals.size} file(s) for review.`
        : `Reached maximum autonomous execution steps (${effectiveMaxIterations}).`;
      emit('task_completed', { summary: limitSummary, modifiedFiles });
      return {
        success: true,
        summary: limitSummary,
        plan,
        modifiedFiles,
        proposedEdit: Array.from(stagedProposals.values())[stagedProposals.size - 1],
        proposedEdits: Array.from(stagedProposals.values())
      };
    } catch (err: unknown) {
      if (loopDetectedError) {
        emit('task_error', { error: loopDetectedError });
        return {
          success: false,
          summary: loopDetectedError,
          error: loopDetectedError,
          plan,
          modifiedFiles
        };
      }
      if (this.isCancelled) {
        emit('task_cancelled', { reason: 'Cancelled by user.' });
        return { success: false, summary: 'Task was cancelled by user.', modifiedFiles, cancelled: true };
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.toLowerCase().includes('waiting for user input') ||
        msg.toLowerCase().includes('waiting for tool response or user input')
      ) {
        isResumablePause = true;
        emit('thought', `Autonomous task paused: ${msg}`);
        return {
          success: false,
          summary: `Autonomous execution paused: ${msg}`,
          plan,
          modifiedFiles,
          pausedForInput: true
        };
      }
      emit('task_error', { error: msg });
      return { success: false, summary: `Task failed: ${msg}`, error: msg, modifiedFiles };
    } finally {
      this.isCancelled = false;
      this.activeAbortController = undefined;
      if (this.currentSessionId && !isResumablePause) {
        try {
          await this.connection.deleteSession(this.currentSessionId);
        } catch {
          // Ignore delete errors
        }
        this.currentSessionId = null;
      }
    }
  }

  /**
   * Cancels the active autonomous task.
   */
  public async cancel(): Promise<void> {
    this.isCancelled = true;
    if (this.activeAbortController) {
      try {
        this.activeAbortController.abort();
      } catch { }
      this.activeAbortController = undefined;
    }
    if (this.currentSessionId) {
      try {
        await this.connection.cancelTurn(this.currentSessionId);
      } catch {
        // Ignore cancel errors
      }
    }
  }

  /**
   * Opens the virtual proposed document in VS Code's diff editor
   * and displays explicit review actions.
   */
  public async openDiffReview(
    proposed: ProposeEditResult,
    options?: { allowQueue?: boolean }
  ): Promise<void> {
    if (this.inlineEditManager) {
      await this.inlineEditManager.registerAutonomousProposal(
        proposed.absolutePath,
        proposed.replacementCode,
        proposed.explanation,
        {
          startLine: proposed.startLine,
          endLine: proposed.endLine,
          fullProposedText: proposed.fullProposedText,
          allowQueue: options?.allowQueue
        }
      );
    }
  }

  private buildInitialPrompt(userTask: string): string {
    return [
      `You are TrueForge autonomous coding agent.`,
      `The user has requested the following task:`,
      `"${userTask}"`,
      ``,
      `### AVAILABLE WORKSPACE TOOLS:`,
      `1. list_files: Lists files in the workspace. Arguments: { "directory": "optional/path" }`,
      `2. read_file: Reads lines from a file. Arguments: { "path": "src/file.ts", "startLine": 1, "endLine": 50 }`,
      `3. search_code: Searches code in workspace. Arguments: { "query": "text" }`,
      `4. propose_edit: Proposes modifications for review. Arguments: { "path": "src/file.ts", "replacementCode": "...", "explanation": "...", "startLine": 28, "endLine": 33 }`,
      ``,
      `### IMPORTANT INSTRUCTIONS FOR PROPOSE_EDIT:`,
      `- Always inspect target lines using read_file before proposing modifications.`,
      `- For targeted edits: specify 1-indexed inclusive "startLine" and "endLine". "replacementCode" must contain ONLY the replacement code for those exact lines, NOT the entire file or unrelated functions.`,
      `- Full-file replacement: omit "startLine" and "endLine" only when replacing the entire file.`,
      ``,
      `### PROTOCOL:`,
      `1. First, output a numbered execution plan under a "PLAN:" header.`,
      `2. To call a tool, output:`,
      `TOOL_CALL:`,
      `\`\`\`json`,
      `{ "tool": "<name>", "arguments": { ... } }`,
      `\`\`\``,
      `3. Wait for the tool output before proceeding.`,
      `4. When ready to generate code modifications, invoke propose_edit.`,
      `5. Conclude with a clear summary under "COMPLETION:".`
    ].join('\n');
  }

  public parsePlan(text: string, userTask: string): TaskPlan | null {
    const planMatch = text.match(/PLAN:\s*\r?\n([\s\S]*?)(?=(?:TOOL_CALL:|COMPLETION:|$))/i);
    if (!planMatch) {
      return null;
    }

    const planSection = planMatch[1];
    const stepLines = planSection
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^[-*•\d]+[.)\s]/.test(l));

    if (stepLines.length === 0) {
      return null;
    }

    const steps: PlanStep[] = stepLines.map((line, idx) => ({
      id: idx + 1,
      description: line.replace(/^[-*•\d]+[.)\s]+/, '').trim(),
      status: idx === 0 ? 'in_progress' : 'pending'
    }));

    return { task: userTask, steps };
  }

  public extractToolCall(text: string): { tool: string; arguments: any } | null {
    // 1. Look for TOOL_CALL:\s*```json ... ```
    const toolCallBlockRegex = /TOOL_CALL:\s*```(?:json)?\r?\n([\s\S]*?)\r?\n```/i;
    const match = text.match(toolCallBlockRegex);

    if (match && match[1]) {
      try {
        const parsed = JSON.parse(match[1].trim());
        if (parsed && typeof parsed.tool === 'string') {
          return { tool: parsed.tool, arguments: parsed.arguments || {} };
        }
      } catch {
        // Fall through
      }
    }

    // 2. Look for balanced standalone json with "tool": "..."
    const toolIdx = text.search(/\{\s*"tool"\s*:/);
    if (toolIdx !== -1) {
      let depth = 0;
      let inString = false;
      let escape = false;
      let endIndex = -1;

      for (let i = toolIdx; i < text.length; i++) {
        const char = text[i];
        if (escape) {
          escape = false;
          continue;
        }
        if (char === '\\') {
          escape = true;
          continue;
        }
        if (char === '"') {
          inString = !inString;
          continue;
        }
        if (!inString) {
          if (char === '{') {
            depth++;
          } else if (char === '}') {
            depth--;
            if (depth === 0) {
              endIndex = i;
              break;
            }
          }
        }
      }

      if (endIndex !== -1) {
        const jsonCandidate = text.slice(toolIdx, endIndex + 1);
        try {
          const parsed = JSON.parse(jsonCandidate);
          if (parsed && typeof parsed.tool === 'string') {
            return {
              tool: parsed.tool,
              arguments: parsed.arguments || {}
            };
          }
        } catch {
          // Fall through
        }
      }
    }

    return null;
  }

  public extractCompletion(text: string): string | null {
    const match = text.match(/COMPLETION:\s*\r?\n([\s\S]*)$/i);
    return match && match[1] ? match[1].trim() : null;
  }
}
