"use client";
import { useState } from "react";
import { z } from "zod";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConviteDoResponsavel } from "@/components/admin/tenants/ConviteDoResponsavel";
import { useOwnerInvite, type ConviteEmitido as Convite } from "@/hooks/useOwnerInvite";
import { ApiError } from "@/lib/api/types";
import { useT } from "@/hooks/i18n/useT";

const emailSchema = z.string().trim().email();

interface OwnerInviteDialogProps {
  open: boolean;
  onClose: () => void;
  organizationId: string;
}

/**
 * Gera (ou gera de novo) o convite de ADMIN do responsável por um tenant.
 *
 * O papel não é escolhido aqui: "responsável" é sempre admin, e o servidor fixa isso.
 * Pedir só o e-mail evita que a tela vire um "convide quem quiser para o papel que quiser".
 */
export function OwnerInviteDialog({ open, onClose, organizationId }: OwnerInviteDialogProps) {
  const t = useT();
  const [email, setEmail] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [convite, setConvite] = useState<Convite | null>(null);
  const invite = useOwnerInvite(organizationId);

  const valido = emailSchema.safeParse(email).success;

  function fechar() {
    setEmail("");
    setErro(null);
    setConvite(null);
    onClose();
  }

  function gerar() {
    setErro(null);
    invite.mutate(email.trim(), {
      onSuccess: (res) => setConvite(res.data.owner_invite),
      onError: (err) => {
        // 409 = o tenant não está ativo. Dizer isso (e o que fazer) vale mais que "erro".
        if (err instanceof ApiError && err.status === 409) {
          setErro(t("Só tenants ativos recebem convite. Reative o tenant antes."));
        } else {
          setErro(t("Erro ao gerar o convite. Tente novamente."));
        }
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={(aberto) => { if (!aberto) fechar(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Convidar responsável")}</DialogTitle>
          <DialogDescription>
            {t(
              "Gera um convite de administrador para esta organização. O responsável cria a conta pelo link, com este mesmo e-mail, e entra direto nela.",
            )}
          </DialogDescription>
        </DialogHeader>

        {convite ? (
          <ConviteDoResponsavel convite={convite} />
        ) : (
          <div className="space-y-1.5 py-2">
            <Label htmlFor="owner-invite-email">{t("E-mail do responsável")}</Label>
            <Input
              id="owner-invite-email"
              type="email"
              autoComplete="off"
              placeholder="responsavel@empresa.com"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setErro(null);
              }}
              aria-invalid={erro ? true : undefined}
            />
            {erro && (
              <p className="text-xs text-destructive" role="alert">
                {erro}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={fechar}>
            {convite ? t("Fechar") : t("Cancelar")}
          </Button>
          {!convite && (
            <Button type="button" onClick={gerar} disabled={!valido || invite.isPending}>
              {invite.isPending ? t("Gerando...") : t("Gerar convite")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
