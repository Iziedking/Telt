// A clean render of the brand lockup in Telt's own style (circular t-in-ring emblem plus
// the Fredoka wordmark). Used to export the brandkit. No app chrome here. `tone` colors the
// ring and t (ink on light, cream on dark); the dot stays Signal red.
function Emblem({ tone }: { tone: string }) {
  return (
    <svg viewBox="0 0 104 104" className="bk-badge" aria-hidden>
      <circle cx="52" cy="52" r="48" fill="none" stroke={tone} strokeWidth="6" />
      <g transform="translate(23 21) scale(0.6)" fill={tone}>
        <rect x="9" y="32" width="62" height="17" rx="4" />
        <path d="M28 8 L50 8 L50 70 C50 84 59 90 71 84 C65 95 47 97 38 86 C33 80 30 74 28 65 Z" />
        <circle cx="82" cy="85" r="9" fill="#E8352B" />
      </g>
    </svg>
  );
}

export default function BrandPage() {
  return (
    <div className="brandkit">
      <div className="bk-card light" id="lockup-light">
        <div className="lockup">
          <Emblem tone="#14181F" />
          <span className="bk-word ink">
            tel<span className="bk-accent">t</span>
          </span>
        </div>
      </div>

      <div className="bk-card dark" id="lockup-dark">
        <div className="lockup">
          <Emblem tone="#F4F1EA" />
          <span className="bk-word cream">
            tel<span className="bk-accent">t</span>
          </span>
        </div>
      </div>
    </div>
  );
}
