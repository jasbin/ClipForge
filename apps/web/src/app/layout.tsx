import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { FeedbackProvider } from "@/components/feedback";
import { Header } from "@/components/Header";
import { themeScript } from "@/components/ThemeToggle";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: "ClipForge", template: "%s · ClipForge" },
  description: "Find and cut the best short-form clips in long videos",
  applicationName: "ClipForge",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f7f8" },
    { media: "(prefers-color-scheme: dark)", color: "#09090b" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <a href="#main" className="sr-only z-50 rounded-lg bg-accent px-3 py-2 text-on-accent focus:not-sr-only focus:fixed focus:top-3 focus:left-3">
          Skip to content
        </a>
        <FeedbackProvider>
          <Header />
          <div id="main">{children}</div>
        </FeedbackProvider>
      </body>
    </html>
  );
}
