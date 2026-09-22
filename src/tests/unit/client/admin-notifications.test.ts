import assert from 'node:assert/strict';
import { scopeAdminNotifications } from '../../../app/(admin)/lib/adminNotifications';
import { NotificationStore } from '../../../client/ui/components/Notifications/notificationStore';

export function run() {
    const store = new NotificationStore({ now: () => 0, set: () => 0, clear() {} });
    const api = { addNotification: store.add, updateNotification: store.update, removeNotification: store.remove };
    let guardReads = 0;
    const deferred = scopeAdminNotifications(api, () => { guardReads++; return false; });
    assert.equal(guardReads, 0, 'constructing the API must not execute the render-time guard');
    deferred.addNotification('Inactive');
    assert.equal(guardReads, 1);
    let revision = 1, authenticated = true, mounted = true, restarting = false;
    const scope = () => {
        const owner = revision;
        return scopeAdminNotifications(api, () => mounted && authenticated && !restarting && owner === revision);
    };
    const first = scope();
    const id = first.addNotification('<b>literal</b>', 'warning', { title: 'Catalog', progress: 0 });
    assert.ok(id > 0);
    assert.equal(store.getSnapshot().notifications[0].safeHtml, undefined);
    assert.equal(store.getSnapshot().notifications[0].content, '<b>literal</b>');
    assert.equal(first.updateNotification(id, { content: 'Complete', type: 'success', progress: 1 }), true);
    assert.equal(store.getSnapshot().notifications[0].progress, 1);
    assert.equal(first.updateNotification(999, { content: 'Missing' }), false);

    // Session retirement blocks callbacks even before React clears the old queue.
    authenticated = false; revision++;
    assert.equal(first.addNotification('Late result'), 0);
    assert.equal(first.updateNotification(id, { content: 'Late update' }), false);
    first.removeNotification(id);
    assert.equal(store.getSnapshot().notifications.length, 1);
    store.clear();
    authenticated = true; revision++;
    const second = scope();
    const next = second.addNotification('New session');
    assert.equal(first.addNotification('Old same-admin login'), 0);
    first.removeNotification(next);
    assert.equal(store.getSnapshot().notifications[0].id, next);
    assert.equal(second.updateNotification(next, { title: 'Updated' }), true);
    second.removeNotification(next);
    assert.equal(store.getSnapshot().notifications.length, 0);

    second.addNotification('Before maintenance');
    restarting = true;
    assert.equal(second.addNotification('Misleading success'), 0);
    assert.equal(second.updateNotification(next, { content: 'Stale' }), false);
    store.clear();
    restarting = false; mounted = false;
    assert.equal(second.addNotification('Unmounted'), 0);
    assert.equal(store.getSnapshot().notifications.length, 0);
    console.log('  - Admin notification session guards: all checks passed');
}
