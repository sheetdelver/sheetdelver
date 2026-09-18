import type DiceBox from '@3d-dice/dice-box-threejs';

/** May run again after a cancelled initialization finishes allocating resources. */
export function createRendererDisposer(box: DiceBox): () => void {
    const disposed = new WeakSet<object>();
    const release = (resource?: { dispose(): void }) => {
        if (!resource || disposed.has(resource)) return;
        disposed.add(resource);
        resource.dispose();
    };
    return () => {
        // Queued upstream callbacks must not resurrect rendering after teardown.
        box.running = false;
        box.animateThrow = () => {};
        box.animateAfterThrow = () => {};
        if (box.renderer) box.renderer.render = () => {};
        box.scene.traverse(object => {
            release(object.geometry);
            release(object.shadow?.map);
            for (const material of !object.material ? [] : Array.isArray(object.material) ? object.material : [object.material]) {
                release(material.map);
                release(material.bumpMap);
                release(material);
            }
        });
        Object.values(box.DiceFactory.geometries).forEach(release);
        Object.values(box.DiceFactory.materials_cache).forEach(cache => {
            release(cache.composite);
            release(cache.bump);
        });
        box.scene.clear();
        if (box.renderer && !disposed.has(box.renderer)) {
            release(box.renderer);
            box.renderer.forceContextLoss();
            box.renderer.domElement.remove();
        }
    };
}
