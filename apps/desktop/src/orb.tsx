import './orb.css';

/** Decorative layers only. State, accessible name and drag/click belong to the real Presence button. */
export function OrbVisual() {
  return <span className="orb-visual" aria-hidden="true">
    <span className="orb-core"/><span className="orb-ring"/>
    <span className="orb-orbit"/><span className="orb-glint"/>
  </span>;
}
