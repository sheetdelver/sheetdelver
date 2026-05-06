import ShutdownWatcher from "@client/ui/components/ShutdownWatcher";
import { ConfigProvider } from "@client/ui/context/ConfigContext";
import { NotificationProvider } from "@client/ui/components/NotificationSystem";
import { FoundryProvider } from "@client/ui/context/FoundryContext";
import { UIProvider } from "@client/ui/context/UIContext";
import { SessionProvider } from "@client/ui/context/SessionContext";
import { ActorCombatProvider } from "@client/ui/context/ActorCombatContext";
import { RealtimeProvider } from "@client/ui/context/RealtimeContext";
import { ChatProvider } from "@client/ui/context/ChatContext";
import GlobalChat from "@client/ui/components/GlobalChat";
import PlayerList from "@client/ui/components/PlayerList";
import FloatingHUD from "@client/ui/components/FloatingHUD";
import CombatHUD from "@client/ui/components/Combat/CombatHUD";
import { JournalProvider } from "@client/ui/context/JournalProvider";
import JournalBrowser from "@client/ui/components/JournalBrowser";
import JournalModal from "@client/ui/components/JournalModal";
import VideoPlaysinlineFix from "@client/ui/components/VideoPlaysinlineFix";
import SDKGlobalProvider from "@client/ui/providers/SDKGlobalProvider";

export default function PlayerLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
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
                    <JournalProvider>
                      <VideoPlaysinlineFix />
                      <div className="relative min-h-screen">
                        <ShutdownWatcher />
                        {children}
                        <GlobalChat />
                        <PlayerList />
                        <FloatingHUD />
                        <CombatHUD />
                        <JournalBrowser />
                        <JournalModal />
                      </div>
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