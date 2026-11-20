import { TrueForgeConnection } from '../connection/TrueForgeConnection.js';
import { WorkspaceTools, ProposeEditResult } from './WorkspaceTools.js';
import { InlineEditManager } from '../diff/InlineEditManager.js';

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
  proposedEdit?: ProposeEditResult;
}

export class AutonomousAgentCoordinator {
  private readonly connection: TrueForgeConnection;
  private readonly tools: WorkspaceTools;
  private readonly inlineEditManager: InlineEditManager;
  private currentSessionId: string | null = null;
  private isCancelled = false;
  private maxIterations: number;

  constructor(
    connection: TrueForgeConnection,
    tools: WorkspaceTools,
    inlineEditManager: InlineEditManager,
    maxIterations = 6
  ) {
    this.connection = connection;
    this.tools = tools;
    this.inlineEditManager = inlineEditManager;
    this.maxIterations = maxIterations;
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
    let proposedEditResult: ProposeEditResult | undefined;

    try {
      emit('thought', `Initializing autonomous task: "${userTask}"...`);

      // 1. Create a dedicated TrueForge session
      this.currentSessionId = await this.connection.createSession();
      emit('thought', `Connected to TrueForge session ${this.currentSessionId}. Generating execution plan...`);

      // 2. Initial Turn: Planning & Initial Action
      let currentTurnPrompt = this.buildInitialPrompt(userTask);
      let iteration = 0;

      while (iteration < this.maxIterations) {
        if (this.isCancelled) {
          emit('task_cancelled', { reason: 'Cancelled by user.' });
          return { success: false, summary: 'Task was cancelled by user.', modifiedFiles, cancelled: true };
        }

        iteration++;
        emit('thought', `[Iteration ${iteration}/${this.maxIterations}] Evaluating step...`);

        let response = '';
        response = await this.connection.executeTurnStream(
          this.currentSessionId,
          currentTurnPrompt,
          (delta) => {
            response += delta;
          }
        );

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

        // 4. Check for tool invocation
        const toolCall = this.extractToolCall(response);
        if (toolCall) {
          emit('tool_call', { toolName: toolCall.tool, args: toolCall.arguments });

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
            proposedEditResult = toolResult.data as ProposeEditResult;
            modifiedFiles.push(proposedEditResult.relativePath);

            if (plan) {
              plan.steps.forEach((s) => {
                if (s.status === 'in_progress') s.status = 'completed';
              });
              emit('plan_created', plan);
            }

            emit('diff_ready', {
              file: proposedEditResult.relativePath,
              explanation: proposedEditResult.explanation
            });

            // Open diff view in VS Code
            await this.openDiffReview(proposedEditResult);

            emit('task_completed', {
              summary: `Proposed modifications generated for "${proposedEditResult.relativePath}". Ready for user diff review.`,
              modifiedFiles
            });

            return {
              success: true,
              summary: `Autonomous task generated proposed edit for ${proposedEditResult.relativePath}.`,
              plan,
              modifiedFiles,
              proposedEdit: proposedEditResult
            };
          }

          // Otherwise: feed tool output back to TrueForge for next turn
          currentTurnPrompt = `[TOOL RESULT for ${toolCall.tool}]:\n${toolResult.output}\n\nContinue to the next step of your plan. If ready to propose modifications, invoke propose_edit.`;
        } else {
          // No tool call: agent completed its thoughts or provided answer
          const summary = this.extractCompletion(response) || response;
          if (plan) {
            plan.steps.forEach((s) => (s.status = 'completed'));
            emit('plan_created', plan);
          }

          emit('task_completed', { summary, modifiedFiles });
          return {
            success: true,
            summary,
            plan,
            modifiedFiles
          };
        }
      }

      // Reached iteration limit
      const limitSummary = `Reached maximum autonomous execution steps (${this.maxIterations}).`;
      emit('task_completed', { summary: limitSummary, modifiedFiles });
      return { success: true, summary: limitSummary, plan, modifiedFiles };
    } catch (err: unknown) {
      if (this.isCancelled) {
        emit('task_cancelled', { reason: 'Cancelled by user.' });
        return { success: false, summary: 'Task was cancelled by user.', modifiedFiles, cancelled: true };
      }
      const msg = err instanceof Error ? err.message : String(err);
      emit('task_error', { error: msg });
      return { success: false, summary: `Task failed: ${msg}`, error: msg, modifiedFiles };
    } finally {
      this.isCancelled = false;
      if (this.currentSessionId) {
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
  public async openDiffReview(proposed: ProposeEditResult): Promise<void> {
    await this.inlineEditManager.registerAutonomousProposal(
      proposed.absolutePath,
      proposed.replacementCode,
      proposed.explanation
    );
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
      `4. propose_edit: Proposes modifications for review. Arguments: { "path": "src/file.ts", "replacementCode": "...", "explanation": "..." }`,
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
