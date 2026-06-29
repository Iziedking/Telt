"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// A quiet help affordance: a small circle in the corner that stays out of the way and only
// reveals its "Tutorial" label on hover. It rides on every app page (Chrome mounts it) except
// the tutorial page itself.
export default function TutorialButton() {
  const path = usePathname() || "";
  if (path.startsWith("/tutorial")) return null;
  return (
    <Link href="/tutorial" className="tut-btn" aria-label="Open the tutorial">
      <span className="tut-btn-mark" aria-hidden>
        ?
      </span>
      <span className="tut-btn-label">Tutorial</span>
    </Link>
  );
}
