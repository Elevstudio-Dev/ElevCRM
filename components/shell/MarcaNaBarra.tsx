"use client";
import Link from "next/link";

import { SeloElev } from "@/components/branding/IconeElev";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useMarcaDaInstalacao } from "@/lib/branding/contexto";
import { cn } from "@/lib/utils";

/**
 * A marca no canto esquerdo da barra superior — logo quando há um, o nome
 * quando não há. Era o cabeçalho do menu lateral; o menu saiu e a marca ficou.
 *
 * O CONSUMIDOR do nome por organização.
 *
 * Sem ele, `settings.branding.app_name` seria campo decorativo: medido, o nome
 * da org não aparece em lugar nenhum da casca para o cliente típico de um
 * revendedor — o único leitor é o `TenantSwitcher`, e ele devolve `null` com
 * uma organização só.
 *
 * A marca da INSTALAÇÃO continua embaixo: a organização que não definiu nome
 * vê exatamente o que via antes. O que mudou é POR ONDE ela chega — era
 * `branding()`, que no navegador lê `window.__PUBLIC_ENV__` e no servidor lê
 * `process.env`, e essas duas fontes passaram a divergir quando o layout raiz
 * começou a injetar a marca do BANCO. Divergência entre SSR e cliente aqui não
 * é detalhe: com logo no banco e `APP_LOGO_URL` vazio, o servidor desenhava o
 * `<span>` de baixo e o cliente desenhava o `<img>` — React #418 em toda tela.
 * Hoje a marca vem por PROP do servidor (`useMarcaDaInstalacao`), pela mesma
 * rota de `activeOrg`, e os dois lados leem o mesmo objeto por construção.
 * A prova: `tests/unit/marca-sem-divergencia-de-hidratacao.test.tsx`.
 */
export function MarcaNaBarra({ className }: { className?: string }) {
  const { activeOrg } = useAuth();
  const brand = useMarcaDaInstalacao();
  const nome = activeOrg?.marca?.nome ?? brand.name;
  /**
   * `||` e não `??`: vazio é AUSÊNCIA de logo, não "logo em branco". É a regra
   * que `resolveBranding` e `primeiroDefinido` já aplicam nas camadas de baixo, e
   * com `??` um `""` vindo de cima apagaria o logo do revendedor em vez de
   * descer para ele — que é o contrário do que a precedência por campo promete.
   */
  const logo = activeOrg?.marca?.logoUrl || brand.logoUrl;

  // `min-w-0` (e nunca `shrink-0`): quando a barra aperta, é a marca que encolhe e trunca — ver o
  // comentário no `TopBar`. `className` é o que a barra manda quando a marca precisa SAIR por
  // inteiro (com o seletor de organização, abaixo de `xl`).
  return (
    <Link
      href="/app/inbox"
      data-marca-da-barra=""
      className={cn(
        "flex h-9 min-w-0 items-center gap-2 rounded-md px-1.5 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      aria-label={nome}
    >
      {/* O selo da Elev Studio fica SEMPRE: mesmo com o nome ou o logo da organização ao lado, quem
          abre o sistema vê de quem ele é. Decorativo — o nome ao lado já o rotula. */}
      <SeloElev />
      {logo ? (
        // <img> em vez de next/image de propósito: a URL vem de quem hospeda
        // (banco ou .env), e next/image exige allowlist de domínios fechada em
        // build — a imagem pré-buildada rejeitaria o domínio do self-hoster.
        // Altura fixa e largura livre porque a arte enviada tem proporção
        // desconhecida; forçar as duas distorceria o logo de quem configurou.
        // Larguras por faixa porque a barra do celular tem 390px para tudo:
        // hambúrguer, marca, busca, sino e menu do usuário. Um nome longo ou
        // um logo largo aqui é o que faz a página inteira rolar de lado.
        // `min-w-0`: um item de flex não encolhe abaixo do conteúdo (`min-width: auto`), e para uma
        // imagem o conteúdo é a largura dela. Medido com um logo de 400x100 (white-label): sem
        // `min-w-0` a imagem passava por cima da busca em 320, 360, 375 e 390px; com ele,
        // `object-contain` a reduz dentro da caixa que sobrou.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logo} alt={nome} className="h-7 min-w-0 w-auto max-w-[6rem] object-contain md:max-w-[10rem]" />
      ) : (
        <span className="max-w-[6rem] truncate font-heading font-semibold tracking-tight md:max-w-[12rem]">{nome}</span>
      )}
    </Link>
  );
}
