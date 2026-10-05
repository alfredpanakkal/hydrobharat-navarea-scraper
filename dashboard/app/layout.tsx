import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
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
  title: "NAVAREA Warnings Map",
  description: "Live map of NAVAREA VIII marine safety warnings.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <nav className="flex items-center gap-1 border-b border-zinc-800 bg-zinc-950 px-3 py-1.5 text-sm">
          <Link
            href="/"
            className="rounded-md px-2.5 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          >
            Map
          </Link>
          <Link
            href="/admin"
            className="rounded-md px-2.5 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          >
            Admin
          </Link>
        </nav>
        {children}
      </body>
    </html>
  );
}
