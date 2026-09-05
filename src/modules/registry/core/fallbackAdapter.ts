import { BaseSystemAdapter } from '@shared/sdk/base';
import type { SystemAdapter } from './types';

class FallbackAdapter extends BaseSystemAdapter {
    systemId = 'generic';
}

// Internal platform fallback adapter. It is not a discoverable plugin and
// cannot be disabled.
export const FALLBACK_ADAPTER: SystemAdapter = new FallbackAdapter();
