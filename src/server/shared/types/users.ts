/**
 * Foundry User document shape as it appears on the wire and in `game.data.users`.
 *
 * Note: Foundry's User document has no `active` field. Presence/activity is runtime
 * state delivered through `userConnected` / `userDisconnected` / `userActivity` socket
 * events, not document fields. Sheet Delver historically mixed presence into the
 * user record; that lives in a separate presence map now.
 */
export interface UserDocument {
    _id?: string;
    id?: string;
    name?: string;
    role?: number;
    color?: string;
    avatar?: string;
    img?: string;
    character?: string | { id?: string; _id?: string } | null;
    permissions?: Record<string, unknown>;
    pronouns?: string;
    hotbar?: unknown;
    flags?: Record<string, unknown>;
    _stats?: Record<string, unknown>;
    [key: string]: unknown;
}

export type UserWithPresence = UserDocument & {
    active: boolean;
};
