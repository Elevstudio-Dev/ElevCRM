"use client";
import type { ReactNode } from "react";
import { TopBar } from "@/components/shell/TopBar";
import { useInboundMessageAlerts } from "@/hooks/notifications/useInboundMessageAlerts";
import { useCrmAlerts } from "@/hooks/notifications/useCrmAlerts";
import { useNotifyOpenFromServiceWorker } from "@/lib/notifications/notify_open";

interface AppShellProps {
  children: ReactNode;
}

/**
 * A casca do app do tenant: barra superior + conteúdo. Só isso.
 *
 * ⚠️ O MENU LATERAL FOI REMOVIDO (2026-09-10). Ele ocupava 240px (64
 * recolhido) de toda tela, e a tela que importa — o inbox — é a que mais
 * sentia: em 1280px sobravam 1040 para três colunas. Toda a navegação passou
 * para a barra superior (abas de uso diário) e para Configurações (o
 * inventário). Ver `lib/navigation/registry.ts`.
 *
 * Com a barra fora, o `flex` horizontal e o `min-w-0` que existiam para a
 * coluna de conteúdo dividir a linha com ela deixaram de ter razão de ser: o
 * conteúdo É a linha.
 */
export function AppShell({ children }: AppShellProps) {
  useInboundMessageAlerts();
  useCrmAlerts();
  useNotifyOpenFromServiceWorker();
  return (
    <div className="flex h-dvh min-h-0 w-full flex-col bg-background">
      <TopBar />
      {/*
        `p-6` é a moldura padrão de toda tela. A EXCEÇÃO é declarada pela
        própria tela, não decidida aqui por rota: quem renderiza um filho com
        `data-tela-cheia` (o inbox) recebe o `main` sem moldura, de borda a
        borda. É CSS puro (`:has`), então servidor e navegador pintam o mesmo
        — não há estado de cliente para divergir e piscar.

        A alternativa era o `main` olhar o `pathname`, e aí a casca passaria a
        conhecer rotas — a mesma acoplagem que o registro de navegação existe
        para evitar.
      */}
      {/*
        `h-dvh` na raiz e `min-h-0` aqui, e NÃO `min-h-screen` na raiz — e isto
        é correção, não estilo. `h-full` só resolve contra pai de altura
        DEFINIDA. Com o menu lateral (`h-screen`, item de uma LINHA flex), a
        coluna de conteúdo era esticada e ganhava altura definida por
        tabela; ao virar coluna única com `min-h-screen`, todo `h-full` abaixo
        passou a resolver como `auto` — e o canvas do construtor de follow-up
        (React Flow, que exige altura explícita) nasceu com 0px. Medido pela
        E2E: cinco specs de follow-up com `.react-flow` "hidden". A raiz
        definida devolve a cadeia; `min-h-0` deixa o `main` encolher e rolar.

        `min-h-0` NA RAIZ também, por outro motivo: ela é item de uma coluna de
        `100dvh` (`app/app/layout.tsx`) que divide a tela com os avisos de
        impersonate e de conexão caída. `h-dvh` continua sendo a altura que ela
        PEDE; o `min-h-0` é o que deixa o flex encolhê-la pelo tamanho do aviso
        em vez de empurrar o fim da página para baixo da dobra. A altura
        resultante segue DEFINIDA (item de flex num contêiner de altura definida),
        então o `h-full` de quem está abaixo continua resolvendo.
      */}
      <main className="min-h-0 flex-1 overflow-auto p-6 [&:has([data-tela-cheia])]:p-0">{children}</main>
    </div>
  );
}
