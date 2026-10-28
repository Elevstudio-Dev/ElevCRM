"use client";
import { useT } from "@/hooks/i18n/useT";
import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { Lightning, PaperPlaneTilt } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";
import { AttachMenu } from "@/components/inbox/composer/AttachMenu";
import { AttachmentPreviewDialog } from "@/components/inbox/composer/AttachmentPreviewDialog";
import { ContactPickerDialog } from "@/components/inbox/composer/ContactPickerDialog";
import { AudioRecorder } from "@/components/inbox/composer/AudioRecorder";
import { CitacaoResumo } from "@/components/inbox/CitacaoResumo";
import { DraftReplyButton } from "@/components/inbox/composer/DraftReplyButton";
import { EmojiButton } from "@/components/inbox/composer/EmojiButton";
import { PreencherParametrosDialog } from "@/components/inbox/composer/PreencherParametrosDialog";
import { resolveSlash, TemplateMenu } from "@/components/inbox/composer/TemplateMenu";
import { useCreateNote } from "@/hooks/inbox/useCreateNote";
import { useMessageTemplates, type MessageTemplate } from "@/hooks/inbox/useMessageTemplates";
import { X } from "lucide-react";
import { useSendMessage } from "@/hooks/inbox/useSendMessage";
import { useUploadMedia } from "@/hooks/inbox/useUploadMedia";
import { imagemDoClipboard } from "@/lib/inbox/clipboard-image";
import type { Message } from "@/lib/types/messaging";
import {
  extrairParametros,
  precisaDeJanela,
  preencher,
  valoresAutomaticos,
} from "@/lib/inbox/parametros-de-mensagem";
import { cn } from "@/lib/utils";

export interface ComposerHandle {
  focus: () => void;
}

interface Props {
  conversationId: string;
  disabled?: boolean;
  /** Set true when contact is blocked / anonymized — explanation shown. */
  blockedReason?: string | null;
  /**
   * Janela de 24h fechada: barra a RESPOSTA, e só ela.
   *
   * Separado de `blockedReason` porque a nota interna nunca chega ao cliente —
   * a regra da plataforma não a alcança, e barrá-la tira do atendente
   * justamente o lugar onde ele registra por que a conversa esfriou. A primeira
   * versão deste bloqueio usava `blockedReason` e levou a nota junto.
   */
  janelaFechada?: string | null;
  /**
   * A mensagem que esta resposta CITA, quando o atendente escolheu responder
   * "em cima" de uma. `null` = envio solto, o caso comum.
   *
   * Vem de fora e não daqui porque quem escolhe é a lista de mensagens: o
   * composer só precisa mostrar o que foi escolhido e mandá-lo junto.
   */
  respondendo?: Pick<
    Message,
    "id" | "body" | "direction" | "type" | "revoked_at" | "media_url" | "media_storage_path"
  > | null;
  /** Desfaz a escolha — o `x` da faixa de citação. */
  onCancelarResposta?: () => void;
  /** Nome do contato da conversa — preenche {{nome}}/{{primeiro_nome}} da mensagem pronta. */
  contactName?: string | null;
  /**
   * Nome de quem está atendendo — preenche {{atendente}}. Vem por prop, e não
   * de `useUser()`, para o composer não depender do provedor de autenticação:
   * ele é renderizado sozinho em vários testes, e o nome é só um texto.
   */
  attendantName?: string | null;
  /** Contato da conversa — excluído do seletor de cartão compartilhado. */
  currentContactId?: string | null;
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  {
    conversationId,
    disabled,
    blockedReason,
    janelaFechada,
    contactName,
    attendantName,
    currentContactId,
    respondendo,
    onCancelarResposta,
  },
  ref,
) {
  const t = useT();
  const [text, setText] = useState("");
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [contactPickerOpen, setContactPickerOpen] = useState(false);
  const [menuDismissed, setMenuDismissed] = useState(false);
  // O botão ⚡ abre o mesmo menu do `/`, sem exigir que o campo esteja vazio
  // nem que a pessoa saiba o atalho.
  const [menuForcado, setMenuForcado] = useState(false);
  // A mensagem pronta que ainda pede algo — enquanto não for `null`, a
  // janelinha está aberta.
  const [templateParaPreencher, setTemplateParaPreencher] = useState<MessageTemplate | null>(null);
  const [mode, setMode] = useState<"reply" | "note">("reply");
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const send = useSendMessage();
  const upload = useUploadMedia();
  const createNote = useCreateNote();
  const templates = useMessageTemplates();
  const slash = resolveSlash(text);
  const menuOpen = mode === "reply" && ((slash.open && !menuDismissed) || menuForcado);
  const valoresDaConversa = valoresAutomaticos({
    contato: { nome: contactName },
    atendente: { nome: attendantName },
  });

  useImperativeHandle(ref, () => ({
    focus: () => taRef.current?.focus(),
  }));

  // send/createNote fora do disable: o texto some na hora do envio; travar o campo
  // até a API voltar impedia digitar a próxima mensagem com o campo ainda cheio.
  const isDisabled = disabled || !!blockedReason || upload.isPending;
  // A janela só alcança o que SAI. Em modo nota o composer segue liberado: a
  // nota interna nunca chega ao cliente, e é onde o atendente registra por que
  // a conversa esfriou — barrá-la tira exatamente o que ainda dá para fazer.
  const respostaBarrada = isDisabled || (mode === "reply" && !!janelaFechada);

  function autoresize() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }

  function handleSubmit() {
    const body = text.trim();
    if (!body || (mode === "note" ? isDisabled : respostaBarrada)) return;

    setText("");
    requestAnimationFrame(() => autoresize());

    const restoreOnError = () => {
      setText(body);
      requestAnimationFrame(() => autoresize());
    };

    if (mode === "note") {
      createNote.mutate({ conversation_id: conversationId, body }, { onError: restoreOnError });
      return;
    }
    send.mutate(
      {
        conversation_id: conversationId,
        body,
        type: "text",
        ...(respondendo ? { reply_to_message_id: respondendo.id } : {}),
      },
      {
        onSuccess: () => {
          setText("");
          // A citação vale para UMA mensagem. Mantê-la depois do envio faria a
          // próxima frase sair citando algo que o atendente já respondeu.
          onCancelarResposta?.();
          requestAnimationFrame(() => autoresize());
        },
        // Do upstream, e fica: sem isto o texto some quando o envio falha, e
        // quem escreveu um parágrafo o perde sem ter como recuperá-lo.
        onError: restoreOnError,
      },
    );
  }

  /** O texto pronto entra no campo, com o cursor no fim — o envio é o botão de sempre. */
  function inserirTextoPronto(filled: string) {
    setText(filled);
    setMenuDismissed(true);
    setMenuForcado(false);
    const ta = taRef.current;
    if (!ta) return;
    requestAnimationFrame(() => {
      ta.focus();
      ta.selectionStart = ta.selectionEnd = filled.length;
      autoresize();
    });
  }

  /**
   * Escolheu uma mensagem pronta. Se tudo que ela pede já tem valor (contato e
   * atendente), entra direto, como sempre entrou. Se sobra algo — um parâmetro
   * livre como {{numero_pedido}}, ou um automático sem de onde vir —, abre a
   * janelinha. A regra é `precisaDeJanela` (lib/inbox/parametros-de-mensagem).
   */
  function applyTemplate(t: MessageTemplate) {
    const parametros = extrairParametros(t.body);
    if (precisaDeJanela(parametros, valoresDaConversa)) {
      setMenuDismissed(true);
      setMenuForcado(false);
      setTemplateParaPreencher(t);
      return;
    }
    inserirTextoPronto(preencher(t.body, valoresDaConversa));
  }

  function applyDraft(draft: string) {
    // O rascunho é uma resposta COMPLETA sugerida — substitui o conteúdo, nunca
    // concatena (inserir no cursor grudaria dois textos completos, gerando uma
    // mensagem sem sentido). O vendedor edita/envia a partir daqui.
    setText(draft);
    requestAnimationFrame(() => {
      taRef.current?.focus();
      autoresize();
    });
  }

  /**
   * Ctrl/Cmd+V com imagem no clipboard cai no MESMO caminho do menu "+":
   * abre o preview com legenda e envia por ali. Nada de atalho paralelo — a
   * validação, o toast de erro e o retry já vivem lá.
   *
   * As três guardas antes de olhar o clipboard não são zelo: em "Nota interna"
   * não existe anexo (a nota é só texto e o envio nem passa pelo upload), com
   * um anexo já em preview a colagem substituiria em silêncio o que o operador
   * escolheu, e desabilitado é desabilitado. Em qualquer um desses casos o
   * Ctrl+V precisa continuar sendo o Ctrl+V de sempre.
   */
  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (mode !== "reply" || respostaBarrada || pendingFile) return;
    const imagem = imagemDoClipboard(e.clipboardData, new Date());
    if (!imagem) return; // colagem de texto segue o caminho normal do browser
    e.preventDefault();
    setPendingFile(imagem);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape" && menuOpen) {
      setMenuDismissed(true);
      setMenuForcado(false);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (menuOpen) return; // deixa o Enter pro menu; não envia /query como mensagem
      handleSubmit();
    }
  }

  if (blockedReason) {
    return (
      <div className="border-t border-border bg-muted/40 px-4 py-3 text-center text-xs text-muted-foreground">
        {blockedReason}
      </div>
    );
  }

  return (
    <>
      <div
        className={cn(
          "relative border-t border-border bg-background px-3 py-2",
          mode === "note" && "border-warning/40 bg-warning-bg",
        )}
      >
        <TemplateMenu
          open={menuOpen}
          query={slash.open ? slash.query : ""}
          templates={templates.data ?? []}
          carregando={templates.isLoading}
          onPick={applyTemplate}
          onClose={() => {
            setMenuDismissed(true);
            setMenuForcado(false);
          }}
        />
        <div className="mb-1.5 flex gap-1">
          <button
            type="button"
            onClick={() => setMode("reply")}
            className={cn(
              "rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
              mode === "reply"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            {t("Responder")}
          </button>
          <button
            type="button"
            onClick={() => setMode("note")}
            className={cn(
              "rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
              mode === "note"
                ? "bg-warning text-warning-fg"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            {t("Nota interna")}
          </button>
        </div>
        {/*
          A FAIXA DA CITAÇÃO — o que o atendente escolheu responder.

          Fica ACIMA do campo, como no WhatsApp, e não dentro dele: o texto
          citado pode ter várias linhas, e empurrá-lo para dentro do campo faria
          o que se digita disputar espaço com o que se cita.

          `line-clamp-2` porque o objetivo é reconhecer qual mensagem é, não
          relê-la — ela está logo acima, no fio.
        */}
        {respondendo && mode === "reply" && (
          <div className="mb-1 flex items-start gap-2 rounded-md border-l-2 border-primary bg-muted/60 px-2 py-1.5">
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-medium text-primary">
                {respondendo.direction === "outbound" ? t("Você") : t("Cliente")}
              </div>
              <CitacaoResumo mensagem={respondendo} className="text-xs text-muted-foreground" />
            </div>
            <button
              type="button"
              onClick={onCancelarResposta}
              aria-label={t("Cancelar resposta")}
              className="rounded-md p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
        )}
        <div className="flex items-end gap-2">
          {/*
            A PÍLULA. Os três botões e o campo moram DENTRO dela, como no
            WhatsApp — e não é gosto: com os ícones do lado de fora, o campo
            fica sendo mais uma caixa numa tela cheia de caixas, e a barra de
            escrever deixa de ser reconhecível de relance. Dentro, o conjunto
            vira uma peça só, e o olho acha onde digitar sem procurar.

            O botão de enviar fica FORA de propósito: ele é a ação, não o
            campo. É a mesma separação que o WhatsApp faz.
          */}
          <div className="flex flex-1 items-end gap-0.5 rounded-3xl bg-[var(--chat-in)] px-1.5 py-1 shadow-[var(--chat-bolha-sombra)]">
          {mode === "reply" && (
            <AttachMenu
              disabled={respostaBarrada}
              onPick={setPendingFile}
              onPickContact={() => setContactPickerOpen(true)}
            />
          )}
          {mode === "reply" && (
            <DraftReplyButton conversationId={conversationId} disabled={isDisabled} onDraft={applyDraft} />
          )}
          {mode === "reply" && (
            // Quem vem do WhatsApp não sabe que `/` abre um menu. O raio abre
            // o mesmo menu — e é o ícone que o WhatsApp Business usa para isto.
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-9 w-9 shrink-0"
              aria-label={t("Mensagens prontas")}
              title={t("Mensagens prontas")}
              aria-expanded={menuOpen}
              disabled={respostaBarrada}
              onClick={() => {
                setMenuForcado((v) => !v);
                setMenuDismissed(false);
              }}
            >
              <Lightning size={18} weight={menuOpen ? "fill" : "regular"} aria-hidden />
            </Button>
          )}
          <EmojiButton
            disabled={isDisabled}
            onPick={(emoji) => {
              const ta = taRef.current;
              if (!ta) {
                setText((t) => t + emoji);
                return;
              }
              const start = ta.selectionStart ?? text.length;
              const end = ta.selectionEnd ?? text.length;
              const next = text.slice(0, start) + emoji + text.slice(end);
              setText(next);
              requestAnimationFrame(() => {
                ta.focus();
                ta.selectionStart = ta.selectionEnd = start + emoji.length;
                autoresize();
              });
            }}
          />
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (!resolveSlash(e.target.value).open) setMenuDismissed(false);
              autoresize();
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            rows={1}
            // O atalho saiu do placeholder e foi para o diálogo de atalhos (`?`)
            // e para o `title` aqui. Dois motivos, nesta ordem: ele some assim
            // que se digita a primeira letra — isto é, some justamente quando
            // você ia quebrar linha —; e, com a coluna do inbox mais estreita
            // depois do conserto do layout, a frase quebrava em duas linhas
            // dentro de um campo de uma linha só.
            //
            // "(só o time vê)" FICA: não é atalho, é consequência. Quem escreve
            // uma nota interna precisa saber que ela não vai para o cliente, e
            // essa informação não pode depender de abrir um diálogo.
            placeholder={
              mode === "note" ? t("Escreva uma nota interna… (só o time vê)") : t("Escreva uma mensagem…")
            }
            title={
              mode === "note"
                ? t("Enter salva a nota · Shift+Enter quebra linha")
                : t("Enter envia · Shift+Enter quebra linha")
            }
            className={cn(
              // Sem borda e sem fundo: a pílula em volta é que desenha o campo.
              // Sem anel de foco TAMBÉM — um anel dentro da pílula desenharia
              // uma segunda moldura por cima da primeira.
              "min-h-9 max-h-40 flex-1 resize-none border-0 bg-transparent px-2 py-2 text-sm",
              "placeholder:text-muted-foreground focus:outline-hidden focus:ring-0",
            )}
            disabled={mode === "note" ? isDisabled : respostaBarrada}
            aria-label={t("Mensagem")}
          />
          </div>
          {text.trim() || mode === "note" ? (
            <Button
              type="button"
              size="icon"
              className="size-10 shrink-0 rounded-full"
              onClick={handleSubmit}
              disabled={(mode === "note" ? isDisabled : respostaBarrada) || !text.trim()}
              aria-label={t("Enviar")}
            >
              <PaperPlaneTilt size={16} weight="fill" aria-hidden />
            </Button>
          ) : (
            <AudioRecorder conversationId={conversationId} disabled={respostaBarrada} />
          )}
        </div>
      </div>
      <PreencherParametrosDialog
        template={templateParaPreencher}
        valoresIniciais={valoresDaConversa}
        onUsar={(texto) => {
          setTemplateParaPreencher(null);
          inserirTextoPronto(texto);
        }}
        onCancelar={() => setTemplateParaPreencher(null)}
      />
      <AttachmentPreviewDialog
        file={pendingFile}
        sending={upload.isPending || send.isPending}
        onCancel={() => setPendingFile(null)}
        onSend={async (caption) => {
          if (!pendingFile) return;
          try {
            const uploaded = await upload.mutateAsync({ conversationId, file: pendingFile });
            send.mutate(
              {
                conversation_id: conversationId,
                type: uploaded.kind,
                body: caption || undefined,
                media_storage_path: uploaded.storage_path,
                media_mime: uploaded.media_mime,
                media_size_bytes: uploaded.media_size_bytes,
              },
              { onSuccess: () => setPendingFile(null) },
            );
          } catch {
            // toast já disparado pelo onError de useUploadMedia; dialog fica aberto p/ retry
            return;
          }
        }}
      />
      <ContactPickerDialog
        open={contactPickerOpen}
        onOpenChange={setContactPickerOpen}
        excludeContactId={currentContactId}
        sending={send.isPending}
        onPick={(payload) => {
          send.mutate(
            {
              conversation_id: conversationId,
              type: "contact",
              metadata: payload.contactId
                ? { shared_contact_id: payload.contactId }
                : {
                    shared_contact: {
                      name: payload.name,
                      phone_number: payload.phone_number,
                    },
                  },
            },
            { onSuccess: () => setContactPickerOpen(false) },
          );
        }}
      />
    </>
  );
});
