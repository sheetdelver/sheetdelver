import assert from 'node:assert/strict';
import { appendRecordedDice, completeRecordedDieFace, isolateThrowCollisions, type SceneBox, type SceneDie }
    from '../../../client/ui/components/Dice/sharedRendererAdapter';

function die(initial: number): SceneDie {
    let face = initial;
    return {
        body: { sleepState: 2, type: 1 }, result: [],
        geometry: { dispose() {} }, material: { opacity: 1, dispose() {} },
        storeRolledValue() { this.result.push({ value: face }); },
        getFaceValue() { return { value: face }; },
        setFace(value: number) { face = value; },
    } as SceneDie;
}

export function run() {
    const first = die(2);
    const second = die(1);
    const activeBodies = new Set([first.body]);
    let resetCount = 0;
    const box = {
        rolling: true, animstate: 'throw', iteration: 27, diceList: [first],
        startClickThrow(notation: string) {
            assert.equal(box.rolling, false, 'vector generation must not clear the active throw');
            assert.equal(notation, '1d6@4');
            return { vectors: [{}], result: ['4'] };
        },
        spawnDice(_vector: unknown, mesh?: SceneDie) {
            if (mesh) {
                assert.equal(mesh, second);
                resetCount++;
                return;
            }
            box.diceList.push(second);
            activeBodies.add(second.body);
        },
        simulateThrow() {
            assert.deepEqual(box.diceList, [second], 'prediction only includes the new group');
            assert.deepEqual([...activeBodies], [second.body], 'existing bodies are detached while predicting');
            box.rolling = true;
            box.iteration = 100;
            box.animstate = 'simulate';
            (second as SceneDie & { setFace(value: number): void }).setFace(3);
            second.storeRolledValue();
        },
        swapDiceFace(mesh: SceneDie, face: number) { (mesh as SceneDie & { setFace(value: number): void }).setFace(face); },
        world: {
            removeBody(body: SceneDie['body']) { activeBodies.delete(body); },
            addBody(body: SceneDie['body']) { activeBodies.add(body); },
        },
    } as unknown as SceneBox;
    const appended = appendRecordedDice(box, '1d6@4', 1);
    assert.equal(appended.wasRolling, true);
    assert.equal(box.rolling, true, 'the active physics loop stays active after append');
    assert.equal(box.animstate, 'throw');
    assert.equal(box.iteration, 27);
    assert.equal(resetCount, 1, 'the die is reset before its visible first frame');
    assert.equal(activeBodies.has(first.body), true, 'the existing body is restored');
    assert.deepEqual(box.diceList, [first, second], 'append retains existing dice');
    assert.deepEqual(appended.faces, [4], 'renderer string faces are normalized to numbers');
    assert.equal(second.getFaceValue().value, 4, 'recorded face is assigned before playback');
    assert.deepEqual(second.result, [], 'pre-simulation result is cleared for the visible throw');
    assert.equal(completeRecordedDieFace(second, 4), true);
    assert.equal(second.getFaceValue().value, 4);
    assert.equal(second.body.type, 4, 'a settled die is frozen while other groups continue');
    assert.deepEqual(second.result, [{ value: 4 }], 'recorded geometry is captured after settlement');
    assert.equal(completeRecordedDieFace(second, 3), false, 'an incorrect landing is not swapped after settling');

    box.startClickThrow = () => { throw new Error('bad notation'); };
    assert.throws(() => appendRecordedDice(box, 'bad', 1), /bad notation/);
    assert.equal(box.rolling, true, 'vector-generation failure restores the active state');
    box.startClickThrow = () => ({ vectors: [{}], result: [4] });
    assert.throws(() => appendRecordedDice(box, '1d6@4', 2), /did not match recorded faces/);
    assert.equal(box.diceList.length, 2, 'invalid notation must not spawn a partial group');

    const third = die(4);
    const staticBody = { sleepState: 0, type: 0 };
    const groups = new WeakMap<object, number>([
        [first.body, 1], [second.body, 2], [third.body, 1],
    ]);
    const pairBox = {
        world: { broadphase: { collisionPairs(_world: unknown, left: object[], right: object[]) {
            left.push(first.body, first.body, first.body);
            right.push(second.body, third.body, staticBody);
        } } },
    } as unknown as SceneBox;
    isolateThrowCollisions(pairBox, groups);
    const left: SceneDie['body'][] = [], right: SceneDie['body'][] = [];
    pairBox.world.broadphase.collisionPairs(pairBox.world, left, right);
    assert.deepEqual(left, [first.body, first.body]);
    assert.deepEqual(right, [third.body, staticBody], 'same-throw and tray collisions remain');
}
