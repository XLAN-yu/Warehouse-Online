import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://signal-analysis-workbench.xlan04910.chatgpt.site"),
  title: "Signal Lab · 信号分析工具",
  description: "用于时频变换、卷积和时频立方体可视化的交互式工具。",
  openGraph: {
    title: "Signal Lab · 信号分析工具",
    description: "时频变换 · 卷积 · 时频立方体",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "Signal Lab 时频变换、卷积与时频立方体工作台",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Signal Lab · 信号分析工具",
    description: "时频变换 · 卷积 · 时频立方体",
    images: ["/og.png"],
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <head>
        <meta
          httpEquiv="Content-Security-Policy"
          content="default-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'"
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
