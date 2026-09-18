import assert from 'node:assert/strict';
import { NotificationStore, type NotificationClock } from '../../../client/ui/components/Notifications/notificationStore';

class Clock implements NotificationClock {
    time = 0;
    next = 0;
    tasks = new Map<number, { due: number; callback: () => void }>();
    now = () => this.time;
    set = (callback: () => void, delay: number) => {
        const id = ++this.next;
        this.tasks.set(id, { due: this.time + delay, callback });
        return id;
    };
    clear = (id: unknown) => { this.tasks.delete(id as number); };
    tick(ms: number) {
        const end = this.time + ms;
        for (;;) {
            const task = [...this.tasks].filter(([, task]) => task.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
            if (!task) break;
            this.time = task[1].due;
            this.tasks.delete(task[0]);
            task[1].callback();
        }
        this.time = end;
    }
}
export function run() {
    const realClockStore = new NotificationStore();
    realClockStore.add('real clock smoke');
    realClockStore.clear();
    const clock = new Clock();
    const store = new NotificationStore(clock);
    const visible = () => store.getSnapshot().notifications;
    const a = store.add('first'), b = store.add('second'), c = store.add('third');
    const d = store.add('queued');
    assert.equal(visible().length, 3);
    assert.equal(store.getSnapshot().queued, 1);
    assert.equal(clock.tasks.size, 3);
    clock.tick(5000);
    assert.deepEqual(visible().map(n => n.id), [d], 'queued notice gets a full lifetime after admission');
    clock.tick(4999);
    assert.equal(visible().length, 1);
    clock.tick(1);
    assert.equal(visible().length, 0);
    assert.equal(store.update(a, { content: 'late' }), false);

    const paused = store.add('pause');
    clock.tick(2000);
    store.pause(paused, 'hover', true);
    store.pause(paused, 'focus', true);
    clock.tick(10000);
    store.pause(paused, 'hover', false);
    assert.equal(clock.tasks.size, 0, 'focus still pauses');
    store.pause(paused, 'focus', false);
    store.setHidden(true);
    clock.tick(10000);
    assert.equal(visible().length, 1);
    store.setHidden(false);
    clock.tick(2999);
    assert.equal(visible().length, 1);
    clock.tick(1);
    assert.equal(visible().length, 0);

    const permanent = store.add('persistent', 'warning', { permanent: true });
    const progress = store.add('work', 'info', { progress: 0.2 });
    clock.tick(60000);
    assert.equal(visible().length, 2);
    store.update(progress, { progress: 1, type: 'success' });
    clock.tick(5000);
    assert.deepEqual(visible().map(n => n.id), [permanent]);
    store.clear();

    const key = store.add('<script>bad()</script><b>safe</b>', 'info', { html: true, key: 'job' });
    assert.ok(!String(visible()[0].safeHtml).includes('script'));
    store.update(key, { content: '<img src=x onerror=bad()><b>new</b>' });
    assert.ok(!String(visible()[0].safeHtml).includes('onerror'));
    assert.equal(store.add('<b>literal</b>', 'error', { key: 'job' }), key);
    assert.equal(visible()[0].safeHtml, undefined, 'key replacement does not inherit rich HTML');
    store.clear();
    assert.equal(clock.tasks.size, 0);

    const ids = Array.from({ length: 24 }, (_, i) => store.add(String(i), 'info', { permanent: true }));
    assert.deepEqual(visible().map(n => n.id), ids.slice(0, 3));
    assert.equal(store.getSnapshot().queued, 20);
    store.remove(ids[0]);
    assert.equal(visible()[2].id, ids[4], 'overflow discards oldest waiting, never active');
    store.clear();
    store.remove(b); store.remove(c);
    assert.equal(store.update(progress, { progress: 1 }), false);
    const short = store.add('bounds', 'info', { duration: -1, progress: NaN });
    assert.equal(visible()[0].duration, 1000);
    assert.equal(visible()[0].progress, undefined);
    let changes = 0;
    const unsubscribe = store.subscribe(() => changes++);
    store.update(short, { content: 'updated' });
    assert.equal(changes, 1);
    unsubscribe();
    store.clear();
    assert.equal(changes, 1);
    assert.equal(clock.tasks.size, 0);
}
