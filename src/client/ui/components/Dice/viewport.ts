/** Keep fixed dice bounds within the visible area, including mobile zoom/keyboard offsets. */
export function trackDiceViewport(element: HTMLElement, host: Window, onResize: () => void) {
    const viewport = host.visualViewport;
    let width = 0;
    let height = 0;
    const update = () => {
        const nextWidth = viewport?.width ?? host.innerWidth;
        const nextHeight = viewport?.height ?? host.innerHeight;
        const resized = width > 0 && (Math.abs(width - nextWidth) > 1 || Math.abs(height - nextHeight) > 1);
        width = nextWidth;
        height = nextHeight;
        Object.assign(element.style, {
            left: `${viewport?.offsetLeft ?? 0}px`, top: `${viewport?.offsetTop ?? 0}px`,
            width: `${width}px`, height: `${height}px`,
        });
        if (resized) onResize();
    };
    update();
    host.addEventListener('resize', update);
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    return () => {
        host.removeEventListener('resize', update);
        viewport?.removeEventListener('resize', update);
        viewport?.removeEventListener('scroll', update);
    };
}
