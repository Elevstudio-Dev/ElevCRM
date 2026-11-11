---
impacto: capacidade_nova
secao: adicionado
titulo: "Puxar o histórico do WhatsApp de um contato e identificar o que veio de anúncio"
---

Novo botão **Puxar histórico do WhatsApp** (menu Opções da conversa e painel do contato). Ele busca no WhatsApp as mensagens antigas daquele contato, grava as que o CRM ainda não tem e marca com *Veio de anúncio* a mensagem que carregava o clique do anúncio — a mais antiga também marca o contato como vindo de anúncio. Nada é enviado ao cliente, a IA e as automações não reagem a mensagens antigas (migration 0226), as não lidas não mudam e rodar de novo não duplica. Anexos antigos entram sem o arquivo. As mensagens que chegam daqui em diante de um clique de anúncio também passam a ser marcadas na conversa. Exige que o armazenamento de histórico do WAHA esteja ligado (`WAHA_NOWEB_STORE=1`, desligado por padrão): ver `docs/runbooks/historico-do-whatsapp.md`.
