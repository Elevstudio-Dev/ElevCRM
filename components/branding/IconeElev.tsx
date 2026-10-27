import { ICONE_ELEV } from "@/lib/branding/elev/icone";

/**
 * O ícone da Elev Studio. Um SVG só, em `currentColor`: quem usa escolhe a cor pelo `text-*` do pai
 * (branco sobre o roxo na barra, roxo sobre o claro na tela de entrada).
 *
 * Decorativo por padrão (`aria-hidden`): ao lado dele há sempre o nome do produto em texto. Passe
 * `titulo` só quando o ícone aparecer sozinho — aí ele vira uma imagem com nome.
 */
export function IconeElev({ className, titulo }: { className?: string; titulo?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${ICONE_ELEV.largura} ${ICONE_ELEV.altura}`}
      fill="currentColor"
      className={className}
      role={titulo ? "img" : undefined}
      aria-label={titulo}
      aria-hidden={titulo ? undefined : true}
      focusable="false"
    >
      <g transform={ICONE_ELEV.transformacao} stroke="none">
        {ICONE_ELEV.caminhos.map((d) => (
          <path key={d.slice(0, 16)} d={d} />
        ))}
      </g>
    </svg>
  );
}

/**
 * O selo da marca: o ícone branco num ladrilho da cor de ação. É a identidade da Elev Studio que não
 * muda de organização para organização — a cor acompanha a marca da instalação (`bg-accent`), o
 * desenho é sempre o mesmo.
 */
export function SeloElev({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center rounded-lg bg-accent text-accent-fg ${className ?? "h-7 w-7"}`}
    >
      <IconeElev className="h-[58%] w-[58%]" />
    </span>
  );
}
