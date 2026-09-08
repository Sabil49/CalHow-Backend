import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CalHow API",
  description: "CalHow backend — API-only, no user-facing UI.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
