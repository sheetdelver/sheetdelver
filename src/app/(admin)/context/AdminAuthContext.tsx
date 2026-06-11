'use client';

import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { logger } from '@shared/utils/logger';
import { adminApiPath, postLogout } from '../lib/adminApi';

interface AdminAuthContextType {
  token: string | null;
  csrfToken: string | null;
  adminId: string | null;
  isAuthenticated: boolean;
  loading: boolean;
  error: string | null;
  accountExists: boolean | null;  // null = checking, true = exists, false = needs setup
  setupInProgress: boolean;
  login: (password: string) => Promise<void>;
  logout: () => void;
  checkAccountExists: () => Promise<boolean>;
  validateToken: () => Promise<boolean>;
  initSetup: (setupToken: string, password: string) => Promise<void>;
}

const AdminAuthContext = createContext<AdminAuthContextType | undefined>(undefined);

export function AdminAuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [adminId, setAdminId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [accountExists, setAccountExists] = useState<boolean | null>(null);
  const [setupInProgress, setSetupInProgress] = useState(false);

  // Initialize: restore tokens and check account existence
  useEffect(() => {
    const init = async () => {
      try {
        const storedToken = localStorage.getItem('admin-token');
        const storedCsrf = localStorage.getItem('admin-csrf');
        if (storedToken) {
          const response = await fetch(adminApiPath('/lifecycle'), {
            headers: {
              Authorization: `Bearer ${storedToken}`,
            },
          });
          if (response.ok) {
            setToken(storedToken);
            // Restore operator identity for the top bar (token alone no longer carries it client-side).
            try {
              const meRes = await fetch(adminApiPath('/auth/me'), {
                headers: { Authorization: `Bearer ${storedToken}` },
              });
              if (meRes.ok) {
                const me = await meRes.json();
                setAdminId(me.adminId ?? null);
              }
            } catch (meErr) {
              logger.warn('Could not restore admin identity', meErr);
            }
          } else {
            localStorage.removeItem('admin-token');
            localStorage.removeItem('admin-csrf');
          }
        }
        if (storedCsrf) {
          setCsrfToken(storedCsrf);
        }
        // Check if account exists (determines setup vs login flow)
        try {
          const response = await fetch(adminApiPath('/auth/status'));
          if (response.ok) {
            const data = await response.json();
            setAccountExists(data.accountExists);
          }
        } catch (statusErr) {
          logger.warn('Could not check account status', statusErr);
        }
      } catch (err) {
        logger.error('Failed to initialize admin auth:', err);
      } finally {
        setLoading(false);
      }
    };
    init();
  }, []);

  const checkAccountExists = useCallback(async () => {
    try {
      const response = await fetch(adminApiPath('/auth/status'));
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

  const validateToken = useCallback(async (): Promise<boolean> => {
    if (!token) return false;
    try {
      // Try a simple API call to validate token
      const response = await fetch(adminApiPath('/lifecycle'), {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (response.status === 401) {
        // Token expired
        setToken(null);
        setCsrfToken(null);
        localStorage.removeItem('admin-token');
        localStorage.removeItem('admin-csrf');
        return false;
      }
      return response.ok;
    } catch (err) {
      logger.error('Token validation failed:', err);
      return false;
    }
  }, [token]);

  const initSetup = useCallback(
    async (setupToken: string, password: string) => {
      try {
        setLoading(true);
        setError(null);
        setSetupInProgress(true);

        const response = await fetch(adminApiPath('/auth/setup'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ setupToken, password }),
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || 'Setup failed');
        }

        const data = await response.json();
        if (!data.token) {
          throw new Error('No token received from setup');
        }

        setToken(data.token);
        if (data.csrfToken) {
          setCsrfToken(data.csrfToken);
          localStorage.setItem('admin-csrf', data.csrfToken);
        }
        if (data.adminId) setAdminId(data.adminId);
        localStorage.setItem('admin-token', data.token);
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
    },
    []
  );

  const login = useCallback(
    async (password: string) => {
      try {
        setLoading(true);
        setError(null);

        const response = await fetch(adminApiPath('/auth/login'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ password }),
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || 'Login failed');
        }

        const data = await response.json();
        if (!data.token) {
          throw new Error('No token received from server');
        }

        setToken(data.token);
        if (data.csrfToken) {
          setCsrfToken(data.csrfToken);
          localStorage.setItem('admin-csrf', data.csrfToken);
        }
        if (data.adminId) setAdminId(data.adminId);
        localStorage.setItem('admin-token', data.token);
        logger.info('Admin login successful');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        setError(message);
        logger.error('Admin login failed:', err);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const logout = useCallback(() => {
    // Revoke the session server-side first so the token cannot be replayed,
    // then clear local state. Fire-and-forget: local cleanup happens regardless
    // of whether the network call succeeds.
    void postLogout().catch((err) => logger.warn('Server-side logout failed; clearing local state anyway', err));
    setToken(null);
    setCsrfToken(null);
    setAdminId(null);
    localStorage.removeItem('admin-token');
    localStorage.removeItem('admin-csrf');
    logger.info('Admin logged out');
  }, []);

  const value: AdminAuthContextType = {
    token,
    csrfToken,
    adminId,
    isAuthenticated: !!token,
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
