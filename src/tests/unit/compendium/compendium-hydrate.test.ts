import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import { CompendiumStore } from '@server/core/compendium/CompendiumStore';
import type {
    CompendiumIndexEntry,
    CompendiumPackCache,
    CompendiumPackDocument,
} from '@server/core/compendium/types';
import { CompendiumService, type CompendiumTransport } from '@server/services/compendium';
import type { CompendiumPackConfig } from '@shared/sdk';

interface EmitCall {
    event: string;
    payloads: unknown[];
}

class MemoryPackCache implements CompendiumPackCache {
    private readonly values = new Map<string, unknown>();

    public async get<T>(namespace: string, key: string): Promise<T | null> {
        const cacheKey = `${namespace}/${key}`;
        return this.values.has(cacheKey) ? this.values.get(cacheKey) as T : null;
    }

    public async set<T>(namespace: string, key: string, value: T): Promise<void> {
        this.values.set(`${namespace}/${key}`, value);
    }
}

class FakeTransport implements CompendiumTransport {
    public isConnected = true;
    public readonly calls: EmitCall[] = [];
    public handler: (event: string, payloads: unknown[]) => unknown = () => ({ result: [] });

    public async emitSocketEvent<T>(event: string, ...payloads: unknown[]): Promise<T> {
        this.calls.push({ event, payloads });
        return this.handler(event, payloads) as T;
    }

    public async dispatchDocumentSocket(): Promise<unknown> {
        return null;
    }
}

export async function run() {
    await runEmbeddedEffectChangeWithUnchangedIndex();
    await runPersistentManifestRequiresSourceValidation();
    await runDeclaredFieldsRevalidateWithoutIdentityChanges();
    await runDeclaredButAbsentPackIsSkippedWithoutTransport();
    await runHydrateFullDocumentsWhenStaleOrMissing();
    await runFailedRefreshRejectsWithoutPublishing();
    await runLateResponseCannotReplaceInvalidatedPack();
    console.log('  - CompendiumService.hydratePacks: all checks passed');
}

function packMetadata(packId: string) {
    return {
        id: packId,
        name: packId.split('.')[1] || packId,
        label: 'Synthetic Pack',
        type: 'Item',
        packageName: 'synthetic',
    };
}

function defaultIndex(): CompendiumIndexEntry[] {
    return [
        {
            _id: 'torch',
            uuid: 'Compendium.synthetic.items.Item.torch',
            name: 'Torch',
            type: 'Item',
            img: 'icons/synthetic-torch.svg',
        },
    ];
}

function fieldAwareIndex(): CompendiumIndexEntry[] {
    return [
        {
            _id: 'torch',
            uuid: 'Compendium.synthetic.items.Item.torch',
            name: 'Torch',
            'system.tier': 1,
        },
    ];
}

function compendiumPackConfig(fields?: string[]): CompendiumPackConfig {
    return {
        packs: [
            {
                id: 'synthetic.items',
                type: 'Item',
                hydrate: false,
                ...(fields ? { fields } : {}),
            },
        ],
    };
}

function computeHash(entries: unknown[], hydrate: boolean): string {
    const signatureString = entries
        .map(entry => {
            if (!entry || typeof entry !== 'object') return '';
            const row = entry as { _id?: unknown; id?: unknown; name?: unknown };
            return `${row._id || row.id}-${row.name}`;
        })
        .concat(hydrate ? ['HYDRATED'] : ['INDEXED'])
        .sort()
        .join('|');
    return crypto.createHash('md5').update(signatureString).digest('hex');
}

function createStore(): CompendiumStore {
    return new CompendiumStore(new MemoryPackCache());
}

// ADR-0075 replaces the old ID/name shortcut. Disk snapshots survive, but
// only a read of the declared data can establish freshness after startup.
async function runPersistentManifestRequiresSourceValidation() {
    const store = createStore();
    const transport = new FakeTransport();
    const rows = defaultIndex();

    store.setPackMetadata('synthetic.items', packMetadata('synthetic.items'));
    store.setPackIndex('synthetic.items', packMetadata('synthetic.items'), rows);
    await store.setManifest({
        systemId: 'synthetic-system',
        _instanceId: 'synthetic-instance',
        packs: {
            'synthetic.items': {
                id: 'synthetic.items',
                hash: computeHash(rows, false),
                lastUpdated: 1,
                rowCount: 1,
                hydrate: false,
            },
        },
    });
    await store.setPackRows('synthetic-system', 'synthetic.items', rows as CompendiumPackDocument[]);

    const service = new CompendiumService({ transport, store });
    transport.handler = () => ({result: rows});
    const result = await service.hydratePacks('synthetic-system', compendiumPackConfig());
    assert.equal(result.hydrated, 1, 'legacy hash is replaced after source validation');
    assert.equal(transport.calls.length, 1);
    const unchanged = await new CompendiumService({transport,store}).hydratePacks('synthetic-system', compendiumPackConfig());
    assert.equal(unchanged.skipped, 1, 'unchanged contents need no shard rewrite');
    assert.equal(transport.calls.length, 2, 'a new lifecycle still validates persisted contents');
    const calls = transport.calls.length;
    await store.findDocument('synthetic-system','synthetic.items','torch');
    await store.findAll('synthetic-system','Item');
    assert.equal(transport.calls.length,calls,'ordinary reads stay cache-only');
}

async function runDeclaredFieldsRevalidateWithoutIdentityChanges() {
    const store = createStore();
    const transport = new FakeTransport();
    const rows = defaultIndex();
    const fieldRows = fieldAwareIndex();

    store.setPackMetadata('synthetic.items', packMetadata('synthetic.items'));
    store.setPackIndex('synthetic.items', packMetadata('synthetic.items'), rows);

    transport.handler = (event, payloads) => {
        const op = (payloads[0] as { operation?: { indexFields?: readonly string[]; pack?: string } } | undefined)?.operation;
        if (event === 'modifyDocument' && op?.pack === 'synthetic.items' && Array.isArray(op.indexFields) && op.indexFields.length > 0) {
            return { result: fieldRows };
        }
        return { result: [] };
    };

    const service = new CompendiumService({ transport, store });
    await service.hydratePacks('synthetic-system', compendiumPackConfig(['system.tier', 'name']));

    // Field-aware fetch happened once.
    const fieldFetches = transport.calls.filter(call => {
        const op = (call.payloads[0] as { operation?: { indexFields?: readonly string[] } } | undefined)?.operation;
        return Array.isArray(op?.indexFields) && op!.indexFields!.length > 0;
    });
    assert.equal(fieldFetches.length, 1);

    assert.equal(
        store.getPackIndex('synthetic.items', { fields: ['system.tier', 'name'] })?.[0]?.['system.tier'],
        1,
    );
    assert.equal((await store.findDocument('synthetic-system', 'synthetic.items', 'torch'))?.['system.tier'], 1);
    fieldRows[0]['system.tier']=2;
    await service.hydratePacks('synthetic-system',compendiumPackConfig(['system.tier','name']));
    assert.equal((await store.findDocument('synthetic-system','synthetic.items','torch'))?.['system.tier'],2);
    assert.equal(transport.calls.length,2,'same-name field edits require a fresh field-aware read');
}

// Per ADR-0021 declared-but-absent policy: a module declares a pack that
// isn't in game.data.packs. The service logs and skips with no transport.
async function runDeclaredButAbsentPackIsSkippedWithoutTransport() {
    const store = createStore();
    const transport = new FakeTransport();
    // No setPackMetadata for 'synthetic.items' — the pack is absent.

    const service = new CompendiumService({ transport, store });
    const result = await service.hydratePacks('synthetic-system', compendiumPackConfig());

    assert.equal(result.missing, 1);
    assert.equal(result.hydrated, 0);
    assert.equal(result.skipped, 0);
    assert.equal(transport.calls.length, 0);
    assert.equal(await store.getManifest('synthetic-system'), null);
}

async function runHydrateFullDocumentsWhenStaleOrMissing() {
    const store = createStore();
    const transport = new FakeTransport();
    const index = defaultIndex();
    const fullDoc = { _id: 'torch', name: 'Torch', type: 'Item', system: { weight: 1 } };

    store.setPackMetadata('synthetic.items', packMetadata('synthetic.items'));

    transport.handler = (event, payloads) => {
        if (event === 'modifyDocument') {
            const op = (payloads[0] as { operation?: { pack?: string; index?: boolean; query?: unknown } } | undefined)?.operation;
            if (op?.pack === 'synthetic.items') {
                if (op.index === false) {
                    assert.deepEqual(op.query, {});
                    return { result: [fullDoc] };
                }
                return { result: index };
            }
        }
        return { result: [] };
    };

    const service = new CompendiumService({
        transport,
        store,
    });

    const result = await service.hydratePacks('synthetic-system', {
        packs: [{ id: 'synthetic.items', type: 'Item', hydrate: true }],
    });

    assert.equal(result.hydrated, 1);
    assert.equal(result.missing, 0);
    assert.equal(result.skipped, 0);
    assert.equal(transport.calls.filter(call => call.event === 'modifyDocument').length, 1,
        'one full-pack read, without a redundant index read');

    const manifest = await store.getManifest('synthetic-system');
    assert.equal(manifest?.packs['synthetic.items'].hydrate, true);
    assert.equal((await store.getPackRows('synthetic-system', 'synthetic.items'))?.[0]?.name, 'Torch');
    assert.equal(store.getPackIndex('synthetic.items')?.[0]?.name,'Torch');
    assert.equal(store.getPackIndex('synthetic.items')?.[0]?.system,undefined,'discovery indices do not retain full documents');
}

// Production reproduction: ID/name and even timestamps can remain unchanged
// when a shipped pack replaces an embedded effect. Legacy manifests must refresh.
async function runEmbeddedEffectChangeWithUnchangedIndex() {
    const store=createStore(),transport=new FakeTransport();
    const pack='synthetic.items',system='synthetic-system';
    const old={_id:'talent',name:'Spellcasting',effects:[{_id:'effect',changes:[{key:'system.spellcasting.classes',value:'knight-of-st.-ydris'}]}]};
    const current=structuredClone(old);current.effects[0].changes[0].value='witch';
    const index=[{_id:old._id,name:old.name}];
    store.setPackMetadata(pack,packMetadata(pack));store.setPackIndex(pack,packMetadata(pack),index);
    await store.setPackRows(system,pack,[old]);
    await store.setManifest({systemId:system,_instanceId:'old-cache',packs:{[pack]:{id:pack,hash:computeHash(index,true),lastUpdated:1,rowCount:1,hydrate:true}}});
    transport.handler=(_event,payloads)=>({result:(payloads[0] as any).operation.index===false?[current]:index});
    const service=new CompendiumService({transport,store});
    await service.hydratePacks(system,{packs:[{id:pack,type:'Item',hydrate:true}]});
    assert.equal(((await store.findDocument(system,pack,'talent')) as any)?.effects[0].changes[0].value,'witch', 'same-name embedded effect updates must replace legacy cache');
    const firstHash=(await store.getManifest(system))!.packs[pack].hash;
    current.effects[0].changes[0].value='updated-native-list';
    await new CompendiumService({transport,store}).hydratePacks(system,{packs:[{id:pack,type:'Item',hydrate:true}]});
    assert.equal(((await store.findDocument(system,pack,'talent')) as any)?.effects[0].changes[0].value,'updated-native-list');
    assert.notEqual((await store.getManifest(system))!.packs[pack].hash,firstHash,'the fix also detects later edits after the legacy cache is gone');
}

async function runFailedRefreshRejectsWithoutPublishing() {
    const store=createStore(),transport=new FakeTransport(),pack='synthetic.items';
    store.setPackMetadata(pack,packMetadata(pack));
    const config:CompendiumPackConfig={packs:[{id:pack,type:'Item',hydrate:true}]};
    transport.handler=()=>({result:[{_id:'old',name:'Old'}]});
    const service=new CompendiumService({transport,store});
    await service.hydratePacks('synthetic-system',config);
    const manifest=structuredClone(await store.getManifest('synthetic-system'));
    transport.handler=()=>({error:'Source unavailable'});
    await assert.rejects(service.hydratePacks('synthetic-system',config),/Compendium refresh failed.*synthetic.items/);
    assert.deepEqual(await store.getManifest('synthetic-system'),manifest,'failed validation never publishes fresh evidence');
    transport.handler=()=>({result:[]});
    await service.hydratePacks('synthetic-system',config);
    assert.deepEqual(await store.getPackRows('synthetic-system',pack),[],'a genuinely empty pack clears old contents');
}

async function runLateResponseCannotReplaceInvalidatedPack() {
    const store=createStore(),transport=new FakeTransport(),pack='synthetic.items';
    store.setPackMetadata(pack,packMetadata(pack));
    transport.handler=async()=>{
        await store.invalidatePackContent('synthetic-system',pack,'changed-during-fetch');
        return {result:[{_id:'old',name:'Old'}]};
    };
    await assert.rejects(new CompendiumService({transport,store}).hydratePacks('synthetic-system',{packs:[{id:pack,type:'Item',hydrate:true}]}),/scope changed/);
    assert.equal(await store.getPackRows('synthetic-system',pack),null);
}
