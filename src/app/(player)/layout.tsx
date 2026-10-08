import { PlayerWorldBoundary } from "@client/ui/components/PlayerWorldBoundary";
import GlobalChat from "@client/ui/components/GlobalChat";
import PlayerList from "@client/ui/components/PlayerList";
import FloatingHUD from "@client/ui/components/FloatingHUD";
import CombatHUD from "@client/ui/components/Combat/CombatHUD";
import JournalBrowser from "@client/ui/components/JournalBrowser";
import JournalModal from "@client/ui/components/JournalModal";
import VideoPlaysinlineFix from "@client/ui/components/VideoPlaysinlineFix";
import PlayerProviders from "./PlayerProviders";

export default function PlayerLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <PlayerProviders>
      <VideoPlaysinlineFix />
      <PlayerWorldBoundary>
      <div className="relative min-h-screen">
        {children}
          <GlobalChat />
          <PlayerList />
          <FloatingHUD />
          <CombatHUD />
          <JournalBrowser />
          <JournalModal />
      </div>
      </PlayerWorldBoundary>
    </PlayerProviders>
  );
}
