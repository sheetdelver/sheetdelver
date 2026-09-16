import { ModuleRuntime } from './runtime';
import { setModuleLogSink } from './logging';
import { resolveImage } from './utils';
import {
    SystemAdapter,
    ActorSheetData,
    ActorPreparationContext,
    ActorCardData,
    CompendiumPackConfig,
    RollData,
    RollDataOptions,
    SystemThemeColors,
    SystemComponentStyles,
    FoundryActor,
    FoundryItem,
    PreparedActorData,
} from './interfaces';

/**
 * BaseSystemAdapter provides default implementations of the SystemAdapter interface.
 * Modules should extend this class.
 *
 * It also serves as the platform's internal fallback adapter (systemId = 'generic'),
 * used when no matching system module is found for an actor.
 */
export class BaseSystemAdapter implements SystemAdapter {
    systemId = 'generic';

    protected _runtime: ModuleRuntime | null = null;

    /** Base URL of the connected Foundry server. Available after initialize() is called. */
    protected get foundryUrl(): string {
        return this._runtime?.foundryUrl ?? '';
    }

    normalizeActorData(actor: FoundryActor): ActorSheetData {
        return {
            id: actor._id,
            name: actor.name,
            type: actor.type,
            img: resolveImage(actor.img ?? '', this.foundryUrl),
            system: actor.system ?? {},
            items: actor.items ?? [],
            effects: actor.effects ?? [],
            derived: {},
        };
    }

    prepareActorData(
        actor: FoundryActor,
        _context: Readonly<ActorPreparationContext>,
    ): PreparedActorData {
        const normalized = this.normalizeActorData(actor);
        const derived = this.computeActorData(normalized);

        const prepared: PreparedActorData = {
            ...actor,
            ...normalized,
            _id: actor._id,
            id: normalized.id || actor._id,
            name: normalized.name || actor.name,
            type: normalized.type || actor.type,
            img: normalized.img || resolveImage(actor.img ?? '', this.foundryUrl),
            system: normalized.system ?? actor.system ?? {},
            items: normalized.items ?? actor.items ?? [],
            effects: normalized.effects ?? actor.effects ?? [],
            derived: {
                ...(normalized.derived ?? {}),
                ...derived,
            },
        };
        prepared.categorizedItems = this.categorizeItems(prepared);
        return prepared;
    }

    match(_actor: FoundryActor): boolean {
        // Never matches specifically — only used as the fallback
        return false;
    }

    async initialize(runtime: ModuleRuntime): Promise<void> {
        this._runtime = runtime;
        // Route the module's SDK logger (`logger` / `createModuleLogger`, incl. pure
        // logic files) through the platform logger — module-prefixed + level-controlled.
        setModuleLogSink(runtime.logger);
    }

    async getSystemData(_options?: { minimal?: boolean }): Promise<unknown> {
        return {};
    }

    getCompendiumPackConfig(): CompendiumPackConfig {
        return { packs: [] };
    }

    getActorCardData(actor: FoundryActor): ActorCardData {
        return {
            name: actor.name,
            img: resolveImage(actor.img ?? '', this.foundryUrl),
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

    getInitiativeFormula(_actor: FoundryActor): string {
        return '1d20';
    }

    validateUpdate(_path: string, _value: unknown): boolean {
        return true;
    }

    theme?: SystemThemeColors;
    componentStyles?: SystemComponentStyles;
}
