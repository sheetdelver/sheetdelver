/** Admin-only, explicitly reviewed scene cleanup; never player world data. */
export interface OrphanTokenReview {
    sceneId: string;
    sceneName: string;
    tokenId: string;
    tokenName: string;
    actorId: string;
    review: string;
}

export interface OrphanTokenCleanupResult {
    sceneId: string;
    tokenId: string;
    state: 'deleted' | 'not-deleted' | 'unconfirmed' | 'not-attempted';
    reason?: string;
}

export interface OrphanTokenCleanupResponse {
    results: OrphanTokenCleanupResult[];
}
