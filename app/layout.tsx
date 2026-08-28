import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://signal-analysis-workbench.xlan04910.chatgpt.site"),
  title: "仓储台 · 库存管理系统",
  description: "用于商品入库、出库、库存盘点、报表与可追溯审计的仓库库存管理系统。",
  openGraph: {
    title: "仓储台 · 库存管理系统",
    description: "库存清楚，出入有据。",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "仓储台库存管理系统" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "仓储台 · 库存管理系统",
    description: "库存清楚，出入有据。",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <head>
        <meta
          httpEquiv="Content-Security-Policy"
          content="default-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net; worker-src 'self' blob: https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: https://cdn.jsdelivr.net; connect-src 'self' blob: https://cdn.jsdelivr.net"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
