import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCollisionAudio, normalizeDiceSound, type CollisionAudioTarget } from '../../../client/ui/components/Dice/collisionAudio';

export async function run() {
    assert.deepEqual(normalizeDiceSound(null), { enabled: false, volume: 50 });
    assert.deepEqual(normalizeDiceSound({ enabled: 'true', volume: NaN }), { enabled: false, volume: 50 });
    assert.equal(normalizeDiceSound({ volume: -1 }).volume, 0);
    assert.equal(normalizeDiceSound({ volume: 120 }).volume, 100);
    assert.equal(normalizeDiceSound({ volume: 24.6 }).volume, 25);
    const target: CollisionAudioTarget = { sounds: false, volume: 100, surface: 'felt', sound_dieMaterial: 'plastic', sounds_table: {}, sounds_dice: {} };
    const clips: { src: string; preload: string; readyState: number; volume: number; played: number; paused: number; released: boolean; blocked: boolean; load(): void; removeAttribute(): void; pause(): void; play(): Promise<void> }[] = [];
    const controller = createCollisionAudio(target, src => {
        const clip = {
            src, preload: '' as HTMLMediaElement['preload'], readyState: 2, volume: 1, played: 0, paused: 0, released: false, blocked: false,
            load() {}, removeAttribute() { this.released = true; }, pause() { this.paused++; },
            async play() { if (this.blocked) throw new Error('Autoplay denied'); this.played++; },
        };
        clips.push(clip);
        return clip;
    });
    controller.update({ enabled: false, volume: 50 });
    assert.equal(clips.length, 0, 'no audio downloads while disabled');
    controller.update({ enabled: true, volume: 0 });
    assert.equal(clips.length, 0, 'no audio downloads at zero volume');
    controller.update({ enabled: true, volume: 50 });
    assert.equal(clips.length, 22);
    for (const clip of clips) assert.ok(existsSync(resolve('public', clip.src.slice(1))), clip.src);
    const voice = target.sounds_table.felt[0];
    voice.volume = 0.4;
    await voice.play();
    assert.equal(clips[0].volume, 0.2, 'scale impact volume rather than merely cap it');
    controller.update({ enabled: true, volume: 25 });
    assert.equal(clips[0].volume, 0.1, 'volume changes apply immediately');
    controller.update({ enabled: false, volume: 25 });
    assert.equal(target.sounds, false);
    assert.ok(clips.every(clip => clip.paused > 0));
    await voice.play();
    assert.equal(clips[0].played, 1, 'muted callbacks cannot play');
    controller.update({ enabled: true, volume: 50 });
    assert.equal(clips.length, 22, 'reuse clips within a throw');
    clips[0].readyState = 0;
    await voice.play();
    assert.equal(clips[0].played, 1, 'unready/missing clips never block a throw');
    clips[0].readyState = 2;
    clips[0].blocked = true;
    await assert.doesNotReject(() => voice.play());
    controller.dispose();
    assert.ok(clips.every(clip => clip.released));
    assert.deepEqual(target.sounds_table, {});
    assert.deepEqual(target.sounds_dice, {});
    clips[0].blocked = false;
    await voice.play();
    controller.update({ enabled: true, volume: 50 });
    assert.equal(clips[0].played, 1, 'late callbacks cannot play after teardown');
    assert.equal(target.sounds, false);
}
