'use client';

import React, { useState } from 'react';

import { LayoutGrid, Package, Sparkles, AlertCircle } from 'lucide-react';
import {
    beginPrimitiveEdit,
    commitPrimitiveEdit,
    shouldUseMultilineField,
    updatePrimitiveDraft,
} from './genericSheetFieldState';



interface GenericSheetProps {
    actor: any;
    onRoll?: (type: string, key: string, options?: any) => void;
    onUpdate?: (path: string, value: any) => void;
}

export default function GenericSheet({ actor, onUpdate }: GenericSheetProps) {
    const [activeTab, setActiveTab] = useState<'system' | 'items' | 'effects'>('system');

    // Safe accessors
    const systemId = actor.systemId || actor.system?.details?.system || 'unknown';
    const items = actor.items || [];
    const effects = actor.effects || [];

    return (
        <div className={`flex flex-col h-[100dvh] w-full bg-neutral-50 text-neutral-900 $"font-inter"`}>
            {/* Header */}
            <header className="shrink-0 bg-white border-b border-neutral-200 p-4 shadow-sm z-10 sticky top-0">
                <div className="flex items-center gap-4 max-w-3xl mx-auto">
                    <div className="w-16 h-16 rounded-full overflow-hidden bg-neutral-200 border-2 border-white shadow-md shrink-0">
                        <img
                            src={actor.img || '/icons/svg/mystery-man.svg'}
                            alt={actor.name}
                            className="w-full h-full object-cover"
                        />
                    </div>
                    <div className="flex-1 min-w-0">
                        <h1 className="text-2xl font-bold truncate leading-tight tracking-tight">{actor.name}</h1>
                        <div className="flex items-center gap-2 text-xs text-neutral-500 font-medium uppercase tracking-wider mt-1">
                            <span className="bg-neutral-100 px-2 py-0.5 rounded text-neutral-600 border border-neutral-200">{actor.type}</span>
                            <span className="opacity-50">•</span>
                            <span>{systemId}</span>
                        </div>
                    </div>
                </div>
            </header>

            {/* Scrollable Content */}
            <main className="flex-1 overflow-y-auto p-4 pb-24 md:pb-24">
                <div className="max-w-3xl mx-auto space-y-6">

                    {activeTab === 'system' && (
                        <div className="space-y-6 animate-in fade-in zoom-in-95 duration-200">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <DataProperty
                                    label="System Data"
                                    data={actor.system}
                                    path="system"
                                    onUpdate={onUpdate}
                                    root={true}
                                />
                            </div>
                        </div>
                    )}

                    {activeTab === 'items' && (
                        <div className="space-y-3 animate-in fade-in slide-in-from-bottom-2 duration-200">
                            {items.length === 0 ? (
                                <EmptyState icon={<Package size={48} />} label="No Items Found" />
                            ) : (
                                items.map((item: any) => (
                                    <div key={item.id} className="bg-white p-3 rounded-lg border border-neutral-200 shadow-sm flex items-center gap-3 active:scale-[0.99] transition-transform">
                                        <div className="w-10 h-10 bg-neutral-100 rounded border border-neutral-200 overflow-hidden shrink-0">
                                            <img src={item.img} alt={item.name} className="w-full h-full object-cover" />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="font-semibold text-sm truncate">{item.name}</div>
                                            <div className="text-xs text-neutral-400 capitalize">{item.type}</div>
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    )}

                    {activeTab === 'effects' && (
                        <div className="space-y-3 animate-in fade-in slide-in-from-bottom-2 duration-200">
                            {effects.length === 0 ? (
                                <EmptyState icon={<Sparkles size={48} />} label="No Effects Active" />
                            ) : (
                                effects.map((effect: any) => (
                                    <div key={effect.id} className="bg-white p-3 rounded-lg border border-neutral-200 shadow-sm flex items-center gap-3 opacity-90 hover:opacity-100">
                                        <div className="w-10 h-10 bg-purple-50 rounded border border-purple-100 flex items-center justify-center shrink-0 text-purple-600">
                                            {effect.icon ? <img src={effect.icon} className="w-full h-full object-cover" alt="" /> : <Sparkles size={20} />}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="font-semibold text-sm truncate">{effect.label}</div>
                                            <div className="text-xs text-neutral-400">{effect.disabled ? 'Disabled' : 'Active'}</div>
                                        </div>
                                        <div className={`w-2 h-2 rounded-full ${effect.disabled ? 'bg-neutral-300' : 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]'}`} />
                                    </div>
                                ))
                            )}
                        </div>
                    )}
                </div>
            </main>

            {/* Bottom Navigation */}
            <nav className="fixed bottom-0 left-0 right-0 bg-white/80 backdrop-blur-md border-t border-neutral-200 pb-safe pt-2 px-6 safe-area-bottom z-20">
                <div className="max-w-md mx-auto flex justify-between items-center h-16">
                    <NavButton
                        active={activeTab === 'system'}
                        onClick={() => setActiveTab('system')}
                        icon={<LayoutGrid size={24} />}
                        label="System"
                    />
                    <NavButton
                        active={activeTab === 'items'}
                        onClick={() => setActiveTab('items')}
                        icon={<Package size={24} />}
                        label="Items"
                        count={items.length}
                    />
                    <NavButton
                        active={activeTab === 'effects'}
                        onClick={() => setActiveTab('effects')}
                        icon={<Sparkles size={24} />}
                        label="Effects"
                        count={effects.length}
                    />
                </div>
            </nav>
        </div>
    );
}

function NavButton({ active, onClick, icon, label, count }: any) {
    return (
        <button
            onClick={onClick}
            className={`flex flex-col items-center justify-center w-16 gap-1 transition-all duration-200 ${active ? 'text-blue-600 scale-105 font-bold' : 'text-neutral-400 hover:text-neutral-600'}`}
        >
            <div className="relative">
                {icon}
                {count > 0 && (
                    <span className="absolute -top-1 -right-2 bg-neutral-900 text-white text-[9px] font-bold h-4 min-w-[16px] px-1 rounded-full flex items-center justify-center">
                        {count}
                    </span>
                )}
            </div>
            <span className="text-[10px] tracking-wide">{label}</span>
        </button>
    );
}

function EmptyState({ icon, label }: any) {
    return (
        <div className="flex flex-col items-center justify-center py-20 text-neutral-300 gap-4">
            {icon}
            <span className="font-medium">{label}</span>
        </div>
    );
}

function DataProperty({ label, data, path, onUpdate, root }: any) {
    const isObject = typeof data === 'object' && data !== null && !Array.isArray(data);
    const isArray = Array.isArray(data);
    const isPrimitive = !isObject && !isArray;

    if (isPrimitive) {
        return <PrimitiveField label={label} value={data} path={path} onUpdate={onUpdate} />;
    }

    if (root) {
        return (
            <>
                {Object.entries(data).map(([key, value]) => (
                    <div key={key} className="bg-white rounded-xl border border-neutral-200 shadow-sm overflow-hidden text-sm">
                        <div className="px-4 py-2 bg-neutral-50 border-b border-neutral-200 font-bold text-neutral-500 uppercase tracking-widest text-[10px] flex items-center gap-2">
                            <AlertCircle size={12} />
                            {key}
                        </div>
                        <div className="p-4 space-y-2">
                            <DataProperty label={key} data={value} path={`${path}.${key}`} onUpdate={onUpdate} />
                        </div>
                    </div>
                ))}
            </>
        );
    }

    if (isObject) {
        return (
            <div className="pl-3 border-l-2 border-neutral-100 ml-1 space-y-2">
                {Object.entries(data).map(([key, value]) => (
                    <div key={key} className="flex flex-col gap-1">
                        {typeof value === 'object' && value !== null && <span className="text-xs font-semibold text-neutral-400">{key}</span>}
                        <DataProperty label={key} data={value} path={`${path}.${key}`} onUpdate={onUpdate} />
                    </div>
                ))}
            </div>
        );
    }

    return null;
}

function PrimitiveField({ label, value, path, onUpdate }: any) {
    const [isEditing, setIsEditing] = useState(false);
    const [editState, setEditState] = useState(() => beginPrimitiveEdit(value));

    const beginEditing = () => {
        // Snapshot the latest realtime value when the user enters the control;
        // a stale hidden draft must never overwrite a refreshed document.
        setEditState(beginPrimitiveEdit(value));
        setIsEditing(true);
    };

    const handleDraftChange = (draft: string) => {
        setEditState(current => updatePrimitiveDraft(current, draft));
    };

    const handleSave = () => {
        const result = commitPrimitiveEdit(editState);
        if (onUpdate && result.changed) onUpdate(path, result.value);
        setIsEditing(false);
    };

    if (isEditing) {
        const useMultiline = shouldUseMultilineField(value, path);
        return (
            <div className={`flex gap-2 py-1 ${useMultiline ? 'items-start' : 'items-center'}`}>
                <span className="text-xs text-neutral-400 font-mono w-24 shrink-0 truncate text-right mr-2 pt-1">{label}</span>
                {useMultiline ? (
                    <textarea
                        autoFocus
                        rows={6}
                        className="flex-1 min-w-0 min-h-32 resize-y bg-white border-2 border-blue-500 rounded px-2 py-1 text-sm leading-relaxed outline-none shadow-sm"
                        value={editState.draft}
                        onChange={(event) => handleDraftChange(event.target.value)}
                        onBlur={handleSave}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                                event.preventDefault();
                                event.currentTarget.blur();
                            }
                        }}
                    />
                ) : (
                    <input
                        autoFocus
                        className="flex-1 min-w-0 bg-white border-2 border-blue-500 rounded px-2 py-1 text-sm outline-none shadow-sm"
                        value={editState.draft}
                        onChange={(event) => handleDraftChange(event.target.value)}
                        onBlur={handleSave}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') event.currentTarget.blur();
                        }}
                    />
                )}
            </div>
        );
    }

    return (
        <div
            onClick={() => onUpdate && beginEditing()}
            className="group flex items-center justify-between py-1.5 px-2 -mx-2 rounded hover:bg-neutral-50 cursor-pointer transition-colors"
        >
            <span className="text-xs text-neutral-500 font-medium mr-4 truncate capitalize opacity-70 group-hover:opacity-100 transition-opacity">{label}</span>
            <span className="text-sm font-semibold text-neutral-800 text-right truncate max-w-[200px]">
                {String(value)}
            </span>
        </div>
    );
}
