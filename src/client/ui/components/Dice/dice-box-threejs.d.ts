declare module '@3d-dice/dice-box-threejs' {
    export default class DiceBox {
        constructor(selector: string, options: Record<string, unknown>);
        initialize(): Promise<void>;
        roll(notation: string): Promise<unknown>;
        resizeWorld(): void;
        setDimensions(dimensions?: unknown): void;
        swapDiceFace(die: { result: unknown[] }, value: number): void;
        sounds: boolean;
        volume: number;
        surface: string;
        sound_dieMaterial: string;
        sounds_table: Record<string, { volume: number; play(): Promise<void> }[]>;
        sounds_dice: Record<string, { volume: number; play(): Promise<void> }[]>;
        running: boolean | number;
        animateThrow: (...args: unknown[]) => void;
        animateAfterThrow: (...args: unknown[]) => void;
        DiceColors: { getTexture(name: string): { material?: string; texture?: unknown; bump?: unknown } };
        camera?: { zoom: number; updateProjectionMatrix(): void };
        light?: { shadow: { map?: Disposable | null; mapSize: { width: number; height: number } } };
        scene: { traverse(visitor: (object: {
            geometry?: Disposable;
            material?: Material | Material[];
            shadow?: { map?: Disposable };
        }) => void): void; clear(): void };
        renderer?: {
            render: (...args: unknown[]) => void;
            dispose(): void;
            forceContextLoss(): void;
            setPixelRatio(ratio: number): void;
            domElement: HTMLCanvasElement;
        };
        DiceFactory: {
            setBumpMapping(enabled: boolean): void;
            geometries: Record<string, Disposable>;
            materials_cache: Record<string, { composite?: Disposable; bump?: Disposable }>;
        };
    }
    interface Disposable { dispose(): void }
    interface Material extends Disposable { map?: Disposable; bumpMap?: Disposable }
}
