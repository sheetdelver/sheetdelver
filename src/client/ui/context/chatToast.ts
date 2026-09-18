export interface ChatToastSettings {
    enabled: boolean;
    durationMs: number;
}

export const defaultChatToastSettings: ChatToastSettings = { enabled: true, durationMs: 5000 };

export function normalizeChatToastSettings(value: unknown): ChatToastSettings {
    const data = value && typeof value === 'object' ? value as Partial<ChatToastSettings> : {};
    return {
        enabled: data.enabled !== false,
        durationMs: typeof data.durationMs === 'number' && Number.isFinite(data.durationMs)
            ? Math.round(Math.max(1000, Math.min(15000, data.durationMs)) / 500) * 500 : 5000,
    };
}
