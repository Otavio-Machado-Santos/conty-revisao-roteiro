# Verificação final da entrega 3

Código revisado: `db12564279a7ab18d3c7e99759f24c69a6a78227`. Runtime: Node.js 22.23.3 em macOS.

Implementação e documentação: Codex. Revisão: dois agentes Codex independentes do implementador. Não houve revisão humana do código.

- 33 testes passaram no código final; [checkout isolado](evidence/coordenador-clone-limpo.txt).
- [Parecer A](reviews/03-a.json) e [parecer B](reviews/03-b.json), com sondagens independentes, limites e sugestões.
- [Transcrição HTTP real](evidence/coordenador-http.json): 21 etapas verificadas, com requests, respostas e invariantes.
- [Screenshot](evidence/screen.jpg), [resposta expandida](evidence/response.jpg) e [GIF da execução real](evidence/flow.gif).

O GIF foi codificado dos frames de screencast do navegador durante a execução das chamadas locais; não é uma montagem ou simulação. Os dados são fictícios. O portal apenas apresenta respostas da API e compara invariantes. Os limites de persistência, autenticação e operação estão no README. Os testes e capturas não representam deploy ou funcionamento em produção.

![Respostas reais da API](evidence/screen.jpg)

![Gravação do fluxo HTTP](evidence/flow.gif)

## Ajuste após a primeira revisão do Opus

O Opus pediu uma saída para um pedido de alteração vencido. A mesma marca agora pode renovar somente um pedido expirado da versão atual, mantendo o histórico. A resposta informa `change_request_status` como `active`, `expired` ou `null`, sem gravação durante a consulta. Pedido ainda ativo e aprovação encerrada continuam protegidos. Duas novas revisões Codex, 33 testes no checkout isolado e 21 etapas HTTP reais confirmaram a correção. A captura usa um relógio controlado, declarado na transcrição, e os handlers reais da API.

A nota original registrada na Conty contém o caminho `src/review-service.js`; a entrada correta é [src/review.js](../src/review.js), também vinculada no README. O recibo original foi preservado. A reavaliação pelo Opus será registrada separadamente após a publicação deste ajuste.
