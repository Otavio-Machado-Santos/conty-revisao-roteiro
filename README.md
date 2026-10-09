# Revisão de roteiro

API pequena para enviar um roteiro, pedir alterações com motivo e prazo, reenviar e aprovar. Leia primeiro [o contrato](docs/enunciado.txt), depois [as transições](src/review.js) e [os testes](test/review.test.js).

```sh
# Node.js 22 (.nvmrc); não há dependências para instalar
npm test
npm start
# Em outro terminal, execute o fluxo completo pela API real:
npm run demo
```

O servidor usa `http://127.0.0.1:3003`. `PORT` muda a porta e `DATA_FILE` muda o arquivo, cujo padrão é `data/scripts.json`. A demonstração usa dados fictícios, o prazo de hoje em São Paulo, verifica a rejeição depois da aprovação e grava requests/responses completos em [http-flow.json](docs/evidence/http-flow.json). Os resultados dos testes estão em [test.txt](docs/evidence/test.txt).

## Fluxo e contrato HTTP

O estado começa em `awaiting_review`, passa a `changes_requested` e volta a `awaiting_review` com uma nova versão. `approved` encerra a revisão. Só a versão atual pode receber uma decisão; `expected_version` evita agir sobre uma versão que já mudou.

| Método e rota | Corpo JSON | Resultado |
| --- | --- | --- |
| `POST /scripts` | `creator_id`, `brand_id`, `content` | `201`, versão 1 aguardando revisão |
| `GET /scripts/:id` | — | `200`, todas as versões e todo o histórico |
| `POST /scripts/:id/change-requests` | `brand_id`, `expected_version`, `reason`, `deadline` | `200`, alteração solicitada |
| `POST /scripts/:id/versions` | `creator_id`, `expected_version`, `content` | `201`, nova versão aguardando revisão |
| `POST /scripts/:id/approval` | `brand_id`, `expected_version` | `200`, revisão aprovada |
| `GET /health` | — | `200`, status do processo |

Todas as escritas exigem `Content-Type: application/json`. IDs são textos não vazios de até 100 caracteres; conteúdo aceita até 20.000, motivo até 2.000. O corpo tem limite de 64 KiB. Campos desconhecidos são rejeitados. Os IDs recebidos precisam corresponder ao roteiro, mas **isso não é autenticação**: nesta demonstração os participantes são informados pelo cliente.

Exemplos (substitua `ID` pelo `id` devolvido ao criar e o prazo pelo dia desejado):

```sh
curl -sS http://127.0.0.1:3003/scripts \
  -H 'Content-Type: application/json' \
  -d '{"creator_id":"criador-demo","brand_id":"marca-demo","content":"Apresentação do produto sem explicar o benefício."}'

curl -sS http://127.0.0.1:3003/scripts/ID/change-requests \
  -H 'Content-Type: application/json' \
  -d '{"brand_id":"marca-demo","expected_version":1,"reason":"Explique o benefício antes da chamada de compra.","deadline":"2026-10-09"}'

curl -sS http://127.0.0.1:3003/scripts/ID/versions \
  -H 'Content-Type: application/json' \
  -d '{"creator_id":"criador-demo","expected_version":1,"content":"O produto reduz o trabalho manual. Veja como usar e onde comprar."}'

curl -sS http://127.0.0.1:3003/scripts/ID/approval \
  -H 'Content-Type: application/json' \
  -d '{"brand_id":"marca-demo","expected_version":2}'
```

Todas as respostas de sucesso contêm o agregado, incluindo `state`, `current_version`, `versions` e `history`. O pedido fica na versão à qual pertence, com `reason`, `deadline`, `valid_until`, `expires_at` e autor/data; o reenvio conserva essa versão e registra `superseded_by`. Exemplos completos e reais: [captura do fluxo HTTP](docs/evidence/http-flow.json).

Uma tentativa de reenviar depois da aprovação responde `409`:

```json
{"error":{"code":"REVIEW_CLOSED","message":"A revisão foi aprovada e não pode ser reaberta."}}
```

Motivo/prazo ausente ou data inexistente responde `422 INVALID_INPUT`; prazo já passado para um novo pedido, `422 DEADLINE_EXPIRED`; reenvio tardio, `409 DEADLINE_EXPIRED`; versão antiga, `409 STALE_VERSION`; transição incompatível, `409 INVALID_STATE`. Erros não alteram o roteiro. Identificador inexistente responde `404`, ator incompatível `403`, JSON inválido `400`, tipo de conteúdo incorreto `415` e corpo grande `413`.

## Prazo e escolhas

`deadline` é um dia `YYYY-MM-DD` em `America/Sao_Paulo`, incluindo seu último milissegundo. Por exemplo, `2026-03-13` vale até `2026-03-14T02:59:59.999Z`; `2026-03-14T03:00:00.000Z` já passou. [O cálculo](src/deadline.js) consulta o calendário IANA via `Intl`, inclusive em transições históricas de horário de verão, em vez de fixar UTC−03. O relógio é injetado nos testes; o servidor usa o relógio real.

Escolhas explícitas: uma nova versão exige um pedido de alteração, e um pedido já aberto não é sobrescrito. O prazo limita o reenvio do criador, não o instante da decisão da marca sobre uma versão já recebida. Aprovação duplicada é rejeitada. O conteúdo original e todos os pedidos ficam no histórico; não existe rota de exclusão ou reabertura.

O domínio não depende de HTTP. O processo grava snapshots JSON por arquivo temporário e `rename`, antes de atualizar o estado em memória. A leitura retorna cópias. Reinício conserva o estado; armazenamento inválido falha sem apagar dados. Essa persistência atende **um processo local**: não oferece lock entre processos, durabilidade transacional perante falha de energia nem escala de banco de dados. Com mais tempo, usaria banco com transações e controle de concorrência, autenticação que determine os atores, idempotência de comandos, paginação do histórico e observabilidade. Upload, vídeo, UI e integrações externas ficaram de fora por não serem necessários ao contrato.

## Uso de IA e revisão

Codex produziu código, testes e documentação. Dois agentes Codex independentes do implementador revisaram o commit `f7212f0ded7caa36370518e6cdcaa8780556f380` e liberaram a entrega após testes e sondagens próprias. Os pareceres completos estão em `docs/reviews/`. O coordenador conferiu a instalação e os testes em checkout isolado e registrou o fluxo HTTP real. Não foi realizada revisão humana do código. A validação usa dados sintéticos e ambiente local; limites e interpretações do contrato estão documentados.

[Verificação final, revisões independentes e captura do fluxo real](docs/verificacao-final.md).
