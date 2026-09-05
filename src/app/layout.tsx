import type { Metadata } from "next";
import { connection } from "next/server";
import { Geist, Geist_Mono, Cinzel, Inter, IM_Fell_Double_Pica, Crimson_Pro } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  preload: false,
  display: "swap",
  fallback: ["system-ui", "arial"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  preload: false,
  display: "swap",
  fallback: ["monospace"],
});

const cinzel = Cinzel({
  variable: "--font-cinzel",
  subsets: ["latin"],
  preload: false,
  display: "swap",
  fallback: ["serif"],
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  preload: false,
  display: "swap",
  fallback: ["sans-serif"],
});

const imFell = IM_Fell_Double_Pica({
  weight: "400",
  variable: "--font-imfell",
  subsets: ["latin"],
  preload: false,
  display: "swap",
  fallback: ["serif"],
});

const crimson = Crimson_Pro({
  variable: "--font-crimson",
  subsets: ["latin"],
  preload: false,
  display: "swap",
  fallback: ["serif"],
});

export const metadata: Metadata = {
  title: "SheetDelver",
  description: "Modern Foundry VTT Actor Sheet",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // A request-bound render lets Proxy supply the fresh CSP nonce that Next
  // attaches to framework scripts; static HTML cannot carry a per-request nonce.
  await connection();

  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${cinzel.variable} ${inter.variable} ${imFell.variable} ${crimson.variable} font-sans antialiased`}
        suppressHydrationWarning
      >
        {children}
      </body>
    </html>
  );
}
