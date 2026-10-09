import { requestJson } from '@client/ui/api/http';
import type { AuthenticatedStatusPayload } from '@shared/contracts/status';
import type { User } from '@shared/interfaces';
import type { ActorCardsPayload, ActorDetailPayload, ActorListPayload } from '@shared/contracts/actors';
import type {
    CombatListPayload,
    CombatTurnSuccessPayload,
    CombatInitiativeSuccessPayload,
    CombatInitiativeRequestBody,
} from '@shared/contracts/combats';
import type { ChatLogPayload } from '@shared/contracts/chat';
import type { RealtimeSharedContentPayload } from '@shared/contracts/realtime';
import type { CombatManagerActorSearchDto, CombatManagerActorSortRequest, CombatManagerEncounterDto, CombatManagerInitiativeBatchDto,
    CombatManagerInitiativeResetDto,
    CombatManagerResourceUpdateRequest, CombatManagerSelectedStatDto, CombatManagerStatPreferencesDto, CombatManagerStatUpdateRequest,
    CombatManagerInitiativeScope, CombatManagerPackDto } from '@shared/contracts/combatManager';

interface LoginPayload {
    success: boolean;
    userId?: string;
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

/** Protected, non-cacheable authority and identity check for player recovery. */
export function fetchSessionUsers(): Promise<{ users: User[]; currentUserId: string | null }> {
    return requestJson('/api/session/users', { cache: 'no-store' });
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

// Combat actions (ADR-0028): typed helpers via requestJson so non-2xx
// responses throw ApiError instead of being silently treated as success.
export function postCombatNextTurn(token: string | null, combatId: string): Promise<CombatTurnSuccessPayload> {
    return requestJson<CombatTurnSuccessPayload>(`/api/combats/${combatId}/next-turn`, {
        method: 'POST',
        token,
    });
}

export function postCombatPreviousTurn(token: string | null, combatId: string): Promise<CombatTurnSuccessPayload> {
    return requestJson<CombatTurnSuccessPayload>(`/api/combats/${combatId}/previous-turn`, {
        method: 'POST',
        token,
    });
}

export function postCombatRollInitiative(
    token: string | null,
    combatId: string,
    combatantId: string,
    body: CombatInitiativeRequestBody,
): Promise<CombatInitiativeSuccessPayload> {
    return requestJson<CombatInitiativeSuccessPayload>(
        `/api/combats/${combatId}/combatants/${combatantId}/roll-initiative`,
        { method: 'POST', token, body },
    );
}

export function fetchManagedCombats(): Promise<{ encounters: CombatManagerEncounterDto[] }> {
    return requestJson('/api/combat-manager', { cache: 'no-store' });
}

export function fetchManagedStatPreferences(actorId?: string, includeCatalog = false): Promise<{ preferences: CombatManagerStatPreferencesDto }> {
    const params = new URLSearchParams();
    if (actorId) params.set('actorId', actorId);
    if (includeCatalog) params.set('catalog', '1');
    const query = params.size ? `?${params}` : '';
    return requestJson(`/api/combat-manager/stat-preferences${query}`, { cache: 'no-store' });
}

export function saveManagedStatPreferences(attributes: CombatManagerSelectedStatDto[]): Promise<{ preferences: CombatManagerStatPreferencesDto }> {
    return requestJson('/api/combat-manager/stat-preferences', { method: 'PUT', body: { attributes } });
}

export function resetManagedStatPreferences(): Promise<{ preferences: CombatManagerStatPreferencesDto }> {
    return requestJson('/api/combat-manager/stat-preferences', { method: 'DELETE' });
}

export function createManagedCombat(label: string, keepHistory: boolean): Promise<{ encounter: CombatManagerEncounterDto }> {
    return requestJson('/api/combat-manager', { method: 'POST', body: { label, keepHistory } });
}

export function searchManagedWorldActors(query: string, sort: CombatManagerActorSortRequest): Promise<CombatManagerActorSearchDto> {
    const params = new URLSearchParams({ q: query, sort: JSON.stringify(sort) });
    return requestJson(`/api/combat-manager/world-actors?${params}`, { cache: 'no-store' });
}

export function fetchManagedActorPacks(): Promise<{ packs: CombatManagerPackDto[] }> {
    return requestJson('/api/combat-manager/packs', { cache: 'no-store' });
}

export function searchManagedPackActors(packId: string, query: string, sort: CombatManagerActorSortRequest): Promise<CombatManagerActorSearchDto> {
    const params = new URLSearchParams({ q: query, sort: JSON.stringify(sort) });
    return requestJson(`/api/combat-manager/packs/${encodeURIComponent(packId)}/actors?${params}`, { cache: 'no-store' });
}

export function addManagedWorldActor(combatId: string, actorId: string): Promise<{ encounter: CombatManagerEncounterDto }> {
    return requestJson(`/api/combat-manager/${combatId}/world-actors`, { method: 'POST', body: { actorId } });
}

export function addManagedPackActor(combatId: string, packId: string, actorId: string,
    quantity: number): Promise<{ encounter: CombatManagerEncounterDto }> {
    return requestJson(`/api/combat-manager/${combatId}/pack-actors`, { method: 'POST', body: { packId, actorId, quantity } });
}

export function updateManagedCombatant(combatId: string, combatantId: string,
    body: { initiative?: number | null; expectedInitiative?: number | null; hidden?: boolean; defeated?: boolean }): Promise<{ encounter: CombatManagerEncounterDto }> {
    return requestJson(`/api/combat-manager/${combatId}/combatants/${combatantId}`, { method: 'PATCH', body });
}

export function updateManagedResource(combatId: string, combatantId: string,
    body: CombatManagerResourceUpdateRequest): Promise<{ encounter: CombatManagerEncounterDto }> {
    return requestJson(`/api/combat-manager/${combatId}/combatants/${combatantId}/resource`, { method: 'PATCH', body });
}

export function updateManagedStat(combatId: string, combatantId: string, statKey: string,
    body: CombatManagerStatUpdateRequest): Promise<{ encounter: CombatManagerEncounterDto }> {
    return requestJson(`/api/combat-manager/${combatId}/combatants/${combatantId}/stats/${encodeURIComponent(statKey)}`,
        { method: 'PATCH', body });
}

export function removeManagedCombatant(combatId: string, combatantId: string): Promise<{ encounter: CombatManagerEncounterDto }> {
    return requestJson(`/api/combat-manager/${combatId}/combatants/${combatantId}`, { method: 'DELETE' });
}

export function completeManagedCombat(combatId: string): Promise<{ completed: true; retained: boolean }> {
    return requestJson(`/api/combat-manager/${combatId}/complete`, { method: 'POST' });
}

export function deleteManagedCombat(combatId: string): Promise<{ deleted: true }> {
    return requestJson(`/api/combat-manager/${combatId}`, { method: 'DELETE' });
}

export function postManagedNextTurn(combatId: string): Promise<CombatTurnSuccessPayload> {
    return requestJson(`/api/combat-manager/${combatId}/next-turn`, { method: 'POST' });
}

export function postManagedPreviousTurn(combatId: string): Promise<CombatTurnSuccessPayload> {
    return requestJson(`/api/combat-manager/${combatId}/previous-turn`, { method: 'POST' });
}

export function postManagedInitiativeBatch(combatId: string, scope: CombatManagerInitiativeScope): Promise<CombatManagerInitiativeBatchDto> {
    return requestJson(`/api/combat-manager/${combatId}/roll-initiative`, { method: 'POST', body: { scope } });
}

export function postManagedInitiativeOne(combatId: string, combatantId: string): Promise<CombatManagerInitiativeBatchDto> {
    return requestJson(`/api/combat-manager/${combatId}/combatants/${combatantId}/roll-initiative`, { method: 'POST' });
}

export function postManagedInitiativeReset(combatId: string): Promise<CombatManagerInitiativeResetDto> {
    return requestJson(`/api/combat-manager/${combatId}/reset-initiative`, { method: 'POST' });
}
