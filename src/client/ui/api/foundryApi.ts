import { requestJson } from '@client/ui/api/http';
import type { AuthenticatedStatusPayload } from '@shared/contracts/status';
import type { ActorCardsPayload, ActorDetailPayload, ActorListPayload } from '@shared/contracts/actors';
import type { CombatListPayload } from '@shared/contracts/combats';
import type { ChatLogPayload } from '@shared/contracts/chat';
import type { RealtimeSharedContentPayload } from '@shared/contracts/realtime';

interface LoginPayload {
    success: boolean;
    token?: string;
    error?: string;
}

interface ChatSendPayload {
    success?: boolean;
    error?: string;
}

export function login(username: string, password?: string): Promise<LoginPayload> {
    return requestJson<LoginPayload>('/api/login', {
        method: 'POST',
        body: { username, password },
    });
}

export function logout(token: string | null): Promise<Record<string, unknown>> {
    return requestJson<Record<string, unknown>>('/api/logout', {
        method: 'POST',
        token,
    });
}

export function fetchStatus(token: string | null): Promise<Partial<AuthenticatedStatusPayload>> {
    return requestJson<Partial<AuthenticatedStatusPayload>>('/api/status', {
        token,
        cache: 'no-store',
    });
}

export function fetchSharedContent(token: string): Promise<RealtimeSharedContentPayload> {
    return requestJson<RealtimeSharedContentPayload>('/api/shared-content', {
        token,
        cache: 'no-store',
    });
}

export function fetchChatLog(token: string): Promise<ChatLogPayload> {
    return requestJson<ChatLogPayload>('/api/chat', { token });
}

export function sendChat(token: string | null, body: { message: string; rollMode?: string; speaker?: string }): Promise<ChatSendPayload> {
    return requestJson<ChatSendPayload>('/api/chat/send', {
        method: 'POST',
        token,
        body,
    });
}

export function fetchActors(token: string): Promise<ActorListPayload> {
    return requestJson<ActorListPayload>('/api/actors', { token });
}

export function fetchActorCards(token: string): Promise<ActorCardsPayload> {
    return requestJson<ActorCardsPayload>('/api/actors/cards', { token });
}

export function fetchActorCardById(token: string, actorId: string): Promise<import('@shared/sdk').ActorCardData> {
    return requestJson(`/api/actors/${actorId}/card`, { token });
}

export function fetchActorById(token: string, actorId: string): Promise<ActorDetailPayload> {
    return requestJson<ActorDetailPayload>(`/api/actors/${actorId}`, { token });
}

export function deleteActor(token: string | null, actorId: string): Promise<Record<string, unknown>> {
    return requestJson<Record<string, unknown>>(`/api/actors/${actorId}`, {
        method: 'DELETE',
        token,
    });
}

export function fetchCombats(token: string): Promise<CombatListPayload> {
    return requestJson<CombatListPayload>('/api/combats', { token });
}
