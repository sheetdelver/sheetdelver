import type { ComponentType } from 'react';
import type { DisplayArtworkRuntime } from './displayArtwork';
import type { SystemComponentStyles } from './interfaces';

export type CompendiumReferenceType = 'Actor' | 'Item';
export interface CompendiumReferenceIdentity {
    uuid: string;
    documentType: CompendiumReferenceType;
}
/** The original caller-readable compendium source, never the encounter copy. */
export interface CompendiumReferenceContext extends CompendiumReferenceIdentity {
    document: Readonly<Record<string, unknown>>;
}
export type CompendiumReferenceRuntime = DisplayArtworkRuntime;
/** JSON-serializable presentation data. No source mutation or action intents. */
export interface CompendiumReferenceModel { title: string; model: unknown }
export interface CompendiumReferenceViewProps {
    reference: CompendiumReferenceIdentity;
    model: unknown;
}
/** Trusted module content inside Core's accessible dialog; do not mount a modal
 * or action controller here. Registration does not grant source access. */
export interface CompendiumReferenceViewer {
    load: () => Promise<{ default: ComponentType<CompendiumReferenceViewProps> }>;
    dialog?: SystemComponentStyles['rollDialog'];
}
