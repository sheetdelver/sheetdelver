/** Reserve space above visible tool panels; keep the feedback stack inside the viewport. */
export function feedbackClearance(height: number, panels: readonly { top: number; bottom: number; height: number }[]) {
    const visible = panels.filter(panel => panel.height > 0 && panel.bottom > 0 && panel.top < height);
    if (!visible.length) return null;
    const top = Math.min(...visible.map(panel => panel.top));
    return { bottom: Math.max(0, height - top + 8), maxHeight: Math.max(0, top - 24) };
}
