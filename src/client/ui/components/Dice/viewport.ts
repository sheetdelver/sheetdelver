export const diceRegions = {
    full: { label: 'Full viewport', x: 0, y: 0, width: 1, height: 1 },
    center: { label: 'Center', x: 0.1, y: 0.15, width: 0.8, height: 0.7 },
    upper: { label: 'Upper', x: 0.05, y: 0.05, width: 0.9, height: 0.45 },
    lower: { label: 'Lower', x: 0.05, y: 0.5, width: 0.9, height: 0.45 },
    upperLeft: { label: 'Upper left', x: 0.05, y: 0.05, width: 0.45, height: 0.45 },
    upperRight: { label: 'Upper right', x: 0.5, y: 0.05, width: 0.45, height: 0.45 },
    lowerLeft: { label: 'Lower left', x: 0.05, y: 0.5, width: 0.45, height: 0.45 },
    lowerRight: { label: 'Lower right', x: 0.5, y: 0.5, width: 0.45, height: 0.45 },
} as const;
export type DiceRegion = keyof typeof diceRegions;

/** Keep fixed dice bounds within the visible area, including mobile zoom/keyboard offsets. */
export function trackDiceViewport(element: HTMLElement, host: Window, onResize: () => void, region: DiceRegion = 'full') {
    const viewport = host.visualViewport;
    const area = Object.hasOwn(diceRegions, region) ? diceRegions[region] : diceRegions.full;
    let width = 0;
    let height = 0;
    const update = () => {
        const viewportWidth = viewport?.width ?? host.innerWidth;
        const viewportHeight = viewport?.height ?? host.innerHeight;
        const nextWidth = viewportWidth * area.width;
        const nextHeight = viewportHeight * area.height;
        const resized = width > 0 && (Math.abs(width - nextWidth) > 1 || Math.abs(height - nextHeight) > 1);
        width = nextWidth;
        height = nextHeight;
        Object.assign(element.style, {
            left: `${(viewport?.offsetLeft ?? 0) + viewportWidth * area.x}px`,
            top: `${(viewport?.offsetTop ?? 0) + viewportHeight * area.y}px`,
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
