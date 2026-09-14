---
impacto: nada_mudou
secao: corrigido
titulo: Conexões deixa de dizer "Verificado" quando o WhatsApp recusou a verificação
---

O card de um número em Conexões carimbava "Verificado <hora>" mesmo quando o
transporte do WhatsApp tinha recusado a pergunta — chave de API errada (401)
ou serviço fora do ar. O status mostrado era o último conhecido, e a tela não
dizia isso: um número podia aparecer "Conectado · Verificado agora" enquanto
nenhuma mensagem saía, e só o "Reconectar" entregava o erro. Agora, quando a
verificação falha, o card mostra "Não verificado" com o motivo (chave recusada
ou serviço sem resposta) no lugar da hora; quando volta a passar, a hora volta.
