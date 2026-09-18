'use client';

import type { ReactNode } from 'react';
import { ConfigProvider } from '@client/ui/context/ConfigContext';
import { NotificationProvider } from '@client/ui/components/NotificationSystem';
import { FoundryProvider } from '@client/ui/context/FoundryContext';
import { UIProvider } from '@client/ui/context/UIContext';
import { SessionProvider } from '@client/ui/context/SessionContext';
import { ActorCombatProvider } from '@client/ui/context/ActorCombatContext';
import { RealtimeProvider } from '@client/ui/context/RealtimeContext';
import { ChatProvider } from '@client/ui/context/ChatContext';
import { PlayerSettingsDialog } from '@client/ui/components/Settings/PlayerSettingsDialog';
import { DicePresentationProvider } from '@client/ui/context/DicePresentationContext';
import { JournalProvider } from '@client/ui/context/JournalProvider';
import { NotificationSessionBoundary } from '@client/ui/components/Notifications/NotificationSessionBoundary';
import { ChatPreview } from '@client/ui/components/Chat/ChatPreview';
import SDKGlobalProvider from '@client/ui/providers/SDKGlobalProvider';

export default function PlayerProviders({ children }: { children: ReactNode }) {
  return (
    <SDKGlobalProvider>
      <ConfigProvider>
        <NotificationProvider>
          <UIProvider>
            <SessionProvider>
              <RealtimeProvider>
                <ActorCombatProvider>
                  <ChatProvider>
                    <FoundryProvider>
                      <NotificationSessionBoundary />
                      <ChatPreview />
                      <JournalProvider>
                        <DicePresentationProvider>{children}<PlayerSettingsDialog /></DicePresentationProvider>
                      </JournalProvider>
                    </FoundryProvider>
                  </ChatProvider>
                </ActorCombatProvider>
              </RealtimeProvider>
            </SessionProvider>
          </UIProvider>
        </NotificationProvider>
      </ConfigProvider>
    </SDKGlobalProvider>
  );
}
