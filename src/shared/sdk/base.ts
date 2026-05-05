import { ModuleContext } from './context';
import { ModuleFoundryClient } from './contracts';
import {
    SystemAdapter,
    ActorSheetData,
    ActorCardData,
    DiscoveryConfig,
    RollMode,
    RollData,
    RollDataOptions,
    SystemThemeColors,
    SystemComponentStyles,
    FoundryActor,
    FoundryItem,
} from './interfaces';
import { CompendiumCache } from './context';

/**
 * BaseSystemAdapter provides default implementations of the SystemAdapter interface.
 * Modules should extend this class.
 *
 * It also serves as the platform's internal fallback adapter (systemId = 'generic'),
 * used when no matching system module is found for an actor.
 */
export class BaseSystemAdapter implements SystemAdapter {
    systemId = 'generic';

    protected _context: ModuleContext | null = null;

    normalizeActorData(actor: FoundryActor, _client?: ModuleFoundryClient): ActorSheetData {
        return {
            id: actor._id,
            name: actor.name,
            type: actor.type,
            img: actor.img ?? '',
            system: actor.system ?? {},
            items: actor.items ?? [],
            effects: actor.effects ?? [],
            derived: {},
        };
    }

    match(_actor: FoundryActor): boolean {
        // Never matches specifically — only used as the fallback
        return false;
    }

    async initialize(context: ModuleContext): Promise<void> {
        this._context = context;
    }

    async getSystemData(_client: ModuleFoundryClient, _options?: { minimal?: boolean }): Promise<unknown> {
        return {};
    }

    getDiscoveryConfig(): DiscoveryConfig {
        return { packs: [] };
    }

    getActorCardData(actor: FoundryActor): ActorCardData {
        return {
            name: actor.name,
            img: actor.img ?? undefined,
        };
    }

    computeActorData(_actor: ActorSheetData): Record<string, unknown> {
        return {};
    }

    categorizeItems(actor: ActorSheetData): Record<string, FoundryItem[]> {
        return { all: actor.items ?? [] };
    }

    getRollData(_actor: FoundryActor, _type: string, _key: string, _options?: RollDataOptions): RollData | null {
        return null;
    }

    async performAutomatedSequence(_client: ModuleFoundryClient, _actor: FoundryActor, _rollData: RollData, _options: unknown): Promise<unknown> {
        return null;
    }

    resolveActorNames(_actor: FoundryActor, _cache: CompendiumCache): void {
        // noop
    }

    getInitiativeFormula(_actor: FoundryActor): string {
        return '1d20';
    }

    validateUpdate(_path: string, _value: unknown): boolean {
        return true;
    }

    theme?: SystemThemeColors;
    componentStyles?: SystemComponentStyles;
}
