'use client';

import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { logger } from '@shared/utils/logger';
import {
  adminApiPath,
  postLogout,
  setAdminCsrfToken,
} from '../lib/adminApi';

interface AdminAuthContextType {
  csrfToken: string | null;
  adminId: string | null;
  isAuthenticated: boolean;
  loading: boolean;
  error: string | null;
  accountExists: boolean | null;
  setupInProgress: boolean;
  login: (password: string) => Promise<void>;
  logout: () => void;
  checkAccountExists: () => Promise<boolean>;
  validateToken: () => Promise<boolean>;
  initSetup: (bootstrapToken: string, password: string) => Promise<void>;
}

interface AdminSessionResponse {
  adminId?: string | null;
  csrfToken?: string | null;
}

const AdminAuthContext = createContext<AdminAuthContextType | undefined>(undefined);

export function AdminAuthProvider({ children }: { children: React.ReactNode }) {
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [adminId, setAdminId] = useState<string | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [accountExists, setAccountExists] = useState<boolean | null>(null);
  const [setupInProgress, setSetupInProgress] = useState(false);

  const applySession = useCallback((data: AdminSessionResponse) => {
    const nextCsrf = typeof data.csrfToken === 'string' ? data.csrfToken : null;
    setAdminCsrfToken(nextCsrf);
    setCsrfToken(nextCsrf);
    setAdminId(data.adminId ?? null);
    setIsAuthenticated(nextCsrf !== null);
  }, []);

  const clearSession = useCallback(() => {
    setAdminCsrfToken(null);
    setCsrfToken(null);
    setAdminId(null);
    setIsAuthenticated(false);
  }, []);

  // Restore the HttpOnly cookie session through an authenticated endpoint. The
  // exact legacy keys are removed without reading or reusing their credentials.
  useEffect(() => {
    const init = async () => {
      try {
        localStorage.removeItem('admin-token');
        localStorage.removeItem('admin-csrf');

        const meResponse = await fetch(adminApiPath('/auth/me'), {
          credentials: 'same-origin',
        });
        if (meResponse.ok) {
          applySession(await meResponse.json() as AdminSessionResponse);
        } else {
          clearSession();
        }

        const statusResponse = await fetch(adminApiPath('/auth/status'), {
          credentials: 'same-origin',
        });
        if (statusResponse.ok) {
          const data = await statusResponse.json();
          setAccountExists(data.accountExists);
        }
      } catch (err) {
        logger.error('Failed to initialize admin auth:', err);
        clearSession();
      } finally {
        setLoading(false);
      }
    };
    void init();
  }, [applySession, clearSession]);

  const checkAccountExists = useCallback(async () => {
    try {
      const response = await fetch(adminApiPath('/auth/status'), {
        credentials: 'same-origin',
      });
      if (response.ok) {
        const data = await response.json();
        setAccountExists(data.accountExists);
        return data.accountExists;
      }
    } catch (err) {
      logger.error('Failed to check account existence:', err);
    }
    return false;
  }, []);

  // Retain the public method name for component compatibility; validation now
  // checks the opaque cookie session and refreshes its in-memory CSRF value.
  const validateToken = useCallback(async (): Promise<boolean> => {
    try {
      const response = await fetch(adminApiPath('/auth/me'), {
        credentials: 'same-origin',
      });
      if (!response.ok) {
        clearSession();
        return false;
      }
      applySession(await response.json() as AdminSessionResponse);
      return true;
    } catch (err) {
      logger.error('Admin session validation failed:', err);
      return false;
    }
  }, [applySession, clearSession]);

  const initSetup = useCallback(async (bootstrapToken: string, password: string) => {
    try {
      setLoading(true);
      setError(null);
      setSetupInProgress(true);

      const response = await fetch(adminApiPath('/auth/setup'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bootstrapToken, password }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Setup failed');
      if (!data.csrfToken) throw new Error('No CSRF token received from setup');

      applySession(data);
      setAccountExists(true);
      logger.info('Admin account created successfully');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(message);
      logger.error('Admin setup failed:', err);
      throw err;
    } finally {
      setLoading(false);
      setSetupInProgress(false);
    }
  }, [applySession]);

  const login = useCallback(async (password: string) => {
    try {
      setLoading(true);
      setError(null);

      const response = await fetch(adminApiPath('/auth/login'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Login failed');
      if (!data.csrfToken) throw new Error('No CSRF token received from server');

      applySession(data);
      logger.info('Admin login successful');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(message);
      logger.error('Admin login failed:', err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [applySession]);

  const logout = useCallback(() => {
    // adminFetch snapshots the in-memory CSRF value before this local cleanup.
    // The route clears its HttpOnly cookie even if the session just expired.
    const logoutRequest = postLogout();
    clearSession();
    void logoutRequest.catch((err) => logger.warn('Server-side logout failed; local session cleared', err));
    logger.info('Admin logged out');
  }, [clearSession]);

  const value: AdminAuthContextType = {
    csrfToken,
    adminId,
    isAuthenticated,
    loading,
    error,
    accountExists,
    setupInProgress,
    login,
    logout,
    checkAccountExists,
    validateToken,
    initSetup,
  };

  return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>;
}

export function useAdminAuth() {
  const context = useContext(AdminAuthContext);
  if (!context) {
    throw new Error('useAdminAuth must be used within AdminAuthProvider');
  }
  return context;
}
