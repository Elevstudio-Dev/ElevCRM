"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { format } from "date-fns";
import { useT } from "@/hooks/i18n/useT";
import { ArrowBendUpLeft, Check, Checks, Robot, ShareFat, WarningOctagon } from "@/lib/ui/icons";
import { useDeslizarParaResponder } from "@/hooks/inbox/useDeslizarParaResponder";
import { foiEncaminhada, podeEncaminhar } from "@/lib/messaging/encaminhar";
import { CitacaoResumo } from "@/components/inbox/CitacaoResumo";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { Message } from "@/lib/types/messaging";
import { CitationButton } from "@/components/ai/CitationButton";
import { MediaRenderer } from "@/components/inbox/media/MediaRenderer";
import { ContactCard } from "@/components/inbox/media/ContactCard";
import {
  extractCitations,
  isAiGeneratedMessage,
} from "@/lib/ai/citations/types";

interface Props {
  message: Message;
  debugCitations?: boolean;
  /** Escolher esta mensagem para responder "em cima" dela. */
  onResponder?: (m: Message) => void;
  /** A mensagem citada por ESTA, quando houver — desenha o fio. */
  citada?: Message | null;
  /**
   * Tocar na citação leva até a mensagem ORIGINAL (rola o fio e a destaca). Sem isto a citação é só
   * texto: não vira botão, para não prometer um clique que não faz nada.
   */
  onIrParaMensagem?: (id: string) => void;
  /** Esta bolha acabou de ser o destino de um "ir para a citada": pisca para o olho achá-la. */
  destacada?: boolean;
  /** Começar a ENCAMINHAR a partir desta mensagem (botão ao passar o mouse; toque longo no celular). */
  onEncaminhar?: (m: Message) => void;
  /**
   * Modo de seleção (encaminhar): a bolha ganha a caixa de marcar e tocar nela alterna a marca. Fora
   * dele (`undefined`) nada muda. `motivo` diz por que uma mensagem não pode ser marcada.
   */
  selecao?: { marcada: boolean; podeMarcar: boolean; motivo?: string; aoAlternar: () => void };
  /**
   * Esta bolha ABRE um bloco de falas seguidas do mesmo lado?
   *
   * Só a primeira leva rabinho. É assim no WhatsApp e não é enfeite: o rabinho
   * marca onde a fala começa. Repetido em toda bolha ele vira ruído, e o bloco
   * perde a leitura de "isto tudo é a mesma pessoa falando seguido".
   *
   * O padrão é `true` porque uma bolha solta é, por definição, a primeira do
   * seu bloco — assim quem renderiza uma sozinha não precisa saber desta regra.
   */
  primeiraDoGrupo?: boolean;
}

/**
 * A CITAÇÃO, dentro da bolha e acima do texto — o fio.
 *
 * Mostra de quem era e um resumo (`CitacaoResumo`: a legenda, ou o ícone e o nome do tipo para áudio,
 * foto, vídeo…). `line-clamp-2` porque serve para reconhecer, não para reler: a original está no
 * histórico. Quando `aoIr` existe, tocar nela rola até a original e a destaca.
 *
 * A CITADA PODE TER SIDO APAGADA — e aí o texto dela não volta aqui. A bolha principal já trata isto:
 * "mostrá-lo seria expor justamente o que o cliente pediu para tirar do ar". A citação é o mesmo texto
 * num segundo lugar da tela; sem essa regra, o "apagar para todos" do cliente sumia da bolha original e
 * continuava legível dentro de cada resposta que a citou (a regra mora em `resumoDaCitacao`).
 */
function CitacaoNaBolha({
  citada,
  isOutbound,
  aoIr,
  rotuloDoAutor,
  rotuloDoBotao,
}: {
  citada: Message;
  isOutbound: boolean;
  aoIr?: (id: string) => void;
  rotuloDoAutor: string;
  rotuloDoBotao: string;
}) {
  const classes = cn(
    "mb-1 block w-full rounded-md border-l-2 px-2 py-1 text-left text-xs",
    isOutbound
      ? "border-[var(--chat-out-fg)]/50 bg-[var(--chat-out-fg)]/10"
      : "border-[var(--chat-out)] bg-black/[0.04] dark:bg-white/[0.06]",
    aoIr && "cursor-pointer transition-colors hover:bg-black/[0.08] focus-visible:outline-2 focus-visible:outline-ring dark:hover:bg-white/[0.1]",
  );
  const conteudo = (
    <>
      <span className="block font-medium opacity-80">{rotuloDoAutor}</span>
      <CitacaoResumo mensagem={citada} className="opacity-70" />
    </>
  );
  return aoIr ? (
    // O nome acessível é o TEXTO da citação precedido da ação — um `aria-label` o substituiria, e quem
    // usa leitor de tela perderia justamente o que está sendo citado.
    <button type="button" className={classes} onClick={() => aoIr(citada.id)}>
      <span className="sr-only">{rotuloDoBotao}: </span>
      {conteudo}
    </button>
  ) : (
    <div className={classes}>{conteudo}</div>
  );
}

function AckIndicator({ status, t }: { status: string; t: (texto: string) => string }) {
  if (status === "read") {
    return <Checks size={12} weight="bold" className="text-blue-400" aria-label={t("Lida")} />;
  }
  if (status === "delivered") {
    return <Checks size={12} weight="bold" className="text-current/70" aria-label={t("Entregue")} />;
  }
  if (status === "sent") {
    return <Check size={12} weight="bold" className="text-current/70" aria-label={t("Enviada")} />;
  }
  return null;
}

export function MessageBubble({
  message,
  debugCitations,
  onResponder,
  citada,
  onIrParaMensagem,
  destacada,
  onEncaminhar,
  selecao,
  primeiraDoGrupo = true,
}: Props) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const isOutbound = message.direction === "outbound";
  // Em seleção, a bolha só marca: responder e começar outro encaminhamento ficam de fora (os botões e
  // os gestos), senão tocar para marcar poderia abrir uma resposta.
  const emSelecao = Boolean(selecao);
  const responderDisponivel = Boolean(onResponder) && !emSelecao;
  const podeComecarAEncaminhar = Boolean(onEncaminhar) && !emSelecao && podeEncaminhar(message).ok;
  // Deslizar a mensagem para o lado responde, e segurá-la começa a encaminhar — como no WhatsApp do
  // celular. Só com toque; sem os callbacks (telas que não respondem) os gestos nem existem.
  const gesto = useDeslizarParaResponder(
    responderDisponivel ? () => onResponder!(message) : undefined,
    podeComecarAEncaminhar ? () => onEncaminhar!(message) : undefined,
  );
  // Encaminhar pelo mouse: um botão ao lado do de responder. No toque ele não aparece (o toque longo é o
  // caminho): dois ícones por bolha num telefone espremeriam o texto.
  const botaoEncaminhar = podeComecarAEncaminhar ? (
    <button
      type="button"
      onClick={() => onEncaminhar!(message)}
      aria-label={t("Encaminhar esta mensagem")}
      className={cn(
        "rounded-md p-1 text-muted-foreground transition-opacity hover:bg-muted",
        // `hover:` do Tailwind já só vale onde existe hover; no toque o botão nem aparece (o toque longo é o caminho).
        "[@media(hover:none)]:hidden",
        "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
      )}
    >
      <ShareFat size={14} />
    </button>
  ) : null;
  const time = format(new Date(message.sent_at), "HH:mm", { locale: localeDaData });
  const isFailed = message.status === "failed";
  const hasMedia = Boolean(message.media_url || message.media_storage_path);
  const isContact = message.type === "contact";
  // Figurinha sem caption: sem moldura de bolha (padrão WhatsApp).
  const isBareSticker = hasMedia && message.type === "sticker" && !message.body;
  // Apagada pelo autor ("apagar para todos"). A linha continua no histórico —
  // sumir com ela deixaria a resposta seguinte respondendo ao nada —, mas o
  // texto não aparece: mostrá-lo seria expor justamente o que o cliente pediu
  // para tirar do ar.
  const apagada = Boolean(message.revoked_at);
  const editada = Boolean(message.edited_at) && !apagada;
  const aiGenerated = isAiGeneratedMessage(message.metadata);
  const citations = extractCitations(message.metadata);
  const showCitationButton =
    isOutbound && aiGenerated && (debugCitations ?? false);
  const senderLabel = (() => {
    if (!isOutbound) return null;
    if (message.sent_via === "ai") return "IA";
    return null;
  })();
  /**
   * QUEM FALOU, dentro de um grupo.
   *
   * Numa conversa de grupo o `contact_id` da mensagem é o GRUPO, não a pessoa —
   * quem escreveu vem no metadata, gravado pela ingestão do canal
   * (`grupo_participante_nome`). Sem esta linha, dez pessoas falando num grupo
   * apareceriam como uma só, que é o mesmo que não mostrar grupo nenhum.
   *
   * Só no que ENTRA: no que sai, quem falou foi esta empresa, e o rótulo de
   * quem enviou já é o `senderLabel` acima.
   */
  const participanteDoGrupo = (() => {
    if (isOutbound) return null;
    const m = message.metadata as Record<string, unknown> | null | undefined;
    const nome = m?.grupo_participante_nome;
    if (typeof nome === "string" && nome.trim()) return nome.trim();
    // Sem nome, o número é melhor que nada: "5511..." ao menos distingue duas
    // pessoas falando. `@s.whatsapp.net`/`@c.us` fora, que é ruído de protocolo.
    const id = m?.grupo_participante;
    if (typeof id === "string" && id.trim()) return id.replace(/@.*$/, "");
    return null;
  })();

  return (
    <div
      // É por este atributo que "ir para a citada" acha a bolha no fio.
      data-mensagem-id={message.id}
      {...gesto.props}
      style={gesto.style}
      // Em seleção, tocar em qualquer lugar da linha alterna a marca — menos nos controles de dentro (o
      // player de áudio, a citação, "Ver texto"), que continuam fazendo o que fazem.
      onClick={
        selecao
          ? (e) => {
              if ((e.target as HTMLElement).closest("button, a, input, audio, video")) return;
              if (selecao.podeMarcar) selecao.aoAlternar();
            }
          : undefined
      }
      className={cn(
        "group relative flex w-full items-center gap-1 px-4",
        // Destino de "ir para a citada": a linha inteira tinge e volta, como no WhatsApp.
        "transition-colors duration-700",
        destacada && "bg-primary/15",
        // Em seleção: a caixa mora na margem esquerda (a linha ganha folga para ela) e a marcada tinge.
        selecao && "cursor-pointer pl-9",
        selecao?.marcada && "bg-primary/10",
        // O ESPAÇAMENTO CONTA A MESMA HISTÓRIA QUE O RABINHO: dentro de um
        // bloco as bolhas quase se encostam; entre blocos abre. É o que faz
        // "três mensagens seguidas do cliente" ser lido como um turno de fala,
        // e não como três eventos soltos.
        //
        // Mora aqui, e não num `space-y` do container, porque só esta linha
        // sabe se abre bloco — e `space-y` no pai brigaria com margem no filho.
        primeiraDoGrupo ? "pb-[2px] pt-2" : "py-[2px]",
        isOutbound ? "justify-end" : "justify-start",
      )}
    >
      {selecao && (
        <input
          type="checkbox"
          className="absolute left-3 top-1/2 size-4 -translate-y-1/2 accent-primary"
          checked={selecao.marcada}
          disabled={!selecao.podeMarcar}
          onChange={selecao.aoAlternar}
          aria-label={t("Selecionar mensagem")}
          title={selecao.motivo}
        />
      )}
      {/* A dica do gesto: a seta aparece de trás da bolha conforme ela anda, e fica cheia quando
          soltar já vale como "responder". Só existe durante o deslize. */}
      {gesto.progresso > 0 && (
        <span
          aria-hidden
          // `-left-9`: FORA da linha, à esquerda dela. A linha inteira anda para a direita junto com a
          // bolha, então a seta, presa a ela, sai de trás da borda da tela e entra à vista.
          className="pointer-events-none absolute -left-9 top-1/2 flex size-7 items-center justify-center rounded-full bg-muted text-muted-foreground"
          style={{ opacity: gesto.progresso, transform: `translateY(-50%) scale(${0.6 + 0.4 * gesto.progresso})` }}
        >
          <ArrowBendUpLeft size={14} />
        </span>
      )}
      {/*
        RESPONDER — aparece ao passar o mouse, como no WhatsApp Web.
        Fica FORA da bolha para não disputar espaço com o texto, e do lado de
        dentro da conversa (à esquerda no que sai, à direita no que entra), que
        é onde a mão já está.

        `opacity` e não `hidden`: esconder de verdade faria o layout pular
        quando o mouse entra. Em telas de toque não há hover — por isso
        `focus-visible` também revela, e o teclado alcança.
      */}
      {isOutbound && botaoEncaminhar}
      {responderDisponivel && isOutbound && (
        <button
          type="button"
          onClick={() => onResponder!(message)}
          aria-label={t("Responder a esta mensagem")}
          className={cn(
            "rounded-md p-1 text-muted-foreground transition-opacity hover:bg-muted",
            // VISÍVEL POR PADRÃO, e escondido só onde EXISTE hover.
            //
            // A primeira versão era `opacity-0` + `group-hover`, copiando o
            // WhatsApp Web. No celular isso deixa o botão invisível para
            // sempre: não há como passar o mouse, e `focus-visible` só chega
            // por teclado. Ou seja, a função sumia exatamente onde o dono
            // deste CRM mais atende.
            //
            // `@media (hover: hover)` pergunta pelo DISPOSITIVO, não pela
            // largura: um tablet largo com toque continua mostrando, e um
            // desktop estreito continua escondendo. Largura não é a pergunta.
            "opacity-100 [@media(hover:hover)]:opacity-0",
            "[@media(hover:hover)]:group-hover:opacity-100 focus-visible:opacity-100",
          )}
        >
          <ArrowBendUpLeft size={14} />
        </button>
      )}
      <div
        className={cn(
          // 65% e não 75%: linha longa demais cansa, e a largura curta é o que
          // faz o bloco de mensagens ter ritmo em vez de virar parede de texto.
          "max-w-[65%] text-sm",
          isBareSticker
            ? "px-0 py-0"
            : cn(
                // `rounded-lg` (8px) e não `rounded-2xl` (16px): a bolha muito
                // arredondada briga com o rabinho, que é reto.
                "inbox-bolha rounded-lg px-2.5 py-1.5",
                isOutbound
                  ? "inbox-bolha-saida bg-[var(--chat-out)] text-[var(--chat-out-fg)]"
                  : "inbox-bolha-entrada bg-[var(--chat-in)] text-[var(--chat-in-fg)]",
                // O canto DO RABINHO fica reto — é ele que vira o rabinho.
                primeiraDoGrupo &&
                  cn("inbox-bolha-rabinho", isOutbound ? "rounded-tr-none" : "rounded-tl-none"),
              ),
          // A MOLDURA DA FALHA SEGUE A MESMA REGRA DO TEXTO "Falhou".
          //
          // `border-destructive` é vermelho-tijolo (#a94a3c). Sobre a bolha de
          // entrada, que é clara, ele lê como erro. Sobre a de SAÍDA, que é a
          // cor da marca trocada em runtime, ele deixa de ler: medido com a
          // marca roxa (#604aa6 aplicado), o resultado é um contorno que parece
          // artefato, não alarme — e eu mesmo li como lavanda antes de medir.
          //
          // Do lado de saída a moldura herda o texto da bolha, que por
          // construção contrasta com ela. Quem diz "falhou" ali é o selo com
          // ícone, não a cor da borda.
          isFailed && (isOutbound ? "border border-[var(--chat-out-fg)]/60" : "border border-destructive"),
        )}
      >
        {/*
          A CITAÇÃO, dentro da bolha e acima do texto — o fio.

          Mostra de quem era e um trecho. `line-clamp-2` porque serve para
          reconhecer, não para reler: a original está logo acima no histórico.
        */}
        {/* "Encaminhada": esta mensagem veio de outra conversa. A marca é do CRM (o cliente recebe uma
            cópia comum) e serve a quem atende: saber que o que lê não foi dito ali. */}
        {foiEncaminhada(message.metadata) && (
          <span className="mb-0.5 flex items-center gap-1 text-[11px] italic opacity-70">
            <ShareFat size={11} aria-hidden />
            {t("Encaminhada")}
          </span>
        )}
        {citada && (
          // Botão só quando há para onde ir: sem `onIrParaMensagem` a citação é só texto, e um botão
          // que não faz nada é pior que nenhum.
          <CitacaoNaBolha
            citada={citada}
            isOutbound={isOutbound}
            aoIr={onIrParaMensagem}
            rotuloDoAutor={citada.direction === "outbound" ? t("Você") : t("Cliente")}
            rotuloDoBotao={t("Ir para a mensagem citada")}
          />
        )}
        {/*
          O nome de quem falou, só na PRIMEIRA bolha do bloco.
          Repetir em cada mensagem seguida da mesma pessoa é exatamente o que o
          agrupamento existe para evitar — e é assim que o WhatsApp faz.

          Cor própria e não `opacity`: sobre o fundo claro da bolha de entrada,
          um cinza esmaecido some, e o nome é a informação que faz a conversa de
          grupo ser legível.
        */}
        {participanteDoGrupo && primeiraDoGrupo && (
          <div
            className="mb-0.5 truncate text-xs font-semibold text-[var(--chat-out)]"
            title={participanteDoGrupo}
          >
            {participanteDoGrupo}
          </div>
        )}
        {senderLabel && (
          <div className="mb-0.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide opacity-80">
            {senderLabel === "IA" ? (
              <Robot size={10} weight="duotone" aria-hidden />
            ) : null}
            {senderLabel && t(senderLabel)}
          </div>
        )}

        {apagada ? (
          // Nem corpo nem mídia: o anexo apagado também sai. Em itálico e
          // esmaecido porque não é texto de ninguém — é o CRM narrando o que
          // aconteceu com aquele lugar da conversa.
          <p className="whitespace-pre-wrap break-words italic leading-snug opacity-60">
            {t("Esta mensagem foi apagada")}
          </p>
        ) : (
          <>
            {hasMedia && (
              <div className={cn(message.body && "mb-1")}>
                <MediaRenderer message={message} />
              </div>
            )}

            {isContact && !hasMedia && (
              <div className={cn(message.body && isContact && "mb-1")}>
                <ContactCard message={message} />
              </div>
            )}

            {message.body && !isContact && (
              <p className="whitespace-pre-wrap break-words leading-snug">{message.body}</p>
            )}
          </>
        )}

        <div
          className={cn(
            // `-mt-0.5` e não `mt-1`: a hora encosta na última linha do texto,
            // como no WhatsApp. Com folga inteira, a bolha ganha uma faixa vazia
            // que a faz parecer alta demais para o que diz.
            "-mt-0.5 flex items-center justify-end gap-1 text-[10px]",
            // A hora é referência, não conteúdo — no lado de saída ela herda a
            // cor do texto com opacidade, o que funciona em qualquer marca que
            // o revendedor escolher. Cor própria aqui exigiria uma segunda
            // rampa por marca, e a que envelhece primeiro é sempre a cópia.
            isOutbound ? "text-[var(--chat-out-fg)]/75" : "text-muted-foreground",
          )}
        >
          {editada && (
            // Ao lado da hora, não no corpo: o texto mostrado JÁ é o novo, e o
            // que falta é avisar que ele mudou. Sem isso, um combinado de preço
            // ou endereço é lido como se sempre tivesse dito aquilo — e a
            // divergência só aparece quando alguém cobra o que não foi.
            <span title={t("O autor editou esta mensagem")}>{t("editada")}</span>
          )}
          <span>{time}</span>
          {showCitationButton && (
            <CitationButton citations={citations} messageId={message.id} />
          )}
          {isOutbound && !isFailed && <AckIndicator status={message.status} t={t} />}
          {isFailed && (
            // Provider local: o painel do inbox não tem TooltipProvider ancestral e
            // este Tooltip só monta em mensagem failed — sem o provider, abrir uma
            // conversa com falha de envio derrubava o painel inteiro (error boundary).
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className={cn(
                      "inline-flex items-center gap-0.5 font-semibold",
                      // VERMELHO NÃO SOBREVIVE À COR DA MARCA. Na bolha de
                      // saída o fundo é `--chat-out`, que o revendedor troca em
                      // runtime — não há vermelho que tenha contraste contra
                      // todos. Medido a olho em 2026-09-04 com a accent padrão
                      // (verde-sálvia): "Falhou" ficava ilegível nos dois temas.
                      //
                      // Do lado de dentro da bolha, quem carrega o alarme é o
                      // ÍCONE e o peso da fonte; a cor herda o texto da bolha,
                      // que por construção já tem contraste com ela.
                      isOutbound ? "text-[var(--chat-out-fg)]" : "text-destructive",
                    )}
                  >
                    <WarningOctagon size={10} weight="fill" aria-hidden /> {t("Falhou")}
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {message.error_message ?? message.error_code ?? t("Erro desconhecido")}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      </div>
      {responderDisponivel && !isOutbound && (
        <button
          type="button"
          onClick={() => onResponder!(message)}
          aria-label={t("Responder a esta mensagem")}
          className={cn(
            "rounded-md p-1 text-muted-foreground transition-opacity hover:bg-muted",
            // VISÍVEL POR PADRÃO, e escondido só onde EXISTE hover.
            //
            // A primeira versão era `opacity-0` + `group-hover`, copiando o
            // WhatsApp Web. No celular isso deixa o botão invisível para
            // sempre: não há como passar o mouse, e `focus-visible` só chega
            // por teclado. Ou seja, a função sumia exatamente onde o dono
            // deste CRM mais atende.
            //
            // `@media (hover: hover)` pergunta pelo DISPOSITIVO, não pela
            // largura: um tablet largo com toque continua mostrando, e um
            // desktop estreito continua escondendo. Largura não é a pergunta.
            "opacity-100 [@media(hover:hover)]:opacity-0",
            "[@media(hover:hover)]:group-hover:opacity-100 focus-visible:opacity-100",
          )}
        >
          <ArrowBendUpLeft size={14} />
        </button>
      )}
      {!isOutbound && botaoEncaminhar}
    </div>
  );
}
