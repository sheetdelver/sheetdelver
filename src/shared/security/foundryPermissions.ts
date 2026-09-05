import { UserRole } from '@shared/constants';

/**
 * Actor documents inherit Foundry's base delete permission in v13 and v14.
 * That permission requires an Assistant or Gamemaster role; document ownership
 * controls updates but does not lower this delete threshold.
 */
export function canRoleDeleteActors(role: unknown): boolean {
    return typeof role === 'number' && role >= UserRole.ASSISTANT;
}
