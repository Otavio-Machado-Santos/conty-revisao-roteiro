# Renovação de um pedido expirado

A revisão externa Claude Opus 5.5 encontrou uma transição ausente: após vencer o prazo, o criador não podia reenviar e a marca não podia emitir outro pedido. A correção permite à mesma marca solicitar novamente as alterações da versão atual, somente quando o pedido anterior expirou. Não há estado, ator ou rota nova.

O pedido permanece em `changes_requested` durante a espera. `change_request_status` é uma projeção de resposta, calculada pelo relógio e não gravada no snapshot:

| Situação da versão atual | `state` | `change_request_status` |
| --- | --- | --- |
| Sem pedido pendente | `awaiting_review` | `null` |
| Pedido dentro do prazo, incluindo o último milissegundo | `changes_requested` | `active` |
| Pedido depois do prazo | `changes_requested` | `expired` |
| Revisão encerrada | `approved` | `null` |

Por exemplo, com prazo `2026-03-13`, um trecho do GET em `2026-03-14T03:00:00.000Z` é:

```json
{"state":"changes_requested","current_version":1,"change_request_status":"expired"}
```

Antes da renovação, `/versions` continua recusando reenvio tardio com `409 DEADLINE_EXPIRED`. `/approval` continua recusando a decisão enquanto há um pedido pendente com `409 INVALID_STATE`. A marca renova na rota existente, com a versão que o GET informou:

```http
POST /scripts/ID/change-requests
Content-Type: application/json

{"brand_id":"b","expected_version":1,"reason":"Novo motivo","deadline":"2026-03-14"}
```

Neste exemplo com relógio controlado, o prazo do novo pedido ainda não terminou. A resposta é `200`, `state: changes_requested`, `current_version: 1` e `change_request_status: active`. Uma segunda tentativa enquanto esse pedido está ativo recebe `409 INVALID_STATE`. Um prazo que já terminou recebe `422 DEADLINE_EXPIRED`; marca diferente recebe `403 WRONG_ACTOR`; versão obsoleta recebe `409 STALE_VERSION`. Na operação real, substitua o prazo por um dia ainda válido em São Paulo.

O campo `versions[0].change_request` passa a mostrar o pedido mais recente. O evento anterior permanece integralmente em `history`: `reason`, `deadline`, `expires_at`, `actor_id`, `actor_role`, `at`, `version` e `sequence` não mudam. A renovação acrescenta outro evento `changes_requested` para a mesma versão, sem apagar ou reordenar o histórico. O reenvio posterior cria a versão 2, preserva o conteúdo da versão 1 e permite a aprovação terminal habitual. Nenhuma escrita reabre um roteiro aprovado.

O GET não provoca uma transição nem acrescenta evento de expiração. O snapshot existente continua compatível: `change_request_status` não é persistido, e depois de reiniciar o servidor a projeção usa o relógio atual. Erros de validação e de persistência conservam o pedido, o histórico e os bytes do arquivo.

## Provas desta correção

Ambiente: macOS, Node.js 22.23.3, dados fictícios, relógio injetado e HTTP real em loopback. Nenhuma chamada externa, publicação ou deploy foi realizado pelo implementador da correção.

- [Regressão antes da mudança](evidence/renewal-2026-10-09/before-regression.txt): falha determinística `INVALID_STATE` na tentativa de renovar.
- [Suíte antes da mudança](evidence/renewal-2026-10-09/before-test.txt): os 23 testes anteriores passam, a nova regressão falha.
- [A mesma regressão após a mudança](evidence/renewal-2026-10-09/fixed-regression.txt): passa.
- [Suíte após a mudança](evidence/renewal-2026-10-09/test.txt): 33 testes passam, sem falhas.
- [Regressões com `TZ=UTC`](evidence/renewal-2026-10-09/test-utc.txt): os 10 testes novos passam também com outro fuso do processo.
- [Sintaxe, diff e links locais](evidence/renewal-2026-10-09/checks.txt): verificações sem erros.
- [Regressões de renovação](../test/renewal.test.js): fronteiras normal e históricas de horário de verão, ator/versão, novo prazo passado, campos inválidos, reenvio e aprovação, histórico, reinício, falha de gravação e duas renovações HTTP concorrentes.

```sh
npm test
node --test test/renewal.test.js
```

Os 23 testes anteriores continuam presentes; uma comparação foi ajustada para o campo derivado `expired`, mantendo a verificação de que o pedido e o restante do agregado não mudam após uma rejeição tardia. Evidências, recibos e pareceres anteriores foram preservados. Codex fez a implementação, os testes e esta documentação após o achado de Claude Opus 5.5. As novas revisões independentes, o checkout isolado e a captura HTTP do coordenador sobre o SHA desta correção ainda estão pendentes; não se alega revisão humana nem aprovação nova.
