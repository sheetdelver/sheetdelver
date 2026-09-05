import { usePathname } from 'next/navigation';
import { logger } from '@shared/utils/logger';

/**
 * Detect which runtime surface the current route belongs to.
 * Used for defensive guards in player-only contexts.
 */
export function useRuntimeSurface() {
  const pathname = usePathname();

  if (pathname.startsWith('/admin')) {
    return 'admin';
  }

  return 'player';
}

/**
 * Assert that we're running on the player surface.
 * Used defensively to catch composition errors if player contexts are mounted in wrong places.
 */
export function assertPlayerSurface() {
  if (typeof window === 'undefined') return; // Skip on server

  const pathname = window.location.pathname;
  if (pathname.startsWith('/admin')) {
    logger.warn('[Player Runtime Guard] Player context accessed on admin surface. This indicates a composition error.', {
      pathname,
      stack: new Error().stack,
    });
  }
}
