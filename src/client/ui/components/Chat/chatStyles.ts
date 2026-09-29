export const defaultChatStyles = {
    container: "sd-ui-panel backdrop-blur-md rounded-2xl shadow-2xl flex flex-col",
    header: "sd-ui-muted text-[10px] font-bold uppercase mb-4 border-b sd-ui-divider pb-2 flex items-center gap-2 tracking-widest px-4 pt-4",
    msgContainer: (isRoll: boolean) => `sd-ui-inset mx-4 p-2 rounded-xl text-sm transition-colors ${isRoll ? '' : 'whitespace-pre-wrap'}`,
    user: "sd-ui-accent font-bold text-[10px] uppercase tracking-widest",
    time: "sd-ui-muted text-[10px] font-sans",
    flavor: "sd-ui-muted text-[11px] italic mb-1 font-sans leading-tight",
    content: "text-center text-white/90 text-lg font-bold [&_.table-draw]:flex [&_.table-draw]:flex-col [&_.table-draw]:gap-0 [&_.table-draw]:text-left [&_.table-draw]:!m-0 [&_.table-draw]:!p-0 [&_.result-row]:flex [&_.result-row]:items-center [&_.result-row]:gap-2 [&_.result-row]:px-2 [&_.result-row]:py-1 [&_.result-row]:!mt-0 [&_.result-row]:!mb-0 [&_.result-row]:bg-white/5 [&_.result-row]:border [&_.result-row]:border-white/10 [&_.result-row:not(:first-child)]:-mt-px [&_.result-image]:w-8 [&_.result-image]:h-8 [&_.result-image]:rounded [&_.result-image]:!border-none [&_.result-image]:!m-0 [&_.result-image]:shrink-0 [&_.result-text]:text-sm [&_.result-text]:font-medium [&_.result-text]:text-white/90 [&_.chat-card]:!block [&_.chat-card]:bg-white/5 [&_.chat-card]:border [&_.chat-card]:border-white/10 [&_.chat-card]:rounded-lg [&_.chat-card]:overflow-hidden [&_.chat-card]:text-left [&_.card-header]:flex [&_.card-header]:items-center [&_.card-header]:gap-2 [&_.card-header]:bg-white/10 [&_.card-header]:px-2 [&_.card-header]:py-0.5 [&_.card-header]:border-b [&_.card-header]:border-white/10 [&_.card-header_img]:w-8 [&_.card-header_img]:h-8 [&_.card-header_img]:rounded [&_.card-header_img]:shrink-0 [&_.item-name]:text-sm [&_.item-name]:font-bold [&_.item-name]:text-white/90 [&_.item-name]:!m-0 [&_.card-content]:px-2 [&_.card-content]:py-0.5 [&_.card-content]:text-xs [&_.card-content]:text-white/70 [&_.card-content_p]:!m-0 [&_.card-footer]:hidden [&_.table-results]:flex [&_.table-results]:flex-col [&_.table-results]:gap-0 [&_.table-results]:!m-0 [&_.table-results]:!p-0 [&_.table-results]:list-none [&_.table-results_li]:flex [&_.table-results_li]:items-center [&_.table-results_li]:gap-2 [&_.table-results_li]:px-2 [&_.table-results_li]:py-1 [&_.table-results_li]:bg-white/5 [&_.table-results_li]:border [&_.table-results_li]:border-white/10 [&_.table-results_li:not(:first-child)]:-mt-px [&_.table-results_img]:w-8 [&_.table-results_img]:h-8 [&_.table-results_img]:rounded [&_.table-results_img]:shrink-0 [&_.content-link]:text-sm [&_.content-link]:text-white/90 [&_.content-link]:no-underline [&_.content-link_i]:hidden [&_.description]:text-sm [&_.description]:text-white/90",
    rollResult: "sd-ui-inset mt-1 p-1.5 rounded-lg text-center font-sans",
    rollFormula: "sd-ui-muted text-md uppercase tracking-tighter font-bold",
    rollTotal: "text-lg font-bold",
    button: "sd-ui-button inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold transition-all cursor-pointer my-1 shadow-sm active:scale-95",
    buttonText: "sd-ui-muted uppercase tracking-widest",
    buttonValue: "sd-ui-accent font-bold",
    scrollButton: "sd-ui-button rounded-lg px-3 py-1.5 text-xs font-bold transition-all active:scale-95",
    inputContainer: "sd-ui-inset col-span-2 flex gap-2 p-1 backdrop-blur-sm rounded-lg mb-2",
    inputField: "sd-ui-control flex-1 rounded-md px-3 py-1.5 text-sm",
    sendBtn: "sd-ui-button sd-ui-button-primary disabled:opacity-50 px-4 py-1.5 rounded-md text-xs font-black transition-colors"
};
