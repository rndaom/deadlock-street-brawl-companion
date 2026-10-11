import { memo, useState } from 'react';
import type { ReactNode } from 'react';
import type { CatalogHero, CatalogItem } from '../../shared/types';
import { abilityIconUrl, heroArtUrl, itemIconUrl } from '../catalog-index';
import type { AbilityLabel } from '../catalog-index';

const initials = (name: string) => name.split(/[\s&]+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '?';

/** An image that quietly falls back to its placeholder when the local asset is missing. */
function Picture({ src, className }: { src: string | null; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!src || failed === src) return null;
  return <img className={className} src={src} alt="" decoding="async" draggable={false} onError={() => setFailed(src)} />;
}

export const CategoryGlyph = memo(function CategoryGlyph({ category }: { category: CatalogItem['category'] }) {
  // Simplified forms of the three Deadlock shop glyphs.
  if (category === 'weapon') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13.5h10.5l2-2.5H20v5h-3.5l-1-1.2H9.8L8 18H5.5l1.2-3.2H4z" fill="currentColor" /></svg>;
  if (category === 'vitality') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 19 6v5.6c0 4.3-2.9 7.4-7 8.9-4.1-1.5-7-4.6-7-8.9V6z" fill="currentColor" /><path d="M11 8h2v3h3v2h-3v3h-2v-3H8v-2h3z" fill="var(--glyph-cut, #0c0f0e)" /></svg>;
  if (category === 'spirit') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5c1.2 3.6 3.8 5.2 3.8 8.8a3.8 3.8 0 0 1-7.6 0c0-1.6.7-2.8 1.6-3.9.2 1.4.8 2.2 1.6 2.6-.4-2.6-.2-5 .6-7.5ZM6 15.5c1.4 2.8 3.4 4.2 6 4.2s4.6-1.4 6-4.2c.4 3.4-2.4 6-6 6s-6.4-2.6-6-6Z" fill="currentColor" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 21 12 12 21 3 12Z" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M10.3 9.6a1.9 1.9 0 1 1 2.6 1.8c-.6.3-.9.7-.9 1.3v.6M12 15.4v.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>;
});

export const ItemArt = memo(function ItemArt({ id, item, size = 'md', title }: { id: string | null; item: CatalogItem | undefined; size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'; title?: string }) {
  const category = item?.category ?? 'unknown';
  return <span className={`item-art item-art-${size} cat-${category}`} title={title} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined} aria-label={title}>
    <span className="item-art-fallback"><CategoryGlyph category={category} /></span>
    <Picture src={item && id && /^upgrade_[A-Za-z0-9_]+$/.test(item.id) ? itemIconUrl(item.id) : null} />
  </span>;
});

export const HeroArt = memo(function HeroArt({ hero, variant = 'small', className = '' }: { hero: CatalogHero | undefined; variant?: 'small' | 'card' | 'vertical'; className?: string }) {
  return <span className={`hero-art hero-art-${variant} ${hero ? '' : 'hero-art-empty'} ${className}`} aria-hidden="true">
    <span className="hero-art-fallback">{hero ? initials(hero.name) : '?'}</span>
    <Picture src={hero ? heroArtUrl(hero.id, variant) : null} />
  </span>;
});

export const AbilityArt = memo(function AbilityArt({ label, size = 'md' }: { label: AbilityLabel | null; size?: 'sm' | 'md' }) {
  return <span className={`ability-art ability-art-${size}`} aria-hidden="true">
    <span className="ability-art-fallback">{label ? label.slot + 1 : '·'}</span>
    <Picture src={label ? abilityIconUrl(label.id) : null} />
  </span>;
});

export function RankPips({ rank, next = false }: { rank: number | null; next?: boolean }) {
  return <span className={`pips ${rank === null ? 'pips-unknown' : ''}`} aria-hidden="true">
    {[0, 1, 2].map((tier) => <i key={tier} className={rank !== null && tier < rank ? 'on' : next && rank !== null && tier === rank ? 'next' : ''} />)}
  </span>;
}

/** The companion crest: an art-deco keyhole inside a double diamond. */
export function Emblem({ size = 40 }: { size?: number }) {
  return <svg className="emblem" width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
    <defs>
      <linearGradient id="emblem-gold" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#f6d48a" /><stop offset=".55" stopColor="#d4a24c" /><stop offset="1" stopColor="#8f6a2c" />
      </linearGradient>
    </defs>
    <path d="M24 1.5 46.5 24 24 46.5 1.5 24Z" fill="#0f1311" stroke="url(#emblem-gold)" strokeWidth="1.4" />
    <path d="M24 7 41 24 24 41 7 24Z" fill="none" stroke="url(#emblem-gold)" strokeWidth=".7" opacity=".55" />
    <g stroke="url(#emblem-gold)" strokeWidth=".8" opacity=".7">
      <path d="M24 7v-3.5M24 41v3.5M7 24H3.5M41 24h3.5" />
      <path d="M15 15l-2.6-2.6M33 15l2.6-2.6M15 33l-2.6 2.6M33 33l2.6 2.6" />
    </g>
    <circle cx="24" cy="20.5" r="4.6" fill="url(#emblem-gold)" />
    <path d="M21.7 23.4 19.8 32.5h8.4l-1.9-9.1Z" fill="url(#emblem-gold)" />
  </svg>;
}

/** Static art-deco sunburst behind the recommended item. Painted once; never animated. */
export const Sunburst = memo(function Sunburst() {
  const rays = Array.from({ length: 24 }, (_, index) => {
    const angle = (index / 24) * Math.PI * 2;
    const spread = index % 2 ? Math.PI / 160 : Math.PI / 90;
    const reach = index % 2 ? 78 : 98;
    const point = (a: number, r: number) => `${(100 + Math.cos(a) * r).toFixed(1)} ${(100 + Math.sin(a) * r).toFixed(1)}`;
    return `M${point(angle, 30)} L${point(angle - spread, reach)} L${point(angle + spread, reach)}Z`;
  }).join(' ');
  return <svg className="sunburst" viewBox="0 0 200 200" aria-hidden="true">
    <defs>
      <radialGradient id="sunburst-fade">
        <stop offset=".3" stopColor="currentColor" stopOpacity="1" />
        <stop offset="1" stopColor="currentColor" stopOpacity="0" />
      </radialGradient>
    </defs>
    <path d={rays} fill="url(#sunburst-fade)" />
    <circle cx="100" cy="100" r="47" fill="none" stroke="currentColor" strokeWidth=".7" opacity=".9" />
    <circle cx="100" cy="100" r="52" fill="none" stroke="currentColor" strokeWidth=".35" strokeDasharray="1.5 2.5" opacity=".8" />
  </svg>;
});

/** Two deco arrows chasing each other: the reroll verdict's centrepiece. */
export function RerollMark() {
  return <span className="reroll-mark" aria-hidden="true">
    <svg viewBox="0 0 64 64">
      <circle cx="32" cy="32" r="30" fill="#120f0b" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="32" cy="32" r="25.5" fill="none" stroke="currentColor" strokeWidth=".5" opacity=".5" />
      <path d="M19 27a14 14 0 0 1 24.5-5.6" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="square" />
      <path d="M46.6 17.5 45.9 26l-8.3-2z" fill="currentColor" />
      <path d="M45 37a14 14 0 0 1-24.5 5.6" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="square" />
      <path d="M17.4 46.5 18.1 38l8.3 2z" fill="currentColor" />
    </svg>
  </span>;
}

/** A heading with a diamond glyph and a deco rule running to the optional aside. */
export function SectionTitle({ id, children, aside }: { id?: string; children: ReactNode; aside?: ReactNode }) {
  return <div className="section-title">
    <span className="section-diamond" aria-hidden="true" />
    <h2 id={id}>{children}</h2>
    <span className="section-rule" aria-hidden="true" />
    {aside != null && <span className="section-aside">{aside}</span>}
  </div>;
}
