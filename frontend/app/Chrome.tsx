"use client";

import { usePathname } from "next/navigation";
import { TopNav, SiteFooter } from "./shell";

// The landing page at "/" is pure marketing and shows no app chrome. Every other route is
// the app and gets the product nav and footer.
export default function Chrome({ children }: { children: React.ReactNode }) {
  const path = usePathname() || "/";
  // The landing and the brand-export page show no app chrome.
  if (path === "/" || path === "/brand") return <>{children}</>;
  return (
    <>
      <TopNav />
      {children}
      <SiteFooter />
    </>
  );
}
