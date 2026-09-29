import React, { useId, useMemo, useState } from 'react';
import type { AppSystemInfo, User } from '@shared/interfaces';
import { sanitizeRichHtml } from '@shared/security/safeHtml';
import { SafeHtmlContent } from '@client/ui/components/SafeHtmlContent';
import { PlayerAppearanceToggle } from '@client/ui/components/Settings/PlayerAppearanceToggle';

interface LoginViewProps {
    users: User[];
    system: AppSystemInfo | null;
    onLogin: (user: string, password: string) => Promise<void>;
    loading: boolean;
}

export const LoginView = ({ users, system, onLogin, loading }: LoginViewProps) => {
    const formId = useId();
    const [selectedUser, setSelectedUser] = useState('');
    const [password, setPassword] = useState('');
    const worldDescription = useMemo(
        () => sanitizeRichHtml(system?.worldDescription ?? ''),
        [system?.worldDescription],
    );

    const handleLoginClick = () => {
        onLogin(selectedUser, password);
    };

    return (
        <div className="flex flex-col-reverse md:flex-row gap-8 max-w-4xl mx-auto items-stretch md:items-start animate-in fade-in slide-in-from-bottom-4 duration-500 mt-10">
            {/* World Info Card */}
            <div className="flex-1 sd-ui-panel p-6 rounded-lg shadow-lg">
                {system?.worldTitle && (
                    <h1 className="text-4xl font-bold mb-4 sd-ui-accent tracking-tight">
                        {system.worldTitle}
                    </h1>
                )}

                {system?.worldDescription && (
                    <SafeHtmlContent
                        className="rich-text-content text-sm max-w-none opacity-80 mb-6"
                        html={worldDescription}
                    />
                )}

                <div className="grid grid-cols-2 gap-4 mt-auto pt-4 border-t sd-ui-divider">
                    <div>
                        <label className="text-xs uppercase tracking-widest opacity-50 block mb-1">Next Session</label>
                        <div className="font-mono text-lg">
                            {system?.nextSession ? system.nextSession : <span className="opacity-30 italic">Not Scheduled</span>}
                        </div>
                    </div>
                    <div>
                        <label className="text-xs uppercase tracking-widest opacity-50 block mb-1">Current Players</label>
                        <div className="font-mono text-lg flex items-center gap-2">
                            <span className="sd-ui-success">{system?.users?.active || 0}</span>
                            <span className="opacity-40">/</span>
                            <span>{system?.users?.total || 0}</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* Login Form */}
            <div className="w-full md:w-96 sd-ui-panel p-6 rounded-lg shadow-lg">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <h2 className="text-xl font-bold">Login</h2>
                    <PlayerAppearanceToggle />
                </div>
                <div className="space-y-4">
                    {users.length > 0 && (
                        <div>
                            <label htmlFor={`${formId}-player`} className="block text-sm font-medium mb-1 sd-ui-muted">Player</label>
                            <select
                                id={`${formId}-player`}
                                value={selectedUser}
                                onChange={(e) => setSelectedUser(e.target.value)}
                                className="sd-ui-control w-full p-2"
                            >
                                <option value="" disabled>-- Select Player --</option>
                                {users.map((u: User, idx: number) => {
                                    const isDisabled = u.canLogin === false || u.active === true;
                                    return (
                                        <option
                                            key={u.name || idx}
                                            value={u.name}
                                            disabled={isDisabled}
                                        >
                                            {u.name} {u.active ? ' (Logged In)' : (u.canLogin === false ? ' (Restricted)' : '')}
                                        </option>
                                    );
                                })}
                            </select>
                        </div>
                    )}

                    {users.length > 0 && (
                        <>
                            <div className="mb-6">
                                <label htmlFor={`${formId}-password`} className="block text-sm font-medium mb-1 sd-ui-muted">Password</label>
                                <input
                                    id={`${formId}-password`}
                                    type="password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && handleLoginClick()}
                                    className="sd-ui-control w-full p-2"
                                    placeholder="••••••••"
                                />
                            </div>

                            <button
                                onClick={handleLoginClick}
                                disabled={loading || !selectedUser}
                                className="sd-ui-button sd-ui-button-primary w-full py-2 px-4 font-bold shadow-lg"
                            >
                                {loading ? 'Authenticating...' : 'Login'}
                            </button>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};
