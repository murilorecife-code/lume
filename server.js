// ARQUIVO DE TESTE — sem express, sem pg, sem bcryptjs, sem nada.
// Só pra provar se o serviço no Render consegue rodar QUALQUER programa Node.
console.log('TESTE MINIMO: comecei a rodar em ' + new Date().toISOString());

const http = require('http');
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.end('Teste minimo funcionando! Hora: ' + new Date().toISOString());
});

server.listen(PORT, () => {
  console.log('TESTE MINIMO: rodando na porta ' + PORT);
});
