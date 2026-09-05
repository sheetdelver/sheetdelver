import React, { useMemo, useState } from 'react';
import type { AppSystemInfo, User } from '@shared/interfaces';
import { Theme } from '../hooks/useTheme';
import { sanitizeRichHtml } from '@shared/security/safeHtml';
import { SafeHtmlContent } from '@client/ui/components/SafeHtmlContent';

interface LoginViewProps {
    users: User[];
    system: AppSystemInfo | null;
    theme: Theme;
    onLogin: (user: string, password: string) => Promise<void>;
    loading: boolean;
}

export const LoginView = ({ users, system, theme, onLogin, loading }: LoginViewProps) => {
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
            <div className={`flex-1 ${theme.panelBg} p-6 rounded-lg shadow-lg border border-white/5`}>
                {system?.worldTitle && (
                    <h1 className={`text-4xl font-bold mb-4 ${theme.headerFont} text-amber-500 tracking-tight`}>
                        {system.worldTitle}
                    </h1>
                )}

                {system?.worldDescription && (
                    <SafeHtmlContent
                        className="prose prose-invert prose-sm max-w-none opacity-80 mb-6"
                        html={worldDescription}
                    />
                )}

                <div className="grid grid-cols-2 gap-4 mt-auto pt-4 border-t border-white/10">
                    <div>
                        <label className="text-xs uppercase tracking-widest opacity-50 block mb-1">Next Session</label>
                        <div className="font-mono text-lg">
                            {system?.nextSession ? system.nextSession : <span className="opacity-30 italic">Not Scheduled</span>}
                        </div>
                    </div>
                    <div>
                        <label className="text-xs uppercase tracking-widest opacity-50 block mb-1">Current Players</label>
                        <div className="font-mono text-lg flex items-center gap-2">
                            <span className="text-green-400">{system?.users?.active || 0}</span>
                            <span className="opacity-40">/</span>
                            <span>{system?.users?.total || 0}</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* Login Form */}
            <div className={`w-full md:w-96 ${theme.panelBg} p-6 rounded-lg shadow-lg border border-white/5`}>
                <h2 className={`text-xl mb-4 ${theme.headerFont}`}>Login</h2>
                <div className="space-y-4">
                    {users.length > 0 && (
                        <div>
                            <label className="block text-sm font-medium mb-1 opacity-70">Player</label>
                            <select
                                value={selectedUser}
                                onChange={(e) => setSelectedUser(e.target.value)}
                                className={`w-full p-2 rounded border outline-none ${theme.input} appearance-none`}
                            >
                                <option value="" disabled>-- Select Player --</option>
                                {users.map((u: User, idx: number) => {
                                    const isDisabled = u.canLogin === false || u.active === true;
                                    return (
                                        <option
                                            key={u.name || idx}
                                            value={u.name}
                                            disabled={isDisabled}
                                            className={`bg-neutral-900 text-white ${isDisabled ? 'text-white/30 bg-neutral-800' : ''}`}
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
                                <label className="block text-sm font-medium mb-1 opacity-70">Password</label>
                                <input
                                    type="password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && handleLoginClick()}
                                    className={`w-full p-2 rounded border outline-none ${theme.input}`}
                                    placeholder="••••••••"
                                />
                            </div>

                            <button
                                onClick={handleLoginClick}
                                disabled={loading || !selectedUser}
                                className={`
                          w-full py-2 px-4 rounded font-bold transition-all duration-200
                          ${loading || !selectedUser
                                        ? 'bg-neutral-700 text-white/30 cursor-not-allowed'
                                        : 'bg-green-700 hover:bg-green-600 text-white shadow-lg hover:shadow-green-900/20'}
                        `}
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
