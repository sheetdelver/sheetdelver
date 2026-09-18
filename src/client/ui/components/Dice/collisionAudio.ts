export interface DiceSoundSettings {
    enabled: boolean;
    volume: number;
}

export const defaultDiceSound: DiceSoundSettings = { enabled: false, volume: 50 };

export function normalizeDiceSound(value: unknown): DiceSoundSettings {
    const data = value && typeof value === 'object' ? value as Partial<DiceSoundSettings> : {};
    return {
        enabled: data.enabled === true,
        volume: typeof data.volume === 'number' && Number.isFinite(data.volume)
            ? Math.max(0, Math.min(100, Math.round(data.volume))) : defaultDiceSound.volume,
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

/** Keep upstream collision timing; load only the local felt/plastic clips we use. */
export function createCollisionAudio(target: CollisionAudioTarget, createAudio: (src: string) => AudioElement = src => new Audio(src)) {
    let settings = defaultDiceSound;
    let disposed = false;
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
            target.sounds = settings.enabled && settings.volume > 0;
            target.volume = 100;
            if (target.sounds && !clips.length) {
                target.surface = 'felt';
                target.sound_dieMaterial = 'plastic';
                target.sounds_table.felt = Array.from({ length: 7 }, (_, i) => createVoice(`surfaces/surface_felt${i + 1}`));
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
