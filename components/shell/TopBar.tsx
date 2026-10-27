"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { ConnectionHealthDot } from "@/components/connections/ConnectionHealthDot";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { GRUPO_DAS_CONFIGURACOES, NAV_GROUPS, searchable } from "@/lib/navigation/registry";
import { Gear } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { BotaoDoChat } from "@/components/chat-interno/BotaoDoChat";

import { AbasPrincipais } from "./AbasPrincipais";
import { AlertsBell } from "./AlertsBell";
import { MarcaNaBarra } from "./MarcaNaBarra";
import { MenuMobile } from "./MenuMobile";
import { SearchTrigger } from "./SearchTrigger";
import { TenantSwitcher, useTemSeletorDeOrganizacao } from "./TenantSwitcher";
import { UserMenu } from "./UserMenu";

/**
 * A engrenagem: a segunda porta do produto, ao lado da busca.
 *
 * Leva ao inventário (`/app/settings`), que lista TODA tela de TODO grupo. A
 * bolinha de saúde das conexões mora aqui porque "Conexões" deixou de ser item
 * de menu — e ela era o único sinal ambiente de número caído que o operador
 * tinha sem abrir nada. Só aparece para quem enxerga Conexões (admin): para os
 * outros papéis a bolinha apontaria para uma tela que eles não têm.
 */
function AtalhoDeConfiguracoes() {
  const t = useT();
  const pathname = usePathname();
  const { user, activeOrg } = useAuth();
  const hub = NAV_GROUPS.find((g) => g.id === GRUPO_DAS_CONFIGURACOES)?.hub;
  if (!hub) return null;
  const ativo = pathname === hub.href || pathname.startsWith(hub.href + "/");
  const veConexoes = searchable(user.is_platform_admin, activeOrg?.role ?? null).some(
    (d) => d.healthDot,
  );
  return (
    <Link
      href={hub.href}
      title={t(hub.label)}
      aria-label={t(hub.label)}
      aria-current={ativo ? "page" : undefined}
      className={cn(
        // `hidden md:inline-flex`: no celular a engrenagem mora no rodapé da
        // gaveta. Medido em 390px: com ela aqui a barra dava 450px de largura
        // e a página inteira rolava de lado.
        "relative hidden h-11 w-11 items-center justify-center rounded-md transition-colors md:inline-flex lg:h-9 lg:w-9",
        ativo
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <Gear size={18} weight={ativo ? "fill" : "regular"} aria-hidden />
      {veConexoes && <ConnectionHealthDot className="absolute right-1 top-1" />}
    </Link>
  );
}

/**
 * A barra superior é a navegação inteira do desktop: marca, abas de uso
 * diário, busca, chat da equipe, avisos, Configurações e o menu do usuário —
 * nessa ordem.
 *
 * `sticky top-0` e `h-14`: a altura é subtraída pela grade do inbox
 * (`components/inbox/InboxLayout.tsx`, `h-[calc(100dvh-3.5rem)]`). Mudar uma
 * sem a outra faz o composer nascer fora da tela.
 */
export function TopBar() {
  const temSeletor = useTemSeletorDeOrganizacao();
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur md:gap-3 md:px-4">
      {/*
        SEM `shrink-0` neste grupo, e COM `min-w-0`: quem cede quando a linha
        aperta são as peças de LARGURA VARIÁVEL — o nome da marca e o nome da
        organização, ambos truncam. Tudo o que tem tamanho fixo (hambúrguer,
        selo, os botões da direita) é `shrink-0` ou tem piso. Um nome comprido,
        ou um logo largo, era o que fazia a página inteira rolar de lado
        (medido: 402px em 390), e a largura da barra não depende do nome de
        ninguém.
        ⚠️ O que o `min-w-0` NÃO faz: encolher quem está DENTRO do grupo. O
        grupo encolhe; um filho sem `min-w-0`/truncate não, e transborda para
        cima do vizinho. Foi assim que o seletor de organização (138px, um
        `Button` que não trunca) passou por cima de Buscar, Chat e Avisos.

        ORÇAMENTO (medido em 2026-10-27, tela de 375px = 351 úteis depois dos 12px de respiro de cada lado):
          direita   186  = busca 42 + chat 44 + avisos 44 + menu do usuário 44 + 3×4
          hambúrguer 44  = alvo de toque, nunca menos
          vão        8 + 4 entre os grupos
          sobra    ~109  para marca + seletor de organização
        Com idioma e tema também na barra, a direita eram 290 e a esquerda
        ficava com 45px: hambúrguer amassado em 16px, nome da marca nunca
        visível (nem em 390) e o seletor por cima dos botões. Por isso idioma e
        tema moram no menu do usuário abaixo de `lg` (ver `UserMenu`) — e
        quem aumentar a direita de novo precisa refazer esta conta e rodar
        `tests/e2e/barra-superior-nao-se-sobrepoe.spec.ts`.

        Com seletor de organização a marca (selo + nome) só aparece de `xl` em
        diante: abaixo disso o seletor precisa da largura inteira para mostrar
        o nome da organização — e saber em qual organização se está é o que
        importa antes do selo. Sem seletor a marca fica sempre, no piso do selo.
      */}
      <div className="flex min-w-0 items-center gap-1 md:gap-2">
        <MenuMobile />
        <MarcaNaBarra className={temSeletor ? "max-xl:hidden" : undefined} />
        <TenantSwitcher />
      </div>
      <AbasPrincipais className="hidden md:flex md:ml-2" />
      <div className="ml-auto flex shrink-0 items-center gap-1 md:gap-2">
        <SearchTrigger />
        <BotaoDoChat />
        <AlertsBell />
        <AtalhoDeConfiguracoes />
        <UserMenu />
      </div>
    </header>
  );
}
