import type { EventEmitter } from 'node:events';

export type TurnOutcome = {
  status: 'completed' | 'failed' | 'interrupted' | 'timeout' | 'approval_timeout';
  result: string;
  error?: string;
  errorCode?: string;
};

type TurnItem = { id: string; text: string; phase?: string };
type TurnNotification = { method?: string; params?: Record<string, unknown> };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Captures the App Server's authoritative item lifecycle for one exact turn. */
export class TurnMonitor {
  readonly completion: Promise<TurnOutcome>;
  get isFinished(): boolean { return this.finished; }
  private resolve!: (outcome: TurnOutcome) => void;
  private turnId: string | null = null;
  private readonly completedMessages = new Map<string, TurnItem>();
  private readonly deltaText = new Map<string, string>();
  private executionTimer: NodeJS.Timeout | undefined;
  private approvalTimer: NodeJS.Timeout | undefined;
  private executionStartedAt = 0;
  private executionRemainingMs: number;
  private pendingApprovals = 0;
  private lastProgressAt = 0;
  private finished = false;

  constructor(
    private readonly client: EventEmitter,
    private readonly options: {
      taskId: string;
      threadId: string;
      executionTimeoutMs: number;
      approvalTimeoutMs: number;
      onProgress?: (text: string) => void;
      onTurnId?: (turnId: string) => void;
    },
  ) {
    this.executionRemainingMs = options.executionTimeoutMs;
    this.completion = new Promise((resolve) => { this.resolve = resolve; });
    this.client.on('notification', this.onNotification);
    this.client.on('exit', this.onExit);
    this.armExecutionTimer();
  }

  setTurnId(turnId: string): void {
    if (this.finished || !turnId || this.turnId) return;
    this.turnId = turnId;
    this.options.onTurnId?.(turnId);
  }

  setApprovalPending(pending: boolean): void {
    if (this.finished) return;
    const previous = this.pendingApprovals;
    this.pendingApprovals = Math.max(0, this.pendingApprovals + (pending ? 1 : -1));
    if (previous === 0 && this.pendingApprovals > 0) {
      this.pauseExecutionTimer();
      this.approvalTimer = setTimeout(() => this.finish({ status: 'approval_timeout', result: '', error: 'Approval was not resolved within 24 hours. Use /resume after reviewing the task.' }), this.options.approvalTimeoutMs);
      this.approvalTimer.unref();
    } else if (previous > 0 && this.pendingApprovals === 0) {
      if (this.approvalTimer) clearTimeout(this.approvalTimer);
      this.approvalTimer = undefined;
      this.armExecutionTimer();
    }
  }

  cancel(): void {
    this.finish({ status: 'interrupted', result: '', error: 'Task was cancelled by an explicit user command.' });
  }

  dispose(): void {
    this.finish({ status: 'interrupted', result: '', error: 'Turn monitoring stopped.' });
  }

  private readonly onExit = () => {
    this.finish({ status: 'interrupted', result: '', error: 'Codex App Server stopped. Review the task and use /resume to continue.' });
  };

  private readonly onNotification = (message: TurnNotification) => {
    const params = record(message.params);
    if (message.method === 'turn/started' && params.threadId === this.options.threadId) {
      const turn = record(params.turn);
      if (typeof turn.id === 'string') this.setTurnId(turn.id);
      return;
    }
    if (message.method === 'item/agentMessage/delta') {
      const itemId = params.itemId;
      const turnId = params.turnId;
      const delta = params.delta;
      if (params.threadId !== this.options.threadId || typeof itemId !== 'string' || typeof turnId !== 'string' || turnId !== this.turnId || typeof delta !== 'string') return;
      const accumulated = `${this.deltaText.get(itemId) ?? ''}${delta}`.slice(-12000);
      this.deltaText.set(itemId, accumulated);
      if (delta.trim() && Date.now() - this.lastProgressAt >= 10000) {
        this.lastProgressAt = Date.now();
        this.options.onProgress?.(accumulated.slice(-1000));
      }
      return;
    }
    if (message.method === 'item/completed') {
      if (params.threadId !== this.options.threadId || typeof params.turnId !== 'string' || params.turnId !== this.turnId) return;
      const item = record(params.item);
      if (item.type !== 'agentMessage' || typeof item.id !== 'string' || typeof item.text !== 'string') return;
      this.completedMessages.set(item.id, { id: item.id, text: item.text, ...(typeof item.phase === 'string' ? { phase: item.phase } : {}) });
      return;
    }
    if (message.method === 'turn/completed') {
      if (params.threadId !== this.options.threadId) return;
      const turn = record(params.turn);
      if (typeof turn.id !== 'string' || turn.id !== this.turnId) return;
      const status = turn.status;
      const error = record(turn.error);
      const messageText = typeof error.message === 'string' ? error.message : undefined;
      const details = typeof error.additionalDetails === 'string' ? error.additionalDetails : undefined;
      const errorMessage = [messageText, details].filter(Boolean).join('\n');
      const codexErrorInfo = typeof error.codexErrorInfo === 'string' ? error.codexErrorInfo : undefined;
      if (status !== 'completed' && status !== 'failed' && status !== 'interrupted') {
        this.finish({ status: 'failed', result: '', error: `Codex returned an unknown turn status: ${String(status ?? 'missing')}.` });
        return;
      }
      this.finish({ status, result: this.finalMessageText(), ...(errorMessage ? { error: errorMessage } : {}), ...(codexErrorInfo ? { errorCode: codexErrorInfo } : {}) });
    }
  };

  private finalMessageText(): string {
    const messages = [...this.completedMessages.values()];
    const finalAnswers = messages.filter((message) => message.phase === 'final_answer');
    if (finalAnswers.length) return finalAnswers.map((message) => message.text.trim()).filter(Boolean).join('\n\n').trim();
    const nonCommentary = messages.filter((message) => message.phase !== 'commentary');
    return nonCommentary.at(-1)?.text.trim() ?? '';
  }

  private armExecutionTimer(): void {
    if (this.finished || this.pendingApprovals > 0 || this.executionTimer || this.executionRemainingMs <= 0) return;
    this.executionStartedAt = Date.now();
    this.executionTimer = setTimeout(() => this.finish({ status: 'timeout', result: '', error: 'Task exceeded the eight-minute active-work limit and was interrupted.' }), this.executionRemainingMs);
    this.executionTimer.unref();
  }

  private pauseExecutionTimer(): void {
    if (!this.executionTimer) return;
    clearTimeout(this.executionTimer);
    this.executionTimer = undefined;
    this.executionRemainingMs = Math.max(0, this.executionRemainingMs - (Date.now() - this.executionStartedAt));
  }

  private finish(outcome: TurnOutcome): void {
    if (this.finished) return;
    this.finished = true;
    if (this.executionTimer) clearTimeout(this.executionTimer);
    if (this.approvalTimer) clearTimeout(this.approvalTimer);
    this.executionTimer = undefined;
    this.approvalTimer = undefined;
    this.client.off('notification', this.onNotification);
    this.client.off('exit', this.onExit);
    this.resolve(outcome);
  }
}
