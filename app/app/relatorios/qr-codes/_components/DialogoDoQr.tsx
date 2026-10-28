"use client";

import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import { useCriarQrCode, useEditarQrCode } from "@/hooks/qr-codes/useQrCodes";
import { mensagemComCodigo } from "@/lib/qr-codes/codigo";
import type { CanalDoQr, QrCodeRow } from "@/lib/schemas/qr-codes";

const MENSAGEM_PADRAO = "Olá! Gostaria de saber mais.";
const MAX_MENSAGEM = 300;
const MAX_NOME = 80;
/** No cadastro o código ainda não existe: ele nasce ao salvar. */
const CODIGO_AINDA_NAO_EXISTE = "······";

/**
 * Criar e editar um QR code.
 *
 * O número é um <select> nativo (e não o Select do Radix) de propósito: numa tela que o gestor usa de celular, a
 * lista nativa é a que abre bem, e ela é testável sem simular ponteiro.
 */
export function DialogoDoQr({
  qr,
  canais,
  onFechar,
}: {
  /** Ausente = criar. Presente = editar este. */
  qr?: QrCodeRow;
  canais: CanalDoQr[];
  onFechar: () => void;
}) {
  const t = useT();
  const criar = useCriarQrCode();
  const editar = useEditarQrCode();
  const comTelefone = canais.filter((c) => c.telefone);
  const [nome, setNome] = useState(qr?.nome ?? "");
  const [mensagem, setMensagem] = useState(qr?.mensagem ?? MENSAGEM_PADRAO);
  const [canalId, setCanalId] = useState(
    qr?.channel_session_id ?? comTelefone.find((c) => c.conectado)?.id ?? comTelefone[0]?.id ?? "",
  );
  const ocupado = criar.isPending || editar.isPending;
  const semNumero = comTelefone.length === 0;
  const pode = !semNumero && nome.trim() !== "" && mensagem.trim() !== "" && canalId !== "" && !ocupado;

  const salvar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pode) return;
    try {
      if (qr) {
        await editar.mutateAsync({ id: qr.id, nome, mensagem, channel_session_id: canalId });
        toast.success(t("QR code salvo"));
      } else {
        await criar.mutateAsync({ nome, mensagem, channel_session_id: canalId });
        toast.success(t("QR code criado"));
      }
      onFechar();
    } catch {
      // `onError` das mutações já mostrou o motivo; o diálogo fica aberto com o que a pessoa digitou.
    }
  };

  return (
    <Dialog open onOpenChange={(aberto) => !aberto && onFechar()}>
      <DialogContent className="max-w-lg">
        <form onSubmit={salvar} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{qr ? t("Editar QR code") : t("Novo QR code")}</DialogTitle>
            <DialogDescription>
              {t("Cada leitura, conversa e venda deste QR será contada no relatório.")}
            </DialogDescription>
          </DialogHeader>

          {semNumero && (
            <p role="alert" className="rounded-md bg-warning-bg px-3 py-2 text-sm text-warning-fg">
              {t("Conecte um número de WhatsApp antes de criar um QR code.")}{" "}
              <Link href="/app/connections" className="underline underline-offset-2">
                {t("Ir para Conexões")}
              </Link>
            </p>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="qr-nome">{t("Nome")}</Label>
            <Input
              id="qr-nome"
              value={nome}
              maxLength={MAX_NOME}
              placeholder={t("Cartaz da recepção")}
              onChange={(e) => setNome(e.target.value)}
              autoFocus
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="qr-numero">{t("Número de WhatsApp")}</Label>
            <select
              id="qr-numero"
              value={canalId}
              onChange={(e) => setCanalId(e.target.value)}
              disabled={semNumero}
              className="flex h-11 w-full rounded-sm border border-border bg-bg px-3 text-sm text-text focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-soft disabled:opacity-55 lg:h-10"
            >
              {comTelefone.map((c) => (
                <option key={c.id} value={c.id}>
                  {`${c.nome ?? "WhatsApp"} · ${c.telefone}${c.conectado ? "" : ` ${t("(desconectado)")}`}`}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="qr-mensagem">{t("Mensagem")}</Label>
              <span className="text-xs tabular-nums text-text-muted">
                {mensagem.length}/{MAX_MENSAGEM}
              </span>
            </div>
            <Textarea
              id="qr-mensagem"
              value={mensagem}
              maxLength={MAX_MENSAGEM}
              rows={3}
              onChange={(e) => setMensagem(e.target.value)}
            />
            <p data-testid="previa-da-mensagem" className="rounded-md bg-surface-elevated px-3 py-2 text-sm text-text">
              <span className="text-text-muted">{t("O cliente vai enviar:")}</span>{" "}
              {mensagemComCodigo(mensagem || MENSAGEM_PADRAO, qr?.codigo ?? CODIGO_AINDA_NAO_EXISTE)}
            </p>
            <p className="text-xs text-text-muted">
              {qr
                ? t("Mudar a mensagem vale para as próximas leituras. O código não muda — ele está impresso.")
                : t("O código é criado ao salvar.")}
            </p>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onFechar}>
              {t("Cancelar")}
            </Button>
            <Button type="submit" disabled={!pode}>
              {qr ? t("Salvar") : t("Criar QR code")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
