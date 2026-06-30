"use client";

import { useEffect, useState } from "react";

// Light/dark toggle. The dark palette already lives under [data-theme="dark"] in globals.css, so
// this just flips the attribute on <html> and remembers the choice. Rides every app page except
// the landing (Chrome mounts it). A small inline script in layout.tsx applies the saved theme
// before paint to avoid a flash.
export default function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.getAttribute("data-theme") === "dark");
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.setAttribute("data-theme", next ? "dark" : "light");
    try {
      localStorage.setItem("telt-theme", next ? "dark" : "light");
    } catch {
      /* ignore */
    }
  };

  return (
    <button
      className="thm-btn"
      onClick={toggle}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      title={dark ? "Light mode" : "Dark mode"}
    >
      <span className="thm-btn-mark" aria-hidden>
        {dark ? (
          // sun
          <svg viewBox="0 0 24 24" width="17" height="17">
            <circle cx="12" cy="12" r="4.5" fill="currentColor" />
            {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
              <line
                key={a}
                x1="12"
                y1="2.5"
                x2="12"
                y2="5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                transform={`rotate(${a} 12 12)`}
              />
            ))}
          </svg>
        ) : (
          // moon
          <svg viewBox="0 0 24 24" width="16" height="16">
            <path
              d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8Z"
              fill="currentColor"
            />
          </svg>
        )}
      </span>
    </button>
  );
}
