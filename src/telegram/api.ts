export type TelegramUser = {
  id: number;
  is_bot: boolean;
  username?: string;
};

export type TelegramChat = {
  id: number;
  type: string;
};

export type TelegramMessage = {
  message_id: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

export class TelegramApiError extends Error {
  constructor(message: string, readonly errorCode?: number) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

export class TelegramNetworkError extends Error {
  constructor(method: string) {
    super(`Telegram ${method} request failed before a verified response.`);
    this.name = 'TelegramNetworkError';
  }
}

export class TelegramApi {
  constructor(private readonly token: string) {}

  async call<T>(method: string, parameters: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(parameters),
          signal: controller.signal,
        });
      } catch {
        throw new TelegramNetworkError(method);
      }

      let body: { ok?: unknown; result?: unknown; description?: unknown; error_code?: unknown };
      try {
        body = await response.json() as typeof body;
      } catch {
        throw new TelegramApiError(`Telegram ${method} returned an invalid response (${response.status}).`);
      }
      if (!response.ok || body.ok !== true) {
        const description = typeof body.description === 'string'
          ? body.description.replaceAll(this.token, '[redacted]').slice(0, 240)
          : 'request rejected';
        const errorCode = typeof body.error_code === 'number' ? body.error_code : undefined;
        throw new TelegramApiError(`Telegram ${method} was rejected (${response.status}): ${description}`, errorCode);
      }
      return body.result as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  getMe(): Promise<TelegramUser> {
    return this.call<TelegramUser>('getMe', {});
  }

  getWebhookInfo(): Promise<{ url: string }> {
    return this.call<{ url: string }>('getWebhookInfo', {});
  }

  getUpdates(offset: number | undefined, timeoutSeconds = 25): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>('getUpdates', {
      ...(offset === undefined ? {} : { offset }),
      timeout: timeoutSeconds,
      allowed_updates: ['message'],
    }, (timeoutSeconds + 10) * 1000);
  }

  sendMessage(chatId: number, text: string): Promise<TelegramMessage> {
    return this.call<TelegramMessage>('sendMessage', { chat_id: chatId, text: text.slice(0, 4000) });
  }
}
