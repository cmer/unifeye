import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { config } from "@/server/config";
import "./globals.css";

const geist = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });

const title = "Unifeye", description = "Camera viewing for your team";
const image = { url: "/og-image.png", width: 1200, height: 630, alt: "Unifeye" };
// Some chat apps (WhatsApp, small Telegram previews) crop to a square; the wide banner would lose its text there.
const squareImage = { url: "/og-image-square.png", width: 600, height: 600, alt: "Unifeye" };

/** Link previews (Slack, iMessage) need absolute image URLs, so the base comes from APP_URL at request time. */
export function generateMetadata(): Metadata {
  let metadataBase: URL | undefined;
  try { metadataBase = new URL(config().APP_URL); } catch { /* config not available (e.g. during build) */ }
  return {
    metadataBase,
    title,
    description,
    icons: { icon: "/icon.svg", apple: "/apple-touch-icon.png" },
    appleWebApp: { capable: true, title, statusBarStyle: "black-translucent" },
    openGraph: { type: "website", url: "/", siteName: title, title, description, images: [image, squareImage] },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: [{ media: "(prefers-color-scheme: dark)", color: "#09090b" }, { media: "(prefers-color-scheme: light)", color: "#ffffff" }] };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} h-full antialiased`} suppressHydrationWarning>
      <body className="h-full overflow-hidden">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <TooltipProvider>{children}</TooltipProvider>
          <Toaster position="bottom-right" />
        </ThemeProvider>
      </body>
    </html>
  );
}
