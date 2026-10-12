import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Pretendard (variable font, self-hosted from the `pretendard` npm package)
const pretendard = localFont({
  src: "../node_modules/pretendard/dist/web/variable/woff2/PretendardVariable.woff2",
  variable: "--font-pretendard",
  weight: "45 920",
  display: "swap",
});

export const metadata: Metadata = {
  title: "MQ Visualizer",
  description: "Real-time visualization of async message queue processing with QStash + Redis",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`dark ${pretendard.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
