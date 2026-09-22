'use client';

import React from 'react';
import { AdminAuthProvider } from '../context/AdminAuthContext';
import { AdminThemeProvider, useAdminTheme } from '../context/AdminThemeContext';
import { NotificationProvider } from '@client/ui/components/NotificationSystem';
import { AdminNotificationProvider } from '../context/AdminNotificationContext';
import { AdminRuntimeRestartProvider } from '../context/AdminRuntimeRestartContext';

export default function AdminProviders({ children }: { children: React.ReactNode }) {
  return (
    <AdminThemeProvider>
      <AdminShell>
        <AdminAuthProvider>
          <AdminRuntimeRestartProvider>
            <NotificationProvider placement="admin">
              <AdminNotificationProvider>{children}</AdminNotificationProvider>
            </NotificationProvider>
          </AdminRuntimeRestartProvider>
        </AdminAuthProvider>
      </AdminShell>
    </AdminThemeProvider>
  );
}

function AdminShell({ children }: { children: React.ReactNode }) {
  const { theme } = useAdminTheme();

  return (
    <div className="admin-shell min-h-screen" data-admin-theme={theme}>
      {children}
    </div>
  );
}
