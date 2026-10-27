import { IconeElev } from "@/components/branding/IconeElev";

/**
 * O painel de marca da tela de entrada: o roxo da Elev Studio, o ícone e uma frase — o que quem abre
 * o sistema vê ANTES de entrar. É a fachada do produto, desenhada como os posts da Elev (fundo roxo,
 * grade fina, brilho nos cantos, títulos em IBM Plex Sans).
 *
 * Só em telas largas (`lg:`): no celular a coluna do formulário já é a tela inteira, e um painel
 * empurraria o campo de e-mail para fora da primeira dobra. Lá o selo da marca aparece acima do
 * formulário (ver `app/(public)/layout.tsx`).
 *
 * A cor vem da RAMPA da marca (`--color-accent-600…800`), não de um hex: se a instalação trocar a cor em
 * `/admin/marca`, o painel acompanha. As paradas 600-800 são as mesmas nos dois temas, então o painel é
 * igual no claro e no escuro — o texto branco fica sempre sobre um fundo escuro.
 */
const FUNDO = {
  backgroundImage:
    "linear-gradient(165deg, var(--color-accent-600) 0%, var(--color-accent-700) 58%, var(--color-accent-800) 100%)",
} as const;

/** A grade fina dos posts da Elev: linhas de 1px a cada 56px, quase invisíveis. */
const GRADE = {
  backgroundImage:
    "linear-gradient(to right, rgb(255 255 255 / 0.07) 1px, transparent 1px), linear-gradient(to bottom, rgb(255 255 255 / 0.07) 1px, transparent 1px)",
  backgroundSize: "56px 56px",
  maskImage: "radial-gradient(ellipse at 30% 40%, #000 25%, transparent 78%)",
  WebkitMaskImage: "radial-gradient(ellipse at 30% 40%, #000 25%, transparent 78%)",
} as const;

export function PainelDaMarca({
  produto,
  titulo,
  destaque,
  texto,
  assinatura,
}: {
  /** O nome do produto na instalação ("Elev CRM"). */
  produto: string;
  /** A primeira parte da frase, em peso médio. */
  titulo: string;
  /** A segunda parte, em negrito — o que o olho deve ler primeiro. */
  destaque: string;
  texto: string;
  assinatura: string;
}) {
  return (
    <aside
      data-testid="painel-da-marca"
      className="relative isolate hidden overflow-hidden text-white lg:flex lg:flex-col lg:justify-between lg:p-12 xl:p-16"
      style={FUNDO}
    >
      <div aria-hidden className="absolute inset-0 -z-10" style={GRADE} />
      <div aria-hidden className="absolute -right-28 -top-28 -z-10 h-[26rem] w-[26rem] rounded-full bg-white/20 blur-3xl" />
      <div aria-hidden className="absolute -bottom-36 -left-28 -z-10 h-[26rem] w-[26rem] rounded-full bg-white/10 blur-3xl" />

      <div className="flex items-center gap-3">
        <IconeElev className="h-10 w-10" />
        <span className="font-heading text-sm font-semibold uppercase tracking-[0.2em]">Elev Studio</span>
      </div>

      <div className="max-w-lg space-y-6">
        <p className="font-heading text-xs font-medium uppercase tracking-[0.24em] text-white/70">{produto}</p>
        <p className="font-heading text-4xl leading-[1.15] xl:text-5xl">
          <span className="font-medium">{titulo}</span> <span className="font-bold">{destaque}</span>
        </p>
        <p className="max-w-md text-lg leading-relaxed text-white/80">{texto}</p>
      </div>

      <p className="font-heading text-xs uppercase tracking-[0.2em] text-white/70">{assinatura}</p>
    </aside>
  );
}
