import type { Metadata } from "next";
import "./globals.css";
import "@fontsource/playfair-display/500.css";
import "@fontsource/playfair-display/600.css";
import "@fontsource/playfair-display/700.css";
import "@fontsource/source-serif-4/400.css";
import "@fontsource/source-serif-4/500.css";
import "@fontsource/source-serif-4/600.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";


export const metadata: Metadata = {
  title: "Factpicker — Same facts, opposite opinions",
  description:
    "How creators read the 2027 French presidential campaign: the fact they cite, the meaning they attach to it, and the verdict they aim at a candidate.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-paper text-ink">

        {children}
      </body>
    </html>
  );
}
