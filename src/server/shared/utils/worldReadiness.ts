/**
 * World-readiness gate for route-level module service calls (ADR-0027 decision 25).
 *
 * Server-service calls made from a module route block until the world is ready
 * (ADR-0017) rather than racing an unready world. `not_ready` is raised only when
 * readiness cannot be reached within the bounded wait — i.e. the world is genuinely
 * unreachable, not merely mid-bootstrap.
 *
 * This is intentionally NOT applied to the adapter's base runtime: `adapter.initialize`
 * runs during bootstrap, so gating its reads on world readiness would deadlock.
 */
import { SdkError } from '@shared/sdk';
import { systemService } from '@server/services/world';

const DEFAULT_READY_TIMEOUT_MS = 10_000;

export async function awaitWorldReady(timeoutMs = DEFAULT_READY_TIMEOUT_MS): Promise<void> {
    if (systemService.isReady()) return;

    await new Promise<void>((resolve, reject) => {
        const onReady = () => {
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(() => {
            systemService.off('world:ready', onReady);
            reject(new SdkError('not_ready', 'World is not ready (readiness could not be reached)'));
        }, timeoutMs);

        systemService.once('world:ready', onReady);

        // Guard against the world becoming ready between the initial check and the
        // listener being attached.
        if (systemService.isReady()) {
            clearTimeout(timer);
            systemService.off('world:ready', onReady);
            resolve();
        }
    });
}
