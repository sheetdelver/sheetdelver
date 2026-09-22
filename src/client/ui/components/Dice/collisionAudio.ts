export interface DiceSoundSettings {
    enabled: boolean;
    volume: number;
    surface?: keyof typeof diceSurfaces;
}

export const diceSurfaces = {
    felt: { label: 'Felt', clips: 7 }, wood_table: { label: 'Wood table', clips: 7 },
    wood_tray: { label: 'Wood tray', clips: 7 }, metal: { label: 'Metal', clips: 9 },
} as const;

export const defaultDiceSound: DiceSoundSettings = { enabled: false, volume: 50 };

export function normalizeDiceSound(value: unknown): DiceSoundSettings {
    const data = value && typeof value === 'object' ? value as Partial<DiceSoundSettings> : {};
    return {
        enabled: data.enabled === true,
        volume: typeof data.volume === 'number' && Number.isFinite(data.volume)
            ? Math.max(0, Math.min(100, Math.round(data.volume))) : defaultDiceSound.volume,
        ...(data.surface && Object.hasOwn(diceSurfaces, data.surface) ? { surface: data.surface } : {}),
    };
}

interface CollisionVoice {
    volume: number;
    play(): Promise<void>;
}

export interface CollisionAudioTarget {
    sounds: boolean;
    volume: number;
    surface: string;
    sound_dieMaterial: string;
    sounds_table: Record<string, CollisionVoice[]>;
    sounds_dice: Record<string, CollisionVoice[]>;
}

type AudioElement = Pick<HTMLAudioElement, 'preload' | 'readyState' | 'volume' | 'play' | 'pause' | 'removeAttribute' | 'load'>;

/** Keep collision timing; lazily load only the selected local surface and plastic clips. */
export function createCollisionAudio(target: CollisionAudioTarget, createAudio: (src: string) => AudioElement = src => new Audio(src)) {
    let settings = defaultDiceSound;
    let disposed = false;
    let surface: keyof typeof diceSurfaces | undefined;
    const clips: { audio: AudioElement; voice: CollisionVoice }[] = [];

    const createVoice = (path: string): CollisionVoice => {
        const audio = createAudio(`/dice/sounds/${path}.mp3`);
        audio.preload = 'auto';
        const voice: CollisionVoice = {
            volume: 1,
            async play() {
                // Skip unready/blocked audio rather than delaying or replaying a collision later.
                if (disposed || !settings.enabled || settings.volume === 0 || audio.readyState < 2) return;
                audio.volume = voice.volume * settings.volume / 100;
                try { await audio.play(); } catch { /* Autoplay policy or unavailable audio: remain silent. */ }
            },
        };
        clips.push({ audio, voice });
        audio.load();
        return voice;
    };

    return {
        update(value: DiceSoundSettings) {
            if (disposed) return;
            settings = normalizeDiceSound(value);
            surface ??= settings.surface ?? 'felt';
            target.sounds = settings.enabled && settings.volume > 0;
            target.volume = 100;
            if (target.sounds && !clips.length) {
                target.surface = surface;
                target.sound_dieMaterial = 'plastic';
                target.sounds_table[surface] = Array.from({ length: diceSurfaces[surface].clips }, (_, i) => createVoice(`surfaces/surface_${surface}${i + 1}`));
                target.sounds_dice.plastic = Array.from({ length: 15 }, (_, i) => createVoice(`dicehit/dicehit_plastic${i + 1}`));
            }
            for (const { audio, voice } of clips) {
                audio.volume = voice.volume * settings.volume / 100;
                if (!target.sounds) audio.pause();
            }
        },
        dispose() {
            disposed = true;
            target.sounds = false;
            for (const { audio } of clips) {
                audio.pause();
                audio.removeAttribute('src');
                audio.load();
            }
            clips.length = 0;
            target.sounds_table = {};
            target.sounds_dice = {};
        },
    };
}
