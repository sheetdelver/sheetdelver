import type DiceBox from '@3d-dice/dice-box-threejs';

export type DieMaterial = { opacity: number; dispose(): void };
export type SceneDie = {
    body: { sleepState: number; type: number };
    result: unknown[];
    geometry: { cannon_shape?: unknown; dispose(): void };
    material: DieMaterial | DieMaterial[];
    storeRolledValue(reason?: string): void;
    getFaceValue(): { value: number };
};
export type SceneBox = DiceBox & {
    initialized: boolean;
    rolling: boolean;
    last_time: number;
    iteration: number;
    diceList: SceneDie[];
    startClickThrow(notation: string): { vectors: unknown[]; result?: number[]; error?: string };
    spawnDice(vector: unknown, die?: SceneDie): void;
    simulateThrow(): void;
    animstate: string;
    world: {
        removeBody(body: SceneDie['body']): void;
        addBody(body: SceneDie['body']): void;
        broadphase: {
            collisionPairs(world: unknown, left: SceneDie['body'][], right: SceneDie['body'][]): void;
        };
    };
    scene: DiceBox['scene'] & { remove(die: SceneDie): void };
    camera: NonNullable<DiceBox['camera']>;
    eventCollide(event: { target?: object }): void;
};

/** Separate independent chat-message throws without limiting same-throw collisions. */
export function isolateThrowCollisions(box: SceneBox, groupForBody: WeakMap<object, number>) {
    const broadphase = box.world.broadphase;
    const original = broadphase.collisionPairs.bind(broadphase);
    broadphase.collisionPairs = (world, left, right) => {
        original(world, left, right);
        let keep = 0;
        for (let i = 0; i < left.length; i++) {
            const a = groupForBody.get(left[i]);
            const b = groupForBody.get(right[i]);
            if (a !== undefined && b !== undefined && a !== b) continue;
            left[keep] = left[i];
            right[keep] = right[i];
            keep++;
        }
        left.length = right.length = keep;
    };
}

/** Pre-simulate only the new dice, then reset them before their first visible frame. */
export function appendRecordedDice(box: SceneBox, notation: string, count: number) {
    const wasRolling = box.rolling;
    box.rolling = false;
    let vectors: ReturnType<SceneBox['startClickThrow']>;
    try { vectors = box.startClickThrow(notation); }
    finally { box.rolling = wasRolling; }
    if (vectors.error || !Number.isInteger(count) || !count || vectors.vectors.length !== count
        || vectors.result?.length !== count) throw new Error('Shared dice notation did not match recorded faces.');
    const faces = vectors.result.map(Number);
    if (faces.some(face => !Number.isInteger(face))) throw new Error('Shared dice notation had invalid recorded faces.');
    const existing = box.diceList;
    const previousIteration = box.iteration;
    const previousAnimstate = box.animstate;
    let dice: SceneDie[] = [];
    for (const die of existing) box.world.removeBody(die.body);
    box.diceList = [];
    try {
        for (const vector of vectors.vectors) box.spawnDice(vector);
        dice = box.diceList;
        if (dice.length !== count) throw new Error('Shared dice scene could not create all physical dice.');
        // The pinned renderer's own rollDice() predicts the landing, swaps face
        // labels, then re-spawns each die before animation. Isolate this group
        // so an in-flight throw is not stepped by the prediction.
        box.simulateThrow();
        for (let i = 0; i < dice.length; i++) {
            const die = dice[i];
            if (die.getFaceValue().value !== faces[i]) box.swapDiceFace(die, faces[i]);
            box.spawnDice(vectors.vectors[i], die);
            die.result = [];
        }
        return { dice, faces, wasRolling };
    } finally {
        box.diceList = [...existing, ...dice];
        for (const die of existing) box.world.addBody(die.body);
        box.rolling = wasRolling;
        box.iteration = previousIteration;
        box.animstate = previousAnimstate;
    }
}

/** Finish only when the replayed die actually landed on its recorded face. */
export function completeRecordedDieFace(die: SceneDie, face: number) {
    if (die.getFaceValue().value !== face) return false;
    if (!die.result.length) die.storeRolledValue('forced');
    die.body.type = 4; // cannon-es Body.KINEMATIC in the pinned renderer.
    return true;
}
