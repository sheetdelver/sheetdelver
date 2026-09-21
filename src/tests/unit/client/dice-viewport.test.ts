import assert from 'node:assert/strict';
import { trackDiceViewport } from '../../../client/ui/components/Dice/viewport';

export function run() {
    const viewport = Object.assign(new EventTarget(), { width: 390, height: 844, offsetTop: 0, offsetLeft: 0 });
    const host = Object.assign(new EventTarget(), { visualViewport: viewport, innerWidth: 980, innerHeight: 1600 });
    const element = { style: {} } as HTMLElement;
    let resized = 0;
    const stop = trackDiceViewport(element, host as unknown as Window, () => resized++);
    assert.deepEqual(element.style, { left: '0px', top: '0px', width: '390px', height: '844px' });
    viewport.offsetTop = 180;
    viewport.offsetLeft = 20;
    viewport.dispatchEvent(new Event('scroll'));
    assert.equal(element.style.top, '180px');
    assert.equal(element.style.left, '20px');
    assert.equal(resized, 0, 'Panning follows the viewport without ending a throw');
    host.dispatchEvent(new Event('resize'));
    assert.equal(resized, 0, 'Duplicate resize events do not dismiss dice');
    viewport.height = 420;
    viewport.dispatchEvent(new Event('resize'));
    assert.equal(element.style.height, '420px');
    assert.equal(resized, 1, 'Changed physics bounds end the current throw');
    stop();
    viewport.height = 300;
    viewport.dispatchEvent(new Event('resize'));
    viewport.dispatchEvent(new Event('scroll'));
    host.dispatchEvent(new Event('resize'));
    assert.equal(element.style.height, '420px', 'All viewport listeners are removed');

    const fallback = Object.assign(new EventTarget(), { innerWidth: 1440, innerHeight: 900 });
    const stopFallback = trackDiceViewport(element, fallback as unknown as Window, () => resized++);
    assert.deepEqual(element.style, { left: '0px', top: '0px', width: '1440px', height: '900px' });
    fallback.innerWidth = 320;
    fallback.dispatchEvent(new Event('resize'));
    assert.equal(element.style.width, '320px');
    stopFallback();
}
