# Histórico do WhatsApp: "Puxar histórico" e o armazenamento do WAHA

O botão **Puxar histórico do WhatsApp** (menu **Opções** da conversa e painel lateral do contato) traz para o CRM as
mensagens antigas de **um** contato e marca as que vieram de anúncio. Este runbook explica o que o botão precisa para
funcionar, o que ele faz e o que ele não faz.

## O que precisa estar ligado

O CRM só consulta o passado de um chat se o **WAHA** o guardou. No engine NOWEB isso é o **store**:
`config.noweb.store.enabled=true` na sessão. Sem ele o WAHA responde `400 Enable NOWEB store…`, e o botão mostra
"O WhatsApp desta empresa ainda não guarda o histórico" (HTTP 409, `history_unavailable`).

Por padrão o store fica **desligado**. Guardar o histórico do número inteiro gasta disco e memória no contêiner do WAHA
e mantém, fora do banco do CRM, conversas de gente que nunca virou contato. É decisão do dono da instalação.

### Ligar

1. No `.env` da instalação: `WAHA_NOWEB_STORE=1`.
2. Reiniciar o app (`docker compose up -d app`). Na próxima conexão da sessão o CRM converge a configuração do WAHA
   (`convergirConfigDaSessao`) e a sessão reinicia **uma vez**.
3. Para trazer também o que **já existia** antes de ligar, é preciso **parear o número de novo** (QR): o
   `fullSync` só pede o passado ao aparelho na primeira conexão da sessão. Numa sessão que já estava pareada, ligar o
   store passa a guardar o que chegar **dali em diante**.

> Estado de prova: o código e os testes cobrem o contrato (a rota, a tradução, a gravação e a ausência de efeitos). Que
> o `fullSync` traga o passado de um número já em uso **ainda não foi provado contra uma instalação real**. A primeira
> vez, faça com um contato de teste e confira o resultado no próprio diálogo antes de depender disso.

### Desligar

Tirar `WAHA_NOWEB_STORE` do `.env` e reiniciar o app **não** apaga o que o WAHA já guardou; só para de pedir. Para apagar
o histórico guardado, remova e reponha a sessão (isso desconecta o número).

## O que o botão faz

- Busca no WAHA, página a página, as mensagens do chat do contato (no máximo 2.000, as mais recentes) e grava as que o CRM
  ainda não tem. Roda por **um contato por clique**, por alguém da equipe (atendente ou acima). Não existe importação em
  massa.
- **Não duplica**: a mesma mensagem pode estar gravada sob dois ids (o do webhook e o que o envio do CRM devolve); a
  importação reconhece os dois. Pode ser repetida à vontade.
- **Identifica o anúncio**: a mensagem que carregava o clique de "Conversar no WhatsApp" ganha a marca
  *Veio de anúncio · título*. Se a mensagem já estava no CRM sem a marca, a importação a completa. A mais antiga carimba o
  contato (primeiro toque, a mesma regra da entrada ao vivo).

## O que o botão NÃO faz

- **Não envia nada ao cliente.** Nada sai pelo WhatsApp.
- **Não aciona a IA, automações, sentimento nem follow-up.** O gatilho do banco não emite o evento de "mensagem nova"
  para linha marcada `metadata.historico_importado` (migration 0226), e a importação não chama os efeitos pós-entrada.
- **Não mexe nas "não lidas"** e não faz a conversa parecer mais antiga do que é.
- **Não traz o arquivo** de fotos, áudios e documentos antigos: a linha existe e a bolha diz "Anexo antigo — o arquivo
  não foi importado".
- **Não importa grupos** (mensagem de gente que nunca falou com a empresa é decisão de produto e de LGPD).
- **Não funciona em canal que só entrega o futuro** (API oficial da Meta): responde 422 `history_not_supported`.

## Diagnóstico

| O que aparece | Causa | O que fazer |
|---|---|---|
| "ainda não guarda o histórico" (409) | store do WAHA desligado | Ligar conforme acima |
| "Não foi possível falar com o WhatsApp" (502) | WAHA fora do ar ou lento | Tentar de novo; ver o contêiner do WAHA |
| "Este contato não tem um número de WhatsApp" (422) | contato sem telefone nem id opaco | Completar o telefone do contato |
| "O WhatsApp não tem mensagens antigas deste contato" | store ligado, mas o chat não tem passado guardado | Esperado se o store foi ligado depois e o número não foi pareado de novo |

A importação é registrada na auditoria como `contact.history_imported` (quem, qual contato e as contagens; nunca o texto).
