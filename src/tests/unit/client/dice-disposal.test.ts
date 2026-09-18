import assert from 'node:assert/strict';
import type DiceBox from '@3d-dice/dice-box-threejs';
import { createRendererDisposer } from '../../../client/ui/components/Dice/disposeRenderer';

export function run() {
    const resource = () => ({ calls: 0, dispose() { this.calls++; } });
    const geometry = resource(), texture = resource(), shadow = resource();
    const material = { ...resource(), map: texture, bumpMap: texture };
    let nodes: any[] = [{ geometry, material: [material, material], shadow: { map: shadow } }];
    let rendered = 0, lost = 0, removed = 0;
    const renderer = { ...resource(), render() { rendered++; }, forceContextLoss() { lost++; }, domElement: { remove() { removed++; } } };
    const box = {
        running: true,
        animateThrow() { rendered++; }, animateAfterThrow() { rendered++; },
        scene: { traverse(visitor: (node: any) => void) { nodes.forEach(visitor); }, clear() { nodes = []; } },
        DiceFactory: { geometries: { first: geometry }, materials_cache: { first: { composite: texture } } },
        renderer,
    };
    const dispose = createRendererDisposer(box as unknown as DiceBox);
    dispose(); dispose();
    for (const value of [geometry, texture, material, shadow, renderer]) assert.equal(value.calls, 1);
    assert.equal(lost, 1); assert.equal(removed, 1);
    box.animateThrow(); box.animateAfterThrow(); renderer.render();
    assert.equal(rendered, 0, 'callbacks cannot render after disposal');
    assert.equal(box.running, false);
    const lateTexture = resource();
    box.DiceFactory.materials_cache.first.composite = lateTexture;
    dispose();
    assert.equal(lateTexture.calls, 1, 'late initialization resources are still released');
    assert.equal(renderer.calls, 1, 'late cleanup does not release old resources twice');
}
